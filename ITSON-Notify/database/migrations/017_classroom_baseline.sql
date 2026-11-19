-- ITN-43b. Review/apply manually; never executed at startup. Requires 016.
-- The migration runner must wrap this entire file in one transaction (no begin/commit here).
-- Courses-only sync: a course without the 'coursework' key is stored without touching its tasks.
-- coursework_baseline_at marks the first snapshot that included tasks for a course; only tasks
-- that appear after that baseline create classroom_task_events.
set local lock_timeout = '5s';

-- Nullable: existing rows stay null, so their next task snapshot is a silent baseline.
alter table public.classroom_courses add column if not exists coursework_baseline_at timestamptz;

create or replace function public.sync_classroom(p_user_id uuid, p_google_id text, p_courses jsonb)
returns jsonb
language plpgsql security invoker set search_path = pg_catalog, public as $$
declare
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
  perform 1 from public.google_authorizations
    where user_id = p_user_id and google_id = p_google_id and status = 'active'
    for share;
  if not found then raise exception 'classroom_authorization_required' using errcode = '42501'; end if;
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
    -- (b) No 'coursework' array: courses-only snapshot. Tasks, events and baseline untouched.
    if jsonb_typeof(c->'coursework') is distinct from 'array' then
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
