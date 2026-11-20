-- ITN-43c. PROPUESTA: revisar y aplicar manualmente; nunca se ejecuta al arrancar. Requiere 016 y 017.
-- El runner debe envolver el archivo completo en una transacción (sin begin/commit aquí).
-- Desactivar las tareas de Classroom de un alumno en UNA operación atómica:
--   1) quita classroom.coursework.me.readonly del scope guardado (conserva el de cursos),
--   2) borra sus classroom_task_events y classroom_coursework,
--   3) deja coursework_baseline_at en null en sus cursos (reactivación = baseline silencioso).
-- Autorización: exige la fila google_authorizations (user_id, google_id) con cualquier status
-- (needs_relink también desactiva); si no existe lanza classroom_authorization_required (42501)
-- sin tocar nada. Los borrados siguen restringidos a p_user_id.
-- Toma el mismo candado que sync_classroom (app_users FOR UPDATE): espera a una sync en curso
-- y bloquea las nuevas hasta terminar. El backend usa esta función si existe; sin ella hace
-- los mismos pasos con varias llamadas en orden seguro (services/classroomTasksAuthorization.js).
set local lock_timeout = '5s';

create or replace function public.disable_classroom_tasks(p_user_id uuid, p_google_id text)
returns jsonb
language plpgsql security invoker set search_path = pg_catalog, public as $$
declare
  work_scope constant text := 'https://www.googleapis.com/auth/classroom.coursework.me.readonly';
  removed_events integer;
  removed_work integer;
  reset_courses integer;
begin
  perform 1 from public.app_users where id = p_user_id for update;
  if not found then raise exception 'classroom_authorization_required' using errcode = '42501'; end if;
  -- Debe existir la autorización de ESE alumno con ESE google_id, sea cual sea su status:
  -- un alumno en needs_relink (token roto) también puede borrar sus datos. Sin ella no se
  -- toca nada. Mismo orden de candados que sync_classroom (app_users y luego el grant).
  perform 1 from public.google_authorizations
    where user_id = p_user_id and google_id = p_google_id
    for update;
  if not found then raise exception 'classroom_authorization_required' using errcode = '42501'; end if;

  -- Conserva el orden del resto de scopes; solo quita el de tareas.
  update public.google_authorizations
    set scope = array_to_string(array(
          select s from unnest(string_to_array(scope, ' ')) with ordinality as t(s, n)
          where s <> '' and s <> work_scope order by n), ' '),
        updated_at = now()
    where user_id = p_user_id and google_id = p_google_id
      and work_scope = any(string_to_array(scope, ' '));

  delete from public.classroom_task_events where user_id = p_user_id;
  get diagnostics removed_events = row_count;
  delete from public.classroom_coursework where user_id = p_user_id;
  get diagnostics removed_work = row_count;
  update public.classroom_courses set coursework_baseline_at = null
    where user_id = p_user_id and coursework_baseline_at is not null;
  get diagnostics reset_courses = row_count;

  return jsonb_build_object('events', removed_events, 'coursework', removed_work, 'courses', reset_courses);
end;
$$;
revoke all on function public.disable_classroom_tasks(uuid, text) from public, anon, authenticated;
grant execute on function public.disable_classroom_tasks(uuid, text) to service_role;
