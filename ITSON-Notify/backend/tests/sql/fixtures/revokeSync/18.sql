-- ITN-43c. PROPUESTA: revisar y aplicar manualmente; nunca se ejecuta al arrancar. Requiere 016 y 017.
-- El runner debe envolver el archivo completo en una transacción (sin begin/commit aquí).
-- Activar y desactivar las tareas de Classroom de un alumno, cada una en UNA operación atómica.
-- El backend solo usa estas funciones: sin ellas responde migracion_pendiente (503) y no escribe.
--
-- Candados: ambas toman app_users FOR UPDATE y después google_authorizations FOR UPDATE, el mismo
-- orden que sync_classroom (016/017: app_users FOR UPDATE y luego el grant FOR SHARE). Una sync
-- en curso termina antes; una sync que llega después espera al commit y nunca ve un estado
-- intermedio (p. ej. baseline limpia sin scope, o scope ampliado con la baseline vieja).
-- Negocio: sin la autorización exigida lanzan classroom_authorization_required (42501) sin tocar
-- nada. Validaciones de entrada: 22023. Escrituras siempre restringidas a p_user_id.
set local lock_timeout = '5s';

-- Activar: une el scope de tareas al grant guardado y, si las tareas no estaban activas, deja
-- coursework_baseline_at en null en los cursos del alumno (la primera sync con tareas es baseline
-- silencioso). p_granted_scope son los scopes de Classroom que informó Google, con el nombre que
-- devolvió (el backend descarta openid/email/profile); p_refresh_token, el refresh token
-- nuevo YA CIFRADO por el backend (null conserva el anterior). Exige el grant (user_id, google_id)
-- con status 'active' y el scope de cursos; needs_relink no activa.
-- Permiso de tareas: classroom.coursework.me.readonly O classroom.student-submissions.me.readonly.
-- El segundo es un alias EMPÍRICO: Google lo ha devuelto al pedir el primero. No se traduce un
-- nombre al otro; se guarda el que devolvió Google y la prueba real es courseWork.list (un 403
-- ahí deja el sync en solo cursos).
create or replace function public.activate_classroom_tasks(
  p_user_id uuid, p_google_id text, p_granted_scope text, p_refresh_token text default null)
returns jsonb
language plpgsql security invoker set search_path = pg_catalog, public as $$
declare
  courses_scope constant text := 'https://www.googleapis.com/auth/classroom.courses.readonly';
  work_scopes constant text[] := array['https://www.googleapis.com/auth/classroom.coursework.me.readonly',
    'https://www.googleapis.com/auth/classroom.student-submissions.me.readonly'];
  granted text[] := string_to_array(coalesce(p_granted_scope, ''), ' ');
  stored text[];
  stored_status text;
  was_active boolean;
  reset_courses integer := 0;
begin
  -- Entrada (antes de cualquier candado): Google debe haber concedido las tareas, y un refresh
  -- token nuevo sustituye al anterior, así que debe seguir cubriendo los cursos.
  if not (granted && work_scopes) then
    raise exception 'classroom_tasks_scope_not_granted' using errcode = '22023';
  end if;
  if p_refresh_token is not null and (p_refresh_token = '' or not (courses_scope = any(granted))) then
    raise exception 'classroom_courses_scope_not_granted' using errcode = '22023';
  end if;

  perform 1 from public.app_users where id = p_user_id for update;
  if not found then raise exception 'classroom_authorization_required' using errcode = '42501'; end if;
  select string_to_array(scope, ' '), status into stored, stored_status
    from public.google_authorizations
    where user_id = p_user_id and google_id = p_google_id
    for update;
  if not found or stored_status is distinct from 'active' or not (courses_scope = any(stored)) then
    raise exception 'classroom_authorization_required' using errcode = '42501';
  end if;

  was_active := coalesce(stored && work_scopes, false);
  if not was_active then
    update public.classroom_courses set coursework_baseline_at = null
      where user_id = p_user_id and coursework_baseline_at is not null;
    get diagnostics reset_courses = row_count;
  end if;

  -- guardado ∪ concedido, sin duplicados y en orden de primera aparición. Lo concedido ya trae el
  -- permiso de tareas (validado arriba) con el nombre que devolvió Google.
  update public.google_authorizations
    set scope = (select string_agg(s, ' ' order by first_n) from (
          select s, min(n) as first_n
          from unnest(stored || granted) with ordinality as t(s, n)
          where s <> '' group by s) u),
        refresh_token = coalesce(p_refresh_token, refresh_token),
        updated_at = now()
    where user_id = p_user_id and google_id = p_google_id;

  return jsonb_build_object('activated', not was_active, 'courses', reset_courses);
end;
$$;
revoke all on function public.activate_classroom_tasks(uuid, text, text, text) from public, anon, authenticated;
grant execute on function public.activate_classroom_tasks(uuid, text, text, text) to service_role;

-- Desactivar: 1) quita el permiso de tareas del scope guardado con AMBOS nombres
-- (classroom.coursework.me.readonly y el alias classroom.student-submissions.me.readonly; conserva el de
-- cursos), 2) borra sus classroom_task_events y classroom_coursework, 3) deja
-- coursework_baseline_at en null en sus cursos (reactivación = baseline silencioso).
-- Exige la fila google_authorizations (user_id, google_id) con CUALQUIER status (needs_relink
-- también desactiva: el alumno puede borrar sus datos aunque su token esté roto).
create or replace function public.disable_classroom_tasks(p_user_id uuid, p_google_id text)
returns jsonb
language plpgsql security invoker set search_path = pg_catalog, public as $$
declare
  work_scopes constant text[] := array['https://www.googleapis.com/auth/classroom.coursework.me.readonly',
    'https://www.googleapis.com/auth/classroom.student-submissions.me.readonly'];
  removed_events integer;
  removed_work integer;
  reset_courses integer;
begin
  perform 1 from public.app_users where id = p_user_id for update;
  if not found then raise exception 'classroom_authorization_required' using errcode = '42501'; end if;
  perform 1 from public.google_authorizations
    where user_id = p_user_id and google_id = p_google_id
    for update;
  if not found then raise exception 'classroom_authorization_required' using errcode = '42501'; end if;

  -- Conserva el orden del resto de scopes; solo quita el de tareas (ambos nombres).
  update public.google_authorizations
    set scope = array_to_string(array(
          select s from unnest(string_to_array(scope, ' ')) with ordinality as t(s, n)
          where s <> '' and not (s = any(work_scopes)) order by n), ' '),
        updated_at = now()
    where user_id = p_user_id and google_id = p_google_id
      and string_to_array(scope, ' ') && work_scopes;

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
