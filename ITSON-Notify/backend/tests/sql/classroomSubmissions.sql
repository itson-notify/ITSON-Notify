-- ITN-58f. Solo para un clúster local desechable; usuarios y metadatos sintéticos.
-- Corre después de 006/008/014/016/017/018/019/021/022 (ver verify-classroom-submissions-sql.cjs).
create function public.test_assert(ok boolean, label text) returns void language plpgsql as $$
begin if ok is distinct from true then raise exception 'FAILED: %', label; end if; end; $$;
-- Ejecuta p_sql y exige que falle con SQLSTATE p_code (y, si se da, ese mensaje exacto).
create function public.test_raises(p_sql text, p_code text, p_message text, label text) returns void
language plpgsql as $$
begin
  begin
    execute p_sql;
  exception when others then
    if sqlstate <> p_code or (p_message is not null and sqlerrm <> p_message) then
      raise exception 'FAILED: % (got % %)', label, sqlstate, sqlerrm;
    end if;
    return;
  end;
  raise exception 'FAILED: % (no error)', label;
end; $$;
grant execute on function public.test_assert(boolean, text) to service_role;
grant execute on function public.test_raises(text, text, text, text) to service_role;

insert into app_users(id) values
  ('00000000-0000-4000-8000-000000000001'), ('00000000-0000-4000-8000-000000000002');
insert into google_authorizations(user_id,google_id,email,scope,refresh_token) values
  ('00000000-0000-4000-8000-000000000001','g1','synthetic1@example.test',
   'https://www.googleapis.com/auth/classroom.courses.readonly https://www.googleapis.com/auth/classroom.student-submissions.me.readonly','not-a-token'),
  ('00000000-0000-4000-8000-000000000002','g2','synthetic2@example.test',
   'https://www.googleapis.com/auth/classroom.courses.readonly https://www.googleapis.com/auth/classroom.coursework.me.readonly','not-a-token');

set role service_role;
-- Cursos y tareas vía la sync real (021); el segundo sync genera un evento para comparar después.
select sync_classroom('00000000-0000-4000-8000-000000000001','g1',
  '[{"id":"c1","name":"Synthetic","coursework":[{"id":"w1","title":"T1","state":"PUBLISHED"},{"id":"w2","title":"T2","state":"PUBLISHED"}]}]');
select sync_classroom('00000000-0000-4000-8000-000000000001','g1',
  '[{"id":"c1","name":"Synthetic","coursework":[{"id":"w1","title":"T1","state":"PUBLISHED"},{"id":"w2","title":"T2","state":"PUBLISHED"},{"id":"w3","title":"T3","state":"PUBLISHED"}]}]');
select sync_classroom('00000000-0000-4000-8000-000000000002','g2',
  '[{"id":"c1","name":"Synthetic","coursework":[{"id":"w1","title":"Other","state":"PUBLISHED"}]}]');
select test_assert((select count(*) = 1 from classroom_task_events), 'setup: one task event');

create temporary table events_before as select to_jsonb(e) row from classroom_task_events e;
create temporary table courses_before as select to_jsonb(c) row from classroom_courses c;
create temporary table work_before as select to_jsonb(w) row from classroom_coursework w;

-- Upsert solo de tareas conocidas del alumno; las desconocidas (otra tarea, otro curso) se ignoran.
select test_assert(sync_classroom_submissions('00000000-0000-4000-8000-000000000001','g1',
  '[{"courseId":"c1","courseWorkId":"w1","state":"TURNED_IN","late":true,"assignedGrade":null,"updateTime":"2026-11-20T10:00:00Z"},
    {"courseId":"c1","courseWorkId":"w2","state":"NEW"},
    {"courseId":"c1","courseWorkId":"nope","state":"TURNED_IN"},
    {"courseId":"other-course","courseWorkId":"w1","state":"TURNED_IN"}]')
  = '{"items":4,"stored":2,"unknown":2,"tasksAllowed":true}'::jsonb, 'upsert known, ignore unknown');
