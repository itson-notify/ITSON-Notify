-- ITN-43c (018): disable_classroom_tasks. Solo para un clúster desechable; datos sintéticos.
-- Requiere classroomSync.sql (test_assert, test_snapshot, alumnos 1 y 2).
create function public.test_scope(extra text default '') returns text language sql as $$
  select 'openid https://www.googleapis.com/auth/classroom.courses.readonly'
    || ' https://www.googleapis.com/auth/classroom.coursework.me.readonly email' || extra; $$;
-- Siembra: curso d1 con baseline y una tarea nueva (con su evento) en cada llamada.
create function public.test_seed_tasks(u uuid, g text) returns void language plpgsql as $$
begin
  update public.google_authorizations set status = 'active', scope = public.test_scope() where user_id = u;
  perform public.test_snapshot(u, g, array['d-w1'], 'd1');
  perform public.test_assert((public.test_snapshot(u, g, array['d-w1', 'd-new-' || gen_random_uuid()], 'd1')->>'newTasks')::int = 1,
    'seed creates one event');
end; $$;
create function public.test_user_state(u uuid) returns jsonb language sql as $$
  select jsonb_build_object(
    'events', (select count(*) from public.classroom_task_events where user_id = u),
    'coursework', (select count(*) from public.classroom_coursework where user_id = u),
    'courses', (select count(*) from public.classroom_courses where user_id = u),
    'baselines', (select count(*) from public.classroom_courses where user_id = u and coursework_baseline_at is not null),
    'baselineValues', (select jsonb_agg(coursework_baseline_at order by id) from public.classroom_courses where user_id = u),
    'scope', (select jsonb_agg(scope order by google_id) from public.google_authorizations where user_id = u),
    'authUpdatedAt', (select jsonb_agg(updated_at order by google_id) from public.google_authorizations where user_id = u)); $$;
-- Llama al RPC; una negativa (42501) también cuenta como "no hizo nada" si no borró filas.
create function public.test_try_disable(u uuid, g text) returns text language plpgsql as $$
begin
  perform public.disable_classroom_tasks(u, g);
  return 'returned';
exception when insufficient_privilege then return 'rejected:' || sqlerrm;
end; $$;

-- (2) Quita solo el scope de tareas, borra tareas/eventos del alumno y limpia su baseline.
select test_seed_tasks('00000000-0000-4000-8000-000000000001', 'g1');
select test_seed_tasks('00000000-0000-4000-8000-000000000002', 'g2');
update google_authorizations set scope = test_scope(' https://www.googleapis.com/auth/classroom.coursework.me.readonly')
  where user_id = '00000000-0000-4000-8000-000000000001';
create temporary table u1_before as select test_user_state('00000000-0000-4000-8000-000000000001') s;
create temporary table u2_before as select test_user_state('00000000-0000-4000-8000-000000000002') s;
select test_assert((select (s->>'events')::int > 0 and (s->>'coursework')::int > 0 and (s->>'baselines')::int > 0 from u1_before), 'precondition u1 has data');
select test_assert((select (s->>'events')::int > 0 and (s->>'coursework')::int > 0 and (s->>'baselines')::int > 0 from u2_before), 'precondition u2 has data');
set role service_role;
create temporary table disable_result as
  select disable_classroom_tasks('00000000-0000-4000-8000-000000000001', 'g1') r;
reset role;
select test_assert((select r = jsonb_build_object('events', (b.s->>'events')::int, 'coursework', (b.s->>'coursework')::int,
  'courses', (b.s->>'baselines')::int) from disable_result, u1_before b), 'disable result counts');
select test_assert((select scope = 'openid https://www.googleapis.com/auth/classroom.courses.readonly email'
  from google_authorizations where user_id = '00000000-0000-4000-8000-000000000001'), 'only tasks scope removed, order kept (duplicates too)');
select test_assert((select (x.s->>'events')::int = 0 and (x.s->>'coursework')::int = 0 and (x.s->>'baselines')::int = 0
  and x.s->'courses' = b.s->'courses' from (select test_user_state('00000000-0000-4000-8000-000000000001') s) x, u1_before b),
  'u1 tasks/events deleted, courses kept, baselines null');
