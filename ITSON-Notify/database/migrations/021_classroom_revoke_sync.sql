-- ITN-43-REVOKE-SYNC-021. Requires 017; compatible with 018 and ledger 019.
-- Review/apply manually in ONE external transaction; never run at startup.
-- Lock order (019): app_users -> google_authorizations -> task events -> deliveries.
-- Scope decisions use the same locked grant as identity/status validation. A snapshot
-- fetched before disable must become courses-only after disable commits. No ledger
-- locks are taken here; 018/019 retain their cancellation and audit semantics.
set local lock_timeout = '5s';

create or replace function public.sync_classroom(p_user_id uuid, p_google_id text, p_courses jsonb)
returns jsonb
language plpgsql security invoker set search_path = pg_catalog, public as $$
declare
  courses_scope constant text := 'https://www.googleapis.com/auth/classroom.courses.readonly';
  work_scopes constant text[] := array[
    'https://www.googleapis.com/auth/classroom.coursework.me.readonly',
    'https://www.googleapis.com/auth/classroom.student-submissions.me.readonly'];
  stored_scopes text[];
  tasks_allowed boolean;
  c jsonb;
  w jsonb;
  course_uuid uuid;
  work_uuid uuid;
  baseline_at timestamptz;
  seen_at timestamptz;
  course_count integer := 0;
  work_count integer := 0;
  event_count integer := 0;
  inserted_count integer;
begin
  -- Serialize writers even for the very first (empty) snapshot.
  perform 1 from public.app_users where id = p_user_id for update;
  if not found then raise exception 'classroom_authorization_required' using errcode = '42501'; end if;
  -- Recheck identity/status after Google read; lock against disconnect/relink.
  select string_to_array(scope, ' ') into stored_scopes from public.google_authorizations
    where user_id = p_user_id and google_id = p_google_id and status = 'active'
    for share;
  if not found then raise exception 'classroom_authorization_required' using errcode = '42501'; end if;
  if not coalesce(courses_scope = any(stored_scopes), false) then
    raise exception 'classroom_authorization_required' using errcode = '42501';
  end if;
  tasks_allowed := coalesce(stored_scopes && work_scopes, false);
  if jsonb_typeof(p_courses) is distinct from 'array' then
    raise exception 'invalid_classroom_snapshot' using errcode = '22023';
  end if;
  seen_at := clock_timestamp();
  for c in select value from jsonb_array_elements(p_courses) loop
    course_count := course_count + 1;
    course_uuid := null;
    baseline_at := null;
    -- (a) The course is always inserted or updated.
    insert into public.classroom_courses(user_id, external_course_id, name, section, course_state, alternate_link, last_seen_at, updated_at)
      values(p_user_id, c->>'id', c->>'name', c->>'section', c->>'course_state', c->>'alternate_link', seen_at, seen_at)
      on conflict (user_id, external_course_id) do nothing returning id into course_uuid;
    if course_uuid is null then
      -- Read the baseline as it was BEFORE this sync (the update below never changes it).
      update public.classroom_courses set name = c->>'name', section = c->>'section',
        course_state = c->>'course_state', alternate_link = c->>'alternate_link',
        last_seen_at = seen_at, updated_at = seen_at
        where user_id = p_user_id and external_course_id = c->>'id'
        returning id, coursework_baseline_at into course_uuid, baseline_at;
    end if;
    -- (b) No task scope or no array: tasks, events and baseline stay untouched.
    if not tasks_allowed or jsonb_typeof(c->'coursework') is distinct from 'array' then
      continue;
    end if;
    -- (c) Task snapshot. Events only when the course already had a baseline before this sync.
    for w in select value from jsonb_array_elements(c->'coursework') loop
      work_count := work_count + 1;
      work_uuid := null;
      -- user_id is derived from the locked owner, never from input metadata.
      insert into public.classroom_coursework(user_id, course_id, external_coursework_id, title,
        work_type, state, due_at, alternate_link, source_created_at, source_updated_at, last_seen_at, updated_at)
      values(p_user_id, course_uuid, w->>'id', w->>'title', w->>'work_type', w->>'state',
        (w->>'due_at')::timestamptz, w->>'alternate_link', (w->>'source_created_at')::timestamptz,
        (w->>'source_updated_at')::timestamptz, seen_at, seen_at)
      on conflict (course_id, external_coursework_id) do nothing returning id into work_uuid;
      if work_uuid is not null then
        if baseline_at is not null and w->>'state' = 'PUBLISHED' then
          insert into public.classroom_task_events(user_id, coursework_id) values(p_user_id, work_uuid)
            on conflict (coursework_id) do nothing;
          get diagnostics inserted_count = row_count;
          event_count := event_count + inserted_count;
        end if;
      else
        update public.classroom_coursework set title = w->>'title', work_type = w->>'work_type',
          state = w->>'state', due_at = (w->>'due_at')::timestamptz, alternate_link = w->>'alternate_link',
          source_created_at = (w->>'source_created_at')::timestamptz,
          source_updated_at = (w->>'source_updated_at')::timestamptz, last_seen_at = seen_at, updated_at = seen_at
          where user_id = p_user_id and course_id = course_uuid and external_coursework_id = w->>'id';
      end if;
    end loop;
    -- First task snapshot for this course (even an empty one) becomes the baseline.
    if baseline_at is null then
      update public.classroom_courses set coursework_baseline_at = seen_at
        where id = course_uuid and coursework_baseline_at is null;
    end if;
  end loop;
  -- (d) Same result shape as 016.
  return jsonb_build_object('courses', course_count, 'coursework', work_count, 'newTasks', event_count);
end;
$$;
revoke all on function public.sync_classroom(uuid, text, jsonb) from public, anon, authenticated;
grant execute on function public.sync_classroom(uuid, text, jsonb) to service_role;
