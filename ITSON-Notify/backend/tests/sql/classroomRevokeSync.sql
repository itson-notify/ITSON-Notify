-- Synthetic data only; run after classroomSync.sql in the isolated 021 harness.
create function public.test_denied(u uuid, g text) returns void language plpgsql as $$
begin
  begin
    perform sync_classroom(u,g,'[]'::jsonb);
    raise exception 'FAILED: authorization accepted';
  exception when insufficient_privilege then
    if sqlerrm <> 'classroom_authorization_required' then raise; end if;
  end;
end; $$;

set role service_role;
-- A courses-only grant must ignore even malformed/stale task bodies on existing courses.
update google_authorizations set scope='https://www.googleapis.com/auth/classroom.courses.readonly'
  where google_id='g1';
create temporary table task_before as select to_jsonb(w) row from classroom_coursework w;
create temporary table event_before as select to_jsonb(e) row from classroom_task_events e;
create temporary table baselines_before as select id, coursework_baseline_at from classroom_courses;
select test_assert(sync_classroom('00000000-0000-4000-8000-000000000001','g1',
  '[{"id":"c1","name":"Courses updated","coursework":[{"id":"w1","title":"Do not update","due_at":"INVALID"},
  {"id":"stale-task","title":"Do not insert"}]},{"id":"scope-only","name":"Synthetic","coursework":[]}]')
  = '{"courses":2,"coursework":0,"newTasks":0}'::jsonb, 'courses-only exact output contract');
select test_assert(not exists((select to_jsonb(w) from classroom_coursework w) except select row from task_before)
  and not exists(select row from task_before except (select to_jsonb(w) from classroom_coursework w)),
  'courses-only does not insert or update tasks');
select test_assert(not exists((select to_jsonb(e) from classroom_task_events e) except select row from event_before)
  and not exists(select row from event_before except (select to_jsonb(e) from classroom_task_events e)),
  'courses-only events untouched');
select test_assert(not exists(select 1 from classroom_courses c join baselines_before b using(id)
  where c.coursework_baseline_at is distinct from b.coursework_baseline_at), 'existing baselines untouched');
select test_assert((select coursework_baseline_at is null from classroom_courses where external_course_id='scope-only'),
  'no baseline from empty stale task array');
select test_assert((select name='Courses updated' from classroom_courses
  where user_id='00000000-0000-4000-8000-000000000001' and external_course_id='c1'), 'courses still updated');

-- Exact tokens: broader/other-owner scopes and prefix lookalikes grant nothing.
update google_authorizations set scope='https://www.googleapis.com/auth/classroom.courses.readonly https://www.googleapis.com/auth/classroom.coursework.me.readonly.evil https://www.googleapis.com/auth/classroom.coursework.students.readonly'
  where google_id='g1';
select test_assert(test_snapshot('00000000-0000-4000-8000-000000000001','g1',array['bad-scope'],'scope-only')
  = '{"courses":1,"coursework":0,"newTasks":0}'::jsonb, 'no substring or students scope authorization');

-- Either supported task scope permits silent baseline then exactly one new event.
do $$ declare s text; c text; baseline timestamptz;
begin
  foreach s in array array['classroom.coursework.me.readonly','classroom.student-submissions.me.readonly'] loop
    c := s;
    update google_authorizations set scope='https://www.googleapis.com/auth/classroom.courses.readonly https://www.googleapis.com/auth/'||s
      where google_id='g1';
    perform test_assert(test_snapshot('00000000-0000-4000-8000-000000000001','g1',array['a'],c)
      = '{"courses":1,"coursework":1,"newTasks":0}'::jsonb, 'scope silent baseline');
    select coursework_baseline_at into baseline from classroom_courses where external_course_id=c;
    perform test_assert(baseline is not null, 'baseline initialized');
    perform test_assert(test_snapshot('00000000-0000-4000-8000-000000000001','g1',array['a','b'],c)
      = '{"courses":1,"coursework":2,"newTasks":1}'::jsonb, 'scope incremental event');
    perform test_assert(test_snapshot('00000000-0000-4000-8000-000000000001','g1',array['a','b'],c)
      = '{"courses":1,"coursework":2,"newTasks":0}'::jsonb, 'scope idempotence');
    perform test_assert((select coursework_baseline_at=baseline from classroom_courses where external_course_id=c),
      'scope baseline unchanged');
  end loop;
