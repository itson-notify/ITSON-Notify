-- ITN-43c (018) punto 6: regla de autorización de disable_classroom_tasks.
-- Requiere classroomTasksDisable.sql. Exige la fila google_authorizations (user_id, google_id)
-- con CUALQUIER status; sin ella lanza classroom_authorization_required (42501) y no toca nada.
-- Evalúa los cuatro casos y falla al final, para que el reporte los muestre todos.
create temporary table check6(label text, outcome text, expected text, state_ok boolean);
grant insert, update on check6 to service_role;
create function pg_temp.cleaned(u uuid) returns boolean language sql as $$
  select (s->>'events')::int = 0 and (s->>'coursework')::int = 0 and (s->>'baselines')::int = 0
    and (s->>'courses')::int > 0
    and not exists (select 1 from public.google_authorizations g where g.user_id = u
      and 'https://www.googleapis.com/auth/classroom.coursework.me.readonly' = any(string_to_array(g.scope, ' ')))
  from (select public.test_user_state(u) s) x; $$;

-- (a) google_id distinto (el grant es g1, la llamada usa g-other): 42501 y nada cambia.
select test_seed_tasks('00000000-0000-4000-8000-000000000001', 'g1');
create temporary table u1_a as select test_user_state('00000000-0000-4000-8000-000000000001') s;
set role service_role;
insert into check6(label, outcome, expected) select 'a: different google_id',
  test_try_disable('00000000-0000-4000-8000-000000000001', 'g-other'), 'rejected:classroom_authorization_required';
reset role;
update check6 set state_ok = (select test_user_state('00000000-0000-4000-8000-000000000001') = s from u1_a) where state_ok is null;

-- (b) sin autorización (se quita la fila del grant): 42501 y nada cambia.
create temporary table grant_u1 as select * from google_authorizations where user_id = '00000000-0000-4000-8000-000000000001';
delete from google_authorizations where user_id = '00000000-0000-4000-8000-000000000001';
create temporary table u1_b as select test_user_state('00000000-0000-4000-8000-000000000001') s;
set role service_role;
insert into check6(label, outcome, expected) select 'b: no authorization row',
  test_try_disable('00000000-0000-4000-8000-000000000001', 'g1'), 'rejected:classroom_authorization_required';
reset role;
update check6 set state_ok = (select test_user_state('00000000-0000-4000-8000-000000000001') = s from u1_b) where state_ok is null;
insert into google_authorizations select * from grant_u1;

-- (c) needs_relink SÍ limpia scope, tareas, eventos y baseline (status no cambia).
select test_seed_tasks('00000000-0000-4000-8000-000000000001', 'g1');
update google_authorizations set status = 'needs_relink' where user_id = '00000000-0000-4000-8000-000000000001';
set role service_role;
insert into check6(label, outcome, expected) select 'c: needs_relink authorization',
  test_try_disable('00000000-0000-4000-8000-000000000001', 'g1'), 'returned';
reset role;
update check6 set state_ok = pg_temp.cleaned('00000000-0000-4000-8000-000000000001')
  and (select status = 'needs_relink' and scope = 'openid https://www.googleapis.com/auth/classroom.courses.readonly email'
       from google_authorizations where user_id = '00000000-0000-4000-8000-000000000001')
  where state_ok is null;

-- (d) autorización activa limpia como antes.
select test_seed_tasks('00000000-0000-4000-8000-000000000001', 'g1');
set role service_role;
insert into check6(label, outcome, expected) select 'd: active authorization',
  test_try_disable('00000000-0000-4000-8000-000000000001', 'g1'), 'returned';
reset role;
update check6 set state_ok = pg_temp.cleaned('00000000-0000-4000-8000-000000000001') where state_ok is null;

-- El otro alumno nunca se toca en ninguno de los cuatro casos.
select test_assert((select (s->>'events')::int > 0 and (s->>'coursework')::int > 0 and (s->>'baselines')::int > 0
  from (select test_user_state('00000000-0000-4000-8000-000000000002') s) x), 'other student untouched by check 6');

select 'CHECK6 | ' || label || ' | ' || outcome || ' | '
  || case when outcome = expected and state_ok then 'PASS' else 'FAIL (expected ' || expected || ')' end
  from check6 order by label;
select test_assert((select bool_and(outcome = expected and state_ok) and count(*) = 4 from check6), 'check 6 authorization rule');
select 'DISABLE_CHECK_6_OK';
