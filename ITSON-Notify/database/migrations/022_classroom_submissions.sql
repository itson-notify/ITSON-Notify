-- ITN-58f. PROPUESTA: revisar y aplicar manualmente en UNA transacción externa; nunca al arrancar.
-- Rollback (manual, en una transacción):
--   drop function if exists public.sync_classroom_submissions(uuid, text, jsonb);
--   drop table if exists public.classroom_submissions;
--
-- Requiere 006, 008, 014, 016, 017/021 y 018. Compatible con el ledger 019 y con 020.
-- Estado de entrega del alumno por tarea de Classroom (studentSubmissions.list, userId=me),
-- SOLO para mostrarlo. No modifica sync_classroom (017/021), disable_classroom_tasks (018), el
-- ledger/despacho (019), classroom_task_events ni coursework_baseline_at: cambiar el estado de
-- entrega nunca genera un evento ni un aviso.
-- Revocación: disable_classroom_tasks borra classroom_coursework y, por la llave foránea
-- (on delete cascade), estas filas. Una corrida que leyó Google antes de la revocación y llega
-- después ya no tiene permiso de tareas y no escribe nada.
-- Candados (mismo orden que 018/019/021): app_users FOR UPDATE -> google_authorizations FOR UPDATE.
-- No toma candados del ledger.
set local lock_timeout = '5s';

create table if not exists public.classroom_submissions (
  user_id uuid not null references public.app_users(id) on delete cascade,
  coursework_id uuid not null references public.classroom_coursework(id) on delete cascade,
  state text not null
    constraint classroom_submissions_state_check
    check (state ~ '^[A-Z_]{1,64}$'),
  late boolean,
  assigned_grade numeric,
  source_updated_at timestamptz,
  updated_at timestamptz not null default now(),
  primary key (coursework_id)
);

create index if not exists idx_classroom_submissions_user
  on public.classroom_submissions (user_id);

-- Igual que 019/020: RLS sin políticas; solo service_role (el backend) lee y escribe.
alter table public.classroom_submissions enable row level security;
revoke all on public.classroom_submissions from public, anon, authenticated, service_role;
grant select, insert, update, delete on public.classroom_submissions to service_role;

-- p_items: arreglo (máx. 1000) de { courseId, courseWorkId, state, late, assignedGrade, updateTime }
-- con los ids externos de Classroom. Solo se guardan las tareas que ya existen en
-- classroom_coursework de p_user_id; las desconocidas se cuentan y se ignoran. Una entrada mal
-- formada rechaza el lote completo (22023) sin escribir nada.
-- Sin la autorización de cursos activa: classroom_authorization_required (42501), igual que 021.
-- Sin permiso de tareas: no hace nada y devuelve el resumen vacío con tasksAllowed = false.
create or replace function public.sync_classroom_submissions(p_user_id uuid, p_google_id text, p_items jsonb)
returns jsonb
language plpgsql security invoker set search_path = pg_catalog, public as $$
declare
  courses_scope constant text := 'https://www.googleapis.com/auth/classroom.courses.readonly';
  work_scopes constant text[] := array[
    'https://www.googleapis.com/auth/classroom.coursework.me.readonly',
    'https://www.googleapis.com/auth/classroom.student-submissions.me.readonly'];
  max_items constant integer := 1000;
  stored_scopes text[];
  stored_status text;
  tasks_allowed boolean;
  it jsonb;
  work_uuid uuid;
  v_late boolean;
  v_grade numeric;
  v_updated timestamptz;
  item_count integer := 0;
  stored_count integer := 0;
  unknown_count integer := 0;
  changed integer;
