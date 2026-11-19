-- ITN-43. Review/apply manually; never executed at startup.
-- Requires 006, 008, 014. One atomic snapshot per student, including event outbox.
begin;
set local lock_timeout = '5s';

create table if not exists public.classroom_task_events (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references public.app_users(id) on delete cascade,
  coursework_id uuid not null unique references public.classroom_coursework(id) on delete cascade,
  event_type text not null default 'classroom.task.created' check (event_type = 'classroom.task.created'),
  created_at timestamptz not null default now(),
  delivered_at timestamptz
);
create index if not exists idx_classroom_events_pending
  on public.classroom_task_events(user_id, created_at) where delivered_at is null;
alter table public.classroom_task_events enable row level security;
revoke all on public.classroom_task_events from public, anon, authenticated, service_role;
grant select, insert, update, delete on public.classroom_task_events to service_role;

create or replace function public.sync_classroom(p_user_id uuid, p_google_id text, p_courses jsonb)
returns jsonb
language plpgsql security invoker set search_path = pg_catalog, public as $$
declare
  c jsonb;
  w jsonb;
  course_uuid uuid;
  work_uuid uuid;
  new_course boolean;
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
    insert into public.classroom_courses(user_id, external_course_id, name, section, course_state, alternate_link, last_seen_at, updated_at)
      values(p_user_id, c->>'id', c->>'name', c->>'section', c->>'course_state', c->>'alternate_link', seen_at, seen_at)
      on conflict (user_id, external_course_id) do nothing returning id into course_uuid;
    new_course := course_uuid is not null;
    if not new_course then
      update public.classroom_courses set name = c->>'name', section = c->>'section',
        course_state = c->>'course_state', alternate_link = c->>'alternate_link',
        last_seen_at = seen_at, updated_at = seen_at
        where user_id = p_user_id and external_course_id = c->>'id'
        returning id into course_uuid;
    end if;
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
      if work_uuid is not null and not new_course and w->>'state' = 'PUBLISHED' then
        insert into public.classroom_task_events(user_id, coursework_id) values(p_user_id, work_uuid)
          on conflict (coursework_id) do nothing;
        get diagnostics inserted_count = row_count;
        event_count := event_count + inserted_count;
      elsif work_uuid is null then
        update public.classroom_coursework set title = w->>'title', work_type = w->>'work_type',
          state = w->>'state', due_at = (w->>'due_at')::timestamptz, alternate_link = w->>'alternate_link',
          source_created_at = (w->>'source_created_at')::timestamptz,
          source_updated_at = (w->>'source_updated_at')::timestamptz, last_seen_at = seen_at, updated_at = seen_at
          where user_id = p_user_id and course_id = course_uuid and external_coursework_id = w->>'id';
      end if;
    end loop;
  end loop;
  return jsonb_build_object('courses', course_count, 'coursework', work_count, 'newTasks', event_count);
end;
$$;
revoke all on function public.sync_classroom(uuid, text, jsonb) from public, anon, authenticated;
grant execute on function public.sync_classroom(uuid, text, jsonb) to service_role;
commit;
