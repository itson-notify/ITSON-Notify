-- Only for a disposable local cluster; synthetic users and metadata.
create function public.test_assert(ok boolean, label text) returns void language plpgsql as $$
begin if ok is distinct from true then raise exception 'FAILED: %', label; end if; end; $$;
insert into app_users(id) values
  ('00000000-0000-4000-8000-000000000001'), ('00000000-0000-4000-8000-000000000002');
insert into google_authorizations(user_id,google_id,email,scope,refresh_token) values
  ('00000000-0000-4000-8000-000000000001','g1','synthetic1@example.test','synthetic','not-a-token'),
  ('00000000-0000-4000-8000-000000000002','g2','synthetic2@example.test','synthetic','not-a-token');

create function public.test_snapshot(u uuid, g text, ids text[], course text default 'c1') returns jsonb
language sql as $$ select public.sync_classroom(u, g, jsonb_build_array(jsonb_build_object(
  'id', course, 'name', 'Synthetic course', 'coursework', coalesce((select jsonb_agg(jsonb_build_object(
    'id', id, 'title', 'Synthetic task', 'state', 'PUBLISHED')) from unnest(ids) id), '[]'::jsonb)))); $$;

set role service_role;
select test_assert((test_snapshot('00000000-0000-4000-8000-000000000001','g1',array['w1','w2'])->>'newTasks')::int = 0, 'initial baseline');
select test_assert((select count(*) = 0 from classroom_task_events), 'no baseline events');
-- Backdate observation metadata to make immutability/advancement explicit.
update classroom_courses set first_seen_at = '2020-01-01Z', last_seen_at = '2020-01-01Z';
update classroom_coursework set first_seen_at = '2020-01-01Z', last_seen_at = '2020-01-01Z';
select test_assert((test_snapshot('00000000-0000-4000-8000-000000000001','g1',array['w1','w2','w3'])->>'newTasks')::int = 1, 'incremental task');
select test_assert((test_snapshot('00000000-0000-4000-8000-000000000001','g1',array['w1','w2','w3','w3'])->>'newTasks')::int = 0, 'duplicate run and tasks');
select test_assert((select count(*) = 3 from classroom_coursework), 'natural task key');
select test_assert((select count(*) = 1 from classroom_task_events), 'unique event');
select test_assert((select bool_and(first_seen_at = '2020-01-01Z'::timestamptz and last_seen_at > first_seen_at) from classroom_courses), 'course timestamps');
select test_assert((select bool_and(first_seen_at = '2020-01-01Z'::timestamptz and last_seen_at > first_seen_at) from classroom_coursework where external_coursework_id in ('w1','w2')), 'task timestamps');
select test_assert((test_snapshot('00000000-0000-4000-8000-000000000001','g1',array['existing'],'new-course')->>'newTasks')::int = 0, 'later course baseline');
select test_assert((test_snapshot('00000000-0000-4000-8000-000000000001','g1',array[]::text[],'empty-course')->>'newTasks')::int = 0, 'empty course baseline');
select test_assert((test_snapshot('00000000-0000-4000-8000-000000000001','g1',array['later'],'empty-course')->>'newTasks')::int = 1, 'task after empty baseline');
select test_assert((test_snapshot('00000000-0000-4000-8000-000000000002','g2',array['w1','w2','w3'])->>'newTasks')::int = 0, 'separate student baseline');
select test_assert((select count(*) = 2 from classroom_courses where external_course_id = 'c1'), 'natural course key per owner');
select test_assert((select count(*) = 0 from classroom_coursework w join classroom_courses c on c.id = w.course_id where w.user_id <> c.user_id), 'owner copied from course');
select test_assert((select count(*) = 0 from classroom_task_events where user_id = '00000000-0000-4000-8000-000000000002'), 'no cross student events');

do $$ begin
  begin
    perform test_snapshot('00000000-0000-4000-8000-000000000001','g2',array['attacker']);
    raise exception 'cross identity accepted';
  exception when insufficient_privilege then
    if sqlerrm <> 'classroom_authorization_required' then raise; end if;
  end;
end; $$;
update google_authorizations set status = 'needs_relink' where google_id = 'g1';
do $$ begin
  begin
    perform test_snapshot('00000000-0000-4000-8000-000000000001','g1',array['revoked']);
    raise exception 'revoked accepted';
  exception when insufficient_privilege then
    if sqlerrm <> 'classroom_authorization_required' then raise; end if;
  end;
end; $$;
update google_authorizations set status = 'active' where google_id = 'g1';

-- Fail after inserting a task + event in the first course: entire RPC rolls back.
do $$ begin
  begin
    perform sync_classroom('00000000-0000-4000-8000-000000000001','g1',
      '[{"id":"c1","name":"Changed","coursework":[{"id":"rollback-task","title":"Synthetic","state":"PUBLISHED"}]},
        {"id":"bad","coursework":[]}]'::jsonb);
    raise exception 'invalid snapshot accepted';
  exception when not_null_violation then null; end;