begin
  -- Forma del lote antes de cualquier candado.
  if jsonb_typeof(p_items) is distinct from 'array' or jsonb_array_length(p_items) > max_items then
    raise exception 'invalid_classroom_submissions' using errcode = '22023';
  end if;

  perform 1 from public.app_users where id = p_user_id for update;
  if not found then raise exception 'classroom_authorization_required' using errcode = '42501'; end if;
  select string_to_array(scope, ' '), status into stored_scopes, stored_status
    from public.google_authorizations
    where user_id = p_user_id and google_id = p_google_id
    for update;
  if not found or stored_status is distinct from 'active'
      or not coalesce(courses_scope = any(stored_scopes), false) then
    raise exception 'classroom_authorization_required' using errcode = '42501';
  end if;
  tasks_allowed := coalesce(stored_scopes && work_scopes, false);
  if not tasks_allowed then
    return jsonb_build_object('items', 0, 'stored', 0, 'unknown', 0, 'tasksAllowed', false);
  end if;

  for it in select value from jsonb_array_elements(p_items) loop
    item_count := item_count + 1;
    if jsonb_typeof(it) is distinct from 'object'
        or jsonb_typeof(it->'courseId') is distinct from 'string'
        or jsonb_typeof(it->'courseWorkId') is distinct from 'string'
        or jsonb_typeof(it->'state') is distinct from 'string'
        or (it->>'courseId') !~ '^[A-Za-z0-9_-]{1,128}$'
        or (it->>'courseWorkId') !~ '^[A-Za-z0-9_-]{1,128}$'
        or (it->>'state') !~ '^[A-Z_]{1,64}$'
        or coalesce(jsonb_typeof(it->'late'), 'null') not in ('boolean', 'null')
        or coalesce(jsonb_typeof(it->'assignedGrade'), 'null') not in ('number', 'null')
        or coalesce(jsonb_typeof(it->'updateTime'), 'null') not in ('string', 'null')
        or char_length(coalesce(it->>'updateTime', '')) > 64 then
      raise exception 'invalid_classroom_submissions' using errcode = '22023';
    end if;
    v_late := (it->>'late')::boolean;
    v_grade := (it->>'assignedGrade')::numeric;
    if v_grade is not null and abs(v_grade) >= 1000000000 then
      raise exception 'invalid_classroom_submissions' using errcode = '22023';
    end if;
    begin
      v_updated := (it->>'updateTime')::timestamptz;
    exception when others then
      raise exception 'invalid_classroom_submissions' using errcode = '22023';
    end;

    -- Solo tareas ya conocidas de ESTE alumno (curso y tarea del mismo dueño).
    select w.id into work_uuid
      from public.classroom_coursework w
      join public.classroom_courses c on c.id = w.course_id
      where w.user_id = p_user_id and c.user_id = p_user_id
        and c.external_course_id = it->>'courseId'
        and w.external_coursework_id = it->>'courseWorkId';
    if not found then
      unknown_count := unknown_count + 1;
      continue;
    end if;

    -- Idempotente: si nada cambió no se reescribe la fila (updated_at se conserva).
    insert into public.classroom_submissions(user_id, coursework_id, state, late, assigned_grade,
      source_updated_at, updated_at)
    values (p_user_id, work_uuid, it->>'state', v_late, v_grade, v_updated, clock_timestamp())
    on conflict (coursework_id) do update
      set state = excluded.state, late = excluded.late, assigned_grade = excluded.assigned_grade,
          source_updated_at = excluded.source_updated_at, updated_at = excluded.updated_at
      where classroom_submissions.user_id = p_user_id
        and (classroom_submissions.state, classroom_submissions.late, classroom_submissions.assigned_grade,
             classroom_submissions.source_updated_at)
          is distinct from (excluded.state, excluded.late, excluded.assigned_grade, excluded.source_updated_at);
    get diagnostics changed = row_count;
    stored_count := stored_count + changed;
  end loop;

  return jsonb_build_object('items', item_count, 'stored', stored_count, 'unknown', unknown_count,
    'tasksAllowed', true);
end;
$$;
revoke all on function public.sync_classroom_submissions(uuid, text, jsonb) from public, anon, authenticated;
grant execute on function public.sync_classroom_submissions(uuid, text, jsonb) to service_role;