select test_assert((select s.state = 'TURNED_IN' and s.late and s.assigned_grade is null
    and s.source_updated_at = '2026-11-20T10:00:00Z'::timestamptz
    and s.user_id = '00000000-0000-4000-8000-000000000001'
  from classroom_submissions s join classroom_coursework w on w.id = s.coursework_id
  where w.user_id = '00000000-0000-4000-8000-000000000001' and w.external_coursework_id = 'w1'), 'w1 stored');
select test_assert((select s.state = 'NEW' and s.late is null from classroom_submissions s
  join classroom_coursework w on w.id = s.coursework_id
  where w.user_id = '00000000-0000-4000-8000-000000000001' and w.external_coursework_id = 'w2'), 'w2 stored');
select test_assert((select count(*) = 2 from classroom_submissions), 'only two rows');

-- Idempotencia: el mismo lote no reescribe nada (updated_at se conserva).
create temporary table subs_before as select to_jsonb(s) row from classroom_submissions s;
select test_assert(sync_classroom_submissions('00000000-0000-4000-8000-000000000001','g1',
  '[{"courseId":"c1","courseWorkId":"w1","state":"TURNED_IN","late":true,"assignedGrade":null,"updateTime":"2026-11-20T10:00:00Z"},
    {"courseId":"c1","courseWorkId":"w2","state":"NEW"}]')
  = '{"items":2,"stored":0,"unknown":0,"tasksAllowed":true}'::jsonb, 'idempotent replay');
select test_assert(not exists((select to_jsonb(s) from classroom_submissions s) except select row from subs_before)
  and not exists(select row from subs_before except (select to_jsonb(s) from classroom_submissions s)), 'rows unchanged on replay');

-- Cambio real de estado (incluye nota y repetición dentro del lote).
select test_assert(sync_classroom_submissions('00000000-0000-4000-8000-000000000001','g1',
  '[{"courseId":"c1","courseWorkId":"w2","state":"TURNED_IN","late":false},
    {"courseId":"c1","courseWorkId":"w2","state":"RETURNED","late":false,"assignedGrade":9.5}]')
  = '{"items":2,"stored":2,"unknown":0,"tasksAllowed":true}'::jsonb, 'state change');
select test_assert((select s.state = 'RETURNED' and s.assigned_grade = 9.5 and not s.late from classroom_submissions s
  join classroom_coursework w on w.id = s.coursework_id
  where w.user_id = '00000000-0000-4000-8000-000000000001' and w.external_coursework_id = 'w2'), 'last value wins');

-- Otro alumno: su propia entrega, sin cruzar con la tarea homónima de u1.
select test_assert(sync_classroom_submissions('00000000-0000-4000-8000-000000000002','g2',
  '[{"courseId":"c1","courseWorkId":"w1","state":"RECLAIMED_BY_STUDENT"}]')
  = '{"items":1,"stored":1,"unknown":0,"tasksAllowed":true}'::jsonb, 'second student');
select test_assert((select count(*) = 1 from classroom_submissions where user_id = '00000000-0000-4000-8000-000000000002'
  and state = 'RECLAIMED_BY_STUDENT'), 'second student isolated');
select test_assert((select s.state = 'TURNED_IN' from classroom_submissions s join classroom_coursework w on w.id = s.coursework_id
  where w.user_id = '00000000-0000-4000-8000-000000000001' and w.external_coursework_id = 'w1'), 'first student untouched');

-- Nunca toca eventos, cursos, baselines ni tareas.
select test_assert(not exists((select to_jsonb(e) from classroom_task_events e) except select row from events_before)
  and not exists(select row from events_before except (select to_jsonb(e) from classroom_task_events e)), 'events untouched');
select test_assert(not exists((select to_jsonb(c) from classroom_courses c) except select row from courses_before)
  and not exists(select row from courses_before except (select to_jsonb(c) from classroom_courses c)), 'courses/baselines untouched');
select test_assert(not exists((select to_jsonb(w) from classroom_coursework w) except select row from work_before)
  and not exists(select row from work_before except (select to_jsonb(w) from classroom_coursework w)), 'coursework untouched');

