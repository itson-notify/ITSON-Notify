-- ITN-43c (018): activate_classroom_tasks. Solo para un clúster desechable; datos sintéticos.
-- Requiere classroomSync.sql y classroomTasksDisable.sql (test_assert, test_snapshot,
-- test_seed_tasks, test_user_state, alumnos 1 y 2).
create function public.test_courses_scope() returns text language sql as $$
  select 'openid https://www.googleapis.com/auth/classroom.courses.readonly email'; $$;
create function public.test_granted() returns text language sql as $$
  select 'openid https://www.googleapis.com/auth/classroom.coursework.me.readonly https://www.googleapis.com/auth/classroom.courses.readonly'; $$;
-- Deja al alumno con tareas sembradas y baseline, pero el scope solo de cursos (tareas inactivas).
create function public.test_seed_inactive(u uuid, g text) returns void language plpgsql as $$
begin
  perform public.test_seed_tasks(u, g);
  update public.google_authorizations set scope = public.test_courses_scope(), refresh_token = 'sealed-old' where user_id = u;
end; $$;
create function public.test_try_activate(u uuid, g text, granted text, refresh text default null) returns text
language plpgsql as $$
begin
  return 'returned:' || public.activate_classroom_tasks(u, g, granted, refresh)::text;
exception when insufficient_privilege or invalid_parameter_value then return 'rejected:' || sqlstate || ':' || sqlerrm;
end; $$;
create temporary table activate_checks(label text, ok boolean);
grant insert on activate_checks to service_role;

-- (i) Activación feliz: une scopes en orden sin duplicados, guarda el refresh token sellado,
-- limpia la baseline solo de ese alumno y la siguiente sync con tareas es baseline silencioso.
select test_seed_inactive('00000000-0000-4000-8000-000000000001', 'g1');
select test_seed_tasks('00000000-0000-4000-8000-000000000002', 'g2');
create temporary table a_u2 as select test_user_state('00000000-0000-4000-8000-000000000002') s;
set role service_role;
insert into activate_checks select 'i: happy path result',
  test_try_activate('00000000-0000-4000-8000-000000000001', 'g1', test_granted(), 'sealed-new')
  = 'returned:{"courses": 1, "activated": true}';
reset role;
insert into activate_checks select 'i: scope union ordered', scope = 'openid https://www.googleapis.com/auth/classroom.courses.readonly email https://www.googleapis.com/auth/classroom.coursework.me.readonly'
  from google_authorizations where user_id = '00000000-0000-4000-8000-000000000001';
insert into activate_checks select 'i: refresh token replaced, status active', refresh_token = 'sealed-new' and status = 'active'
  from google_authorizations where user_id = '00000000-0000-4000-8000-000000000001';
insert into activate_checks select 'i: baselines null, tasks kept',
  (s->>'baselines')::int = 0 and (s->>'coursework')::int > 0 from (select test_user_state('00000000-0000-4000-8000-000000000001') s) x;
insert into activate_checks select 'i: other student untouched', test_user_state('00000000-0000-4000-8000-000000000002') = s from a_u2;
set role service_role;
insert into activate_checks select 'i: next sync is silent baseline',
  (test_snapshot('00000000-0000-4000-8000-000000000001', 'g1', array['d-w1', 'after-activate-' || gen_random_uuid()], 'd1')->>'newTasks')::int = 0;
reset role;
-- Repetir con tareas ya activas: no vuelve a limpiar la baseline y sin refresh token conserva el anterior.
create temporary table a_u1 as select test_user_state('00000000-0000-4000-8000-000000000001') s;
set role service_role;
insert into activate_checks select 'i: already active result',
  test_try_activate('00000000-0000-4000-8000-000000000001', 'g1', 'openid https://www.googleapis.com/auth/classroom.coursework.me.readonly')
  = 'returned:{"courses": 0, "activated": false}';