-- (3) El otro alumno queda idéntico (filas, baselines, scope y updated_at).
select test_assert((select test_user_state('00000000-0000-4000-8000-000000000002') = s from u2_before), 'other student untouched');
-- Idempotente: repetir no falla, no cuenta nada y no reescribe el scope.
create temporary table u1_after as select test_user_state('00000000-0000-4000-8000-000000000001') s;
set role service_role;
select test_assert(disable_classroom_tasks('00000000-0000-4000-8000-000000000001', 'g1')
  = '{"events":0,"coursework":0,"courses":0}'::jsonb, 'disable is idempotent');
reset role;
select test_assert((select test_user_state('00000000-0000-4000-8000-000000000001') = s from u1_after), 'second disable changes nothing');
-- Reactivar: la siguiente sync con tareas es baseline silencioso.
set role service_role;
select test_assert((test_snapshot('00000000-0000-4000-8000-000000000001', 'g1', array['d-w1', 'd-w3'], 'd1')->>'newTasks')::int = 0,
  'reactivation is a silent baseline');
reset role;
-- Alumno inexistente: misma señal de negocio que sync_classroom.
set role service_role;
select test_assert(test_try_disable('00000000-0000-4000-8000-000000000099', 'absent') = 'rejected:classroom_authorization_required',
  'missing user rejected');
reset role;

-- (5) Solo service_role ejecuta; security invoker con search_path fijo.
select test_assert((select not prosecdef from pg_proc where oid = 'public.disable_classroom_tasks(uuid,text)'::regprocedure), 'security invoker');
select test_assert((select proconfig = array['search_path=pg_catalog, public'] from pg_proc
  where oid = 'public.disable_classroom_tasks(uuid,text)'::regprocedure), 'fixed search_path');
select test_assert((select array_agg(distinct a.grantee::regrole::text order by a.grantee::regrole::text)
  = array['classroom_test', 'service_role'] from pg_proc p, aclexplode(p.proacl) a
  where p.oid = 'public.disable_classroom_tasks(uuid,text)'::regprocedure and a.privilege_type = 'EXECUTE'),
  'execute only owner + service_role (no PUBLIC)');
select test_assert(has_function_privilege('service_role', 'public.disable_classroom_tasks(uuid,text)', 'EXECUTE'), 'service_role can execute');
select test_assert(not has_function_privilege('anon', 'public.disable_classroom_tasks(uuid,text)', 'EXECUTE'), 'anon cannot execute');
select test_assert(not has_function_privilege('authenticated', 'public.disable_classroom_tasks(uuid,text)', 'EXECUTE'), 'authenticated cannot execute');
do $$ declare r text; begin
  foreach r in array array['anon', 'authenticated'] loop
    execute format('set local role %I', r);
    begin
      perform public.disable_classroom_tasks('00000000-0000-4000-8000-000000000002', 'g2');
      raise exception 'role % executed disable_classroom_tasks', r;
    exception when insufficient_privilege then
      if sqlerrm not like 'permission denied for function%' then raise; end if;
    end;
    reset role;
  end loop;
end; $$;
-- Invoker de verdad: sin DELETE de service_role sobre las tareas, falla y no deja nada a medias.
select test_seed_tasks('00000000-0000-4000-8000-000000000001', 'g1');
create temporary table u1_invoker as select test_user_state('00000000-0000-4000-8000-000000000001') s;
revoke delete on public.classroom_coursework from service_role;
set role service_role;
do $$ begin
  begin
    perform public.disable_classroom_tasks('00000000-0000-4000-8000-000000000001', 'g1');
    raise exception 'disable ran without table privilege (not invoker)';
  exception when insufficient_privilege then
    if sqlerrm = 'classroom_authorization_required' then raise exception 'privilege failure used business marker'; end if;
  end;
end; $$;
reset role;
grant delete on public.classroom_coursework to service_role;
select test_assert((select test_user_state('00000000-0000-4000-8000-000000000001') = s from u1_invoker), 'failed disable rolled back (scope + events)');
select 'DISABLE_CHECKS_1_TO_5_OK';