-- Validación: cualquier entrada mal formada rechaza el lote entero sin escribir.
drop table subs_before;
create temporary table subs_before as select to_jsonb(s) row from classroom_submissions s;
select test_raises($q$select sync_classroom_submissions('00000000-0000-4000-8000-000000000001','g1','{}')$q$,
  '22023', 'invalid_classroom_submissions', 'not an array');
select test_raises(format($q$select sync_classroom_submissions('00000000-0000-4000-8000-000000000001','g1',%L)$q$,
  (select jsonb_agg(jsonb_build_object('courseId','c1','courseWorkId','w1','state','NEW')) from generate_series(1,1001))),
  '22023', 'invalid_classroom_submissions', 'too many items');
select test_raises($q$select sync_classroom_submissions('00000000-0000-4000-8000-000000000001','g1',
  '[{"courseId":"c1","courseWorkId":"w1","state":"NEW"},{"courseId":"c1","courseWorkId":"w2","state":"turned_in"}]')$q$,
  '22023', 'invalid_classroom_submissions', 'lowercase state');
select test_raises($q$select sync_classroom_submissions('00000000-0000-4000-8000-000000000001','g1',
  '[{"courseId":"c1","courseWorkId":"w1","state":"NEW","late":"yes"}]')$q$,
  '22023', 'invalid_classroom_submissions', 'late not boolean');
select test_raises($q$select sync_classroom_submissions('00000000-0000-4000-8000-000000000001','g1',
  '[{"courseId":"c1","courseWorkId":"w1","state":"NEW","assignedGrade":"10"}]')$q$,
  '22023', 'invalid_classroom_submissions', 'grade not number');
select test_raises($q$select sync_classroom_submissions('00000000-0000-4000-8000-000000000001','g1',
  '[{"courseId":"c1","courseWorkId":"w1","state":"NEW","assignedGrade":1e12}]')$q$,
  '22023', 'invalid_classroom_submissions', 'grade too large');
select test_raises($q$select sync_classroom_submissions('00000000-0000-4000-8000-000000000001','g1',
  '[{"courseId":"c1","courseWorkId":"w1","state":"NEW","updateTime":"not-a-date"}]')$q$,
  '22023', 'invalid_classroom_submissions', 'bad timestamp');
select test_raises($q$select sync_classroom_submissions('00000000-0000-4000-8000-000000000001','g1',
  '[{"courseId":"c1/..","courseWorkId":"w1","state":"NEW"}]')$q$,
  '22023', 'invalid_classroom_submissions', 'bad id');
select test_raises($q$select sync_classroom_submissions('00000000-0000-4000-8000-000000000001','g1','[42]')$q$,
  '22023', 'invalid_classroom_submissions', 'item not object');
select test_assert(not exists((select to_jsonb(s) from classroom_submissions s) except select row from subs_before)
  and not exists(select row from subs_before except (select to_jsonb(s) from classroom_submissions s)), 'rejected batches wrote nothing');

-- Autorización: identidad, status y scope de cursos, igual que 021.
select test_raises($q$select sync_classroom_submissions('00000000-0000-4000-8000-000000000001','g2','[]')$q$,
  '42501', 'classroom_authorization_required', 'cross identity');
select test_raises($q$select sync_classroom_submissions('00000000-0000-4000-8000-000000000099','g1','[]')$q$,
  '42501', 'classroom_authorization_required', 'missing user');
reset role;
update google_authorizations set status = 'needs_relink' where google_id = 'g1';
set role service_role;
select test_raises($q$select sync_classroom_submissions('00000000-0000-4000-8000-000000000001','g1','[]')$q$,
  '42501', 'classroom_authorization_required', 'needs_relink');
reset role;
update google_authorizations set status = 'active',
  scope = 'https://www.googleapis.com/auth/classroom.student-submissions.me.readonly' where google_id = 'g1';
set role service_role;
select test_raises($q$select sync_classroom_submissions('00000000-0000-4000-8000-000000000001','g1','[]')$q$,
  '42501', 'classroom_authorization_required', 'courses scope missing');