reset role;
insert into activate_checks select 'i: already active keeps baselines/scope/token',
  (x.s->'baselineValues') = (b.s->'baselineValues') and (x.s->'scope') = (b.s->'scope')
  and (select refresh_token = 'sealed-new' from google_authorizations where user_id = '00000000-0000-4000-8000-000000000001')
  from (select test_user_state('00000000-0000-4000-8000-000000000001') s) x, a_u1 b;

-- (ii) Sin autorización usable → 42501 classroom_authorization_required y nada cambia.
select test_seed_inactive('00000000-0000-4000-8000-000000000001', 'g1');
create temporary table a_ii as select test_user_state('00000000-0000-4000-8000-000000000001') s;
set role service_role;
insert into activate_checks select 'ii: different google_id', test_try_activate('00000000-0000-4000-8000-000000000001', 'g-other', test_granted())
  = 'rejected:42501:classroom_authorization_required';
insert into activate_checks select 'ii: missing user', test_try_activate('00000000-0000-4000-8000-000000000099', 'g1', test_granted())
  = 'rejected:42501:classroom_authorization_required';
reset role;
update google_authorizations set status = 'needs_relink' where user_id = '00000000-0000-4000-8000-000000000001';
set role service_role;
insert into activate_checks select 'ii: needs_relink', test_try_activate('00000000-0000-4000-8000-000000000001', 'g1', test_granted(), 'sealed-new')
  = 'rejected:42501:classroom_authorization_required';
reset role;
update google_authorizations set status = 'active', scope = 'openid email' where user_id = '00000000-0000-4000-8000-000000000001';
set role service_role;
insert into activate_checks select 'ii: stored grant without courses scope', test_try_activate('00000000-0000-4000-8000-000000000001', 'g1', test_granted())
  = 'rejected:42501:classroom_authorization_required';
reset role;
update google_authorizations set scope = test_courses_scope() where user_id = '00000000-0000-4000-8000-000000000001';
create temporary table grant_a as select * from google_authorizations where user_id = '00000000-0000-4000-8000-000000000001';
delete from google_authorizations where user_id = '00000000-0000-4000-8000-000000000001';
set role service_role;
insert into activate_checks select 'ii: no authorization row', test_try_activate('00000000-0000-4000-8000-000000000001', 'g1', test_granted())
  = 'rejected:42501:classroom_authorization_required';
reset role;
insert into google_authorizations select * from grant_a;
-- Entrada inválida (22023), también sin cambios.
set role service_role;
insert into activate_checks select 'ii: granted without tasks scope',
  test_try_activate('00000000-0000-4000-8000-000000000001', 'g1', 'openid https://www.googleapis.com/auth/classroom.courses.readonly')
  = 'rejected:22023:classroom_tasks_scope_not_granted';
insert into activate_checks select 'ii: new refresh token without courses scope',
  test_try_activate('00000000-0000-4000-8000-000000000001', 'g1', 'openid https://www.googleapis.com/auth/classroom.coursework.me.readonly', 'sealed-new')
  = 'rejected:22023:classroom_courses_scope_not_granted';
reset role;
insert into activate_checks select 'ii: rejected calls changed nothing',
  (x.s - 'authUpdatedAt') = (b.s - 'authUpdatedAt')
  and (select refresh_token = 'sealed-old' and status = 'active' from google_authorizations where user_id = '00000000-0000-4000-8000-000000000001')
  from (select test_user_state('00000000-0000-4000-8000-000000000001') s) x, a_ii b;

-- (iii) Fallo a mitad: un trigger revienta en el UPDATE del grant, DESPUÉS de limpiar la
-- baseline. Todo vuelve atrás: baseline, scope y refresh token intactos.
create function public.test_fail_grant_update() returns trigger language plpgsql as $$
begin
  if current_setting('test.fail_grant', true) = 'on' then raise exception 'forced_mid_activation_failure'; end if;
  return new;
end; $$;
create trigger test_fail_grant before update on public.google_authorizations
  for each row execute function public.test_fail_grant_update();