end; $$;

update google_authorizations set scope='https://www.googleapis.com/auth/classroom.coursework.me.readonly' where google_id='g1';
select test_denied('00000000-0000-4000-8000-000000000001','g1');
update google_authorizations set scope='' where google_id='g1';
select test_denied('00000000-0000-4000-8000-000000000001','g1');
update google_authorizations set scope='https://www.googleapis.com/auth/classroom.courses.readonly', status='needs_relink' where google_id='g1';
select test_denied('00000000-0000-4000-8000-000000000001','g1');
update google_authorizations set status='active' where google_id='g1';
select test_denied('00000000-0000-4000-8000-000000000001','g2');
select test_denied('00000000-0000-4000-8000-000000000001','old-google-id');
select test_denied('00000000-0000-4000-8000-000000000099','missing');
reset role;
insert into app_users values('00000000-0000-4000-8000-000000000003');
set role service_role;
select test_denied('00000000-0000-4000-8000-000000000003','missing');
-- Caller-supplied owner metadata is ignored for both course and work.
update google_authorizations set scope='https://www.googleapis.com/auth/classroom.courses.readonly https://www.googleapis.com/auth/classroom.coursework.me.readonly' where google_id='g1';
select sync_classroom('00000000-0000-4000-8000-000000000001','g1',
  '[{"id":"owner-test","name":"Synthetic","user_id":"00000000-0000-4000-8000-000000000002",
  "coursework":[{"id":"owner-work","title":"Synthetic","user_id":"00000000-0000-4000-8000-000000000002","state":"PUBLISHED"}]}]');
select test_assert((select w.user_id=c.user_id and w.user_id='00000000-0000-4000-8000-000000000001'
  from classroom_coursework w join classroom_courses c on c.id=w.course_id where c.external_course_id='owner-test'),
  'locked owner overrides input metadata');
reset role;
select test_assert((select not prosecdef and proconfig=array['search_path=pg_catalog, public']
  from pg_proc where oid='sync_classroom(uuid,text,jsonb)'::regprocedure), 'security invoker and fixed search path');
select test_assert(has_function_privilege('service_role','sync_classroom(uuid,text,jsonb)','EXECUTE')
  and not has_function_privilege('anon','sync_classroom(uuid,text,jsonb)','EXECUTE')
  and not has_function_privilege('authenticated','sync_classroom(uuid,text,jsonb)','EXECUTE'), 'RPC ACL');
do $$ declare t text; r text;
begin
  foreach t in array array['classroom_courses','classroom_coursework','classroom_task_events','classroom_notification_deliveries','google_authorizations'] loop
    perform test_assert((select relrowsecurity from pg_class where oid=('public.'||t)::regclass), 'RLS '||t);
    perform test_assert(not exists(select 1 from pg_policies where schemaname='public' and tablename=t), 'no public policy '||t);
    foreach r in array array['anon','authenticated'] loop
      perform test_assert(not has_table_privilege(r,'public.'||t,'SELECT,INSERT,UPDATE,DELETE'), 'table ACL '||r||' '||t);
    end loop;
  end loop;
end; $$;
-- Exercise the actual ACL failure rather than just inspecting the catalog.
set role authenticated;
do $$ begin
  begin
    perform sync_classroom('00000000-0000-4000-8000-000000000001','g1','[]');
    raise exception 'FAILED: authenticated executed RPC';
  exception when insufficient_privilege then null; end;
end; $$;
reset role;