-- Permiso de tareas ausente (solo cursos): no-op con resumen vacío, aunque el lote traiga cambios.
reset role;
update google_authorizations set scope = 'https://www.googleapis.com/auth/classroom.courses.readonly' where google_id = 'g1';
set role service_role;
select test_assert(sync_classroom_submissions('00000000-0000-4000-8000-000000000001','g1',
  '[{"courseId":"c1","courseWorkId":"w1","state":"NEW"}]')
  = '{"items":0,"stored":0,"unknown":0,"tasksAllowed":false}'::jsonb, 'no task scope = no-op');
-- Prefijos parecidos no cuentan como permiso de tareas.
reset role;
update google_authorizations set scope = 'https://www.googleapis.com/auth/classroom.courses.readonly https://www.googleapis.com/auth/classroom.coursework.me.readonly.evil'
  where google_id = 'g1';
set role service_role;
select test_assert((sync_classroom_submissions('00000000-0000-4000-8000-000000000001','g1',
  '[{"courseId":"c1","courseWorkId":"w1","state":"NEW"}]')->>'tasksAllowed')::boolean = false, 'lookalike scope = no-op');
select test_assert(not exists((select to_jsonb(s) from classroom_submissions s) except select row from subs_before)
  and not exists(select row from subs_before except (select to_jsonb(s) from classroom_submissions s)), 'no-op wrote nothing');

-- Revocación vía 018: disable_classroom_tasks borra las entregas por cascada (solo las del alumno).
reset role;
update google_authorizations set scope = 'https://www.googleapis.com/auth/classroom.courses.readonly https://www.googleapis.com/auth/classroom.coursework.me.readonly'
  where google_id = 'g1';
set role service_role;
select disable_classroom_tasks('00000000-0000-4000-8000-000000000001','g1');
select test_assert(not exists(select 1 from classroom_submissions where user_id = '00000000-0000-4000-8000-000000000001'),
  'revocation cascades to submissions');
select test_assert((select count(*) = 1 from classroom_submissions where user_id = '00000000-0000-4000-8000-000000000002'),
  'other student keeps submissions');
-- Un lote leído antes de revocar que llega después no resucita nada.
select test_assert(sync_classroom_submissions('00000000-0000-4000-8000-000000000001','g1',
  '[{"courseId":"c1","courseWorkId":"w1","state":"TURNED_IN"}]')
  = '{"items":0,"stored":0,"unknown":0,"tasksAllowed":false}'::jsonb, 'stale batch after revocation');
select test_assert(not exists(select 1 from classroom_submissions where user_id = '00000000-0000-4000-8000-000000000001'),
  'no resurrection');
reset role;

-- Seguridad: security invoker, search_path fijo, ACL de la función y de la tabla, RLS sin políticas.
select test_assert((select not prosecdef and proconfig = array['search_path=pg_catalog, public']
  from pg_proc where oid = 'sync_classroom_submissions(uuid,text,jsonb)'::regprocedure), 'security invoker and search_path');
select test_assert(has_function_privilege('service_role','sync_classroom_submissions(uuid,text,jsonb)','EXECUTE')
  and not has_function_privilege('anon','sync_classroom_submissions(uuid,text,jsonb)','EXECUTE')
  and not has_function_privilege('authenticated','sync_classroom_submissions(uuid,text,jsonb)','EXECUTE'), 'RPC ACL');
select test_assert((select relrowsecurity from pg_class where oid = 'public.classroom_submissions'::regclass), 'RLS enabled');
select test_assert(not exists(select 1 from pg_policies where schemaname = 'public' and tablename = 'classroom_submissions'), 'no policies');
select test_assert(not has_table_privilege('anon','public.classroom_submissions','SELECT,INSERT,UPDATE,DELETE')
  and not has_table_privilege('authenticated','public.classroom_submissions','SELECT,INSERT,UPDATE,DELETE')
  and has_table_privilege('service_role','public.classroom_submissions','SELECT,INSERT,UPDATE,DELETE'), 'table ACL');
set role authenticated;
select test_raises($q$select sync_classroom_submissions('00000000-0000-4000-8000-000000000002','g2','[]')$q$,
  '42501', null, 'authenticated cannot execute');
reset role;