create temporary table a_iii as select test_user_state('00000000-0000-4000-8000-000000000001') s;
insert into activate_checks select 'iii: precondition baseline set', (s->>'baselines')::int > 0 from a_iii;
set test.fail_grant = 'on';
set role service_role;
do $$ begin
  begin
    perform public.activate_classroom_tasks('00000000-0000-4000-8000-000000000001', 'g1', public.test_granted(), 'sealed-new');
    raise exception 'forced failure did not happen';
  exception when raise_exception then
    if sqlerrm <> 'forced_mid_activation_failure' then raise; end if;
  end;
end; $$;
reset role;
reset test.fail_grant;
insert into activate_checks select 'iii: rollback leaves no partial state',
  x.s = b.s and (select refresh_token = 'sealed-old' from google_authorizations where user_id = '00000000-0000-4000-8000-000000000001')
  from (select test_user_state('00000000-0000-4000-8000-000000000001') s) x, a_iii b;
drop trigger test_fail_grant on public.google_authorizations;

-- (v) Permisos: solo service_role ejecuta; security invoker y search_path fijo.
insert into activate_checks select 'v: security invoker', not prosecdef from pg_proc
  where oid = 'public.activate_classroom_tasks(uuid,text,text,text)'::regprocedure;
insert into activate_checks select 'v: fixed search_path', proconfig = array['search_path=pg_catalog, public'] from pg_proc
  where oid = 'public.activate_classroom_tasks(uuid,text,text,text)'::regprocedure;
insert into activate_checks select 'v: execute only owner + service_role (no PUBLIC)',
  array_agg(distinct a.grantee::regrole::text order by a.grantee::regrole::text) = array['classroom_test', 'service_role']
  from pg_proc p, aclexplode(p.proacl) a
  where p.oid = 'public.activate_classroom_tasks(uuid,text,text,text)'::regprocedure and a.privilege_type = 'EXECUTE';
insert into activate_checks select 'v: service_role can execute', has_function_privilege('service_role', 'public.activate_classroom_tasks(uuid,text,text,text)', 'EXECUTE');
insert into activate_checks select 'v: anon cannot execute', not has_function_privilege('anon', 'public.activate_classroom_tasks(uuid,text,text,text)', 'EXECUTE');
insert into activate_checks select 'v: authenticated cannot execute', not has_function_privilege('authenticated', 'public.activate_classroom_tasks(uuid,text,text,text)', 'EXECUTE');
do $$ declare r text; begin
  foreach r in array array['anon', 'authenticated'] loop
    execute format('set local role %I', r);
    begin
      perform public.activate_classroom_tasks('00000000-0000-4000-8000-000000000001', 'g1', public.test_granted());
      raise exception 'role % executed activate_classroom_tasks', r;
    exception when insufficient_privilege then
      if sqlerrm not like 'permission denied for function%' then raise; end if;
    end;
    reset role;
  end loop;
end; $$;
insert into activate_checks select 'v: anon/authenticated calls denied, nothing changed',
  x.s = b.s from (select test_user_state('00000000-0000-4000-8000-000000000001') s) x, a_iii b;
-- Invoker de verdad: sin UPDATE de service_role sobre classroom_courses, falla sin dejar nada a medias.
revoke update on public.classroom_courses from service_role;
set role service_role;
insert into activate_checks select 'v: invoker uses caller privileges',
  test_try_activate('00000000-0000-4000-8000-000000000001', 'g1', test_granted()) like 'rejected:42501:permission denied%';
reset role;
grant update on public.classroom_courses to service_role;
insert into activate_checks select 'v: privilege failure rolled back',
  x.s = b.s from (select test_user_state('00000000-0000-4000-8000-000000000001') s) x, a_iii b;

select 'ACTIVATE | ' || label || ' | ' || case when ok then 'PASS' else 'FAIL' end from activate_checks;
select test_assert((select bool_and(ok) and count(*) = 27 from activate_checks), 'activate checks');
select 'ACTIVATE_CHECKS_OK';