end; $$;
select test_assert((select count(*) = 0 from classroom_coursework where external_coursework_id in ('rollback-task','revoked','attacker')), 'failed snapshots rollback');
select test_assert((select count(*) = 0 from classroom_courses where name = 'Changed' or external_course_id = 'bad'), 'course rollback');
select test_assert((select count(*) = 2 from classroom_task_events), 'event rollback');
-- The other student can still sync after the first student fails.
select test_assert((test_snapshot('00000000-0000-4000-8000-000000000002','g2',array['w1','w2','w3','w4'])->>'newTasks')::int = 1, 'other student survives');
-- Missing tasks are retained without touching their last_seen_at.
create temporary table last_seen_before as select id, last_seen_at from classroom_coursework where external_coursework_id = 'w1';
select test_snapshot('00000000-0000-4000-8000-000000000001','g1',array[]::text[]);
select test_assert((select bool_and(w.last_seen_at = b.last_seen_at) from classroom_coursework w join last_seen_before b using(id)), 'missing rows retained');
reset role;
select test_assert(not has_function_privilege('anon','public.sync_classroom(uuid,text,jsonb)','EXECUTE'), 'anon cannot sync');
select test_assert(not has_function_privilege('authenticated','public.sync_classroom(uuid,text,jsonb)','EXECUTE'), 'authenticated cannot sync');
select test_assert(not has_table_privilege('authenticated','classroom_task_events','SELECT'), 'events private');
select test_assert((select relrowsecurity from pg_class where oid = 'public.classroom_task_events'::regclass), 'events RLS');

-- Missing user must emit exactly the same stable business signal.
set role service_role;
do $$ begin
  begin
    perform sync_classroom('00000000-0000-4000-8000-000000000099','absent','[]'::jsonb);
    raise exception 'missing user accepted';
  exception when insufficient_privilege then
    if sqlerrm <> 'classroom_authorization_required' then raise; end if;
  end;
end; $$;
reset role;

-- ITN-43b (017): courses-only snapshots and per-course task baseline.
create function public.test_courses_only(u uuid, g text, course text) returns jsonb
language sql as $$ select public.sync_classroom(u, g, jsonb_build_array(jsonb_build_object(
  'id', course, 'name', 'Synthetic course'))); $$;
set role service_role;
-- (i) Courses-only sync stores the course, no tasks, no events, baseline stays null.
create temporary table events_before as select count(*) as n from classroom_task_events;
select test_assert((select r->>'courses' = '1' and r->>'coursework' = '0' and r->>'newTasks' = '0'
  from (select test_courses_only('00000000-0000-4000-8000-000000000001','g1','only-courses') r) x), 'courses-only counts');
select test_assert((select count(*) = 1 and bool_and(coursework_baseline_at is null) from classroom_courses
  where external_course_id = 'only-courses'), 'courses-only stores course without baseline');
select test_assert((select count(*) = 0 from classroom_coursework w join classroom_courses c on c.id = w.course_id
  where c.external_course_id = 'only-courses'), 'courses-only creates no tasks');
select test_assert((select count(*) from classroom_task_events) = (select n from events_before), 'courses-only creates no events');
-- Courses-only sync on a course that already has tasks/baseline leaves both untouched.
create temporary table c1_before as select c.coursework_baseline_at, (select count(*) from classroom_coursework w where w.course_id = c.id) n
  from classroom_courses c where user_id = '00000000-0000-4000-8000-000000000001' and external_course_id = 'c1';
select test_courses_only('00000000-0000-4000-8000-000000000001','g1','c1');
select test_assert((select c.coursework_baseline_at is not distinct from b.coursework_baseline_at and b.coursework_baseline_at is not null
  and (select count(*) from classroom_coursework w where w.course_id = c.id) = b.n
  from classroom_courses c, c1_before b where c.user_id = '00000000-0000-4000-8000-000000000001' and c.external_course_id = 'c1'), 'courses-only keeps existing tasks and baseline');
-- (ii) First task snapshot of an existing course is a silent baseline.
select test_assert((test_snapshot('00000000-0000-4000-8000-000000000001','g1',array['b1','b2'],'only-courses')->>'newTasks')::int = 0, 'first tasks of existing course are baseline');
select test_assert((select count(*) from classroom_task_events) = (select n from events_before), 'baseline creates no events');
select test_assert((select bool_and(coursework_baseline_at is not null) from classroom_courses where external_course_id = 'only-courses'), 'baseline set');
-- (iii) A new task in the next sync creates one event.
select test_assert((test_snapshot('00000000-0000-4000-8000-000000000001','g1',array['b1','b2','b3'],'only-courses')->>'newTasks')::int = 1, 'task after baseline notifies');
select test_assert((select count(*) = 1 from classroom_task_events e join classroom_coursework w on w.id = e.coursework_id
  where w.external_coursework_id = 'b3'), 'event for new task');
-- (iv) Idempotence: repeating does not duplicate events nor move the baseline.
create temporary table baseline_before as select coursework_baseline_at from classroom_courses where external_course_id = 'only-courses';
select test_assert((test_snapshot('00000000-0000-4000-8000-000000000001','g1',array['b1','b2','b3'],'only-courses')->>'newTasks')::int = 0, 'repeat no new tasks');
select test_courses_only('00000000-0000-4000-8000-000000000001','g1','only-courses');
select test_assert((select count(*) from classroom_task_events) = (select n from events_before) + 1, 'no duplicated events');
select test_assert((select c.coursework_baseline_at = b.coursework_baseline_at from classroom_courses c, baseline_before b
  where c.external_course_id = 'only-courses'), 'baseline immutable');
-- A brand-new course whose first snapshot already has tasks is also a silent baseline.
select test_assert((test_snapshot('00000000-0000-4000-8000-000000000002','g2',array['n1'],'brand-new')->>'newTasks')::int = 0, 'new course with tasks is baseline');
reset role;
