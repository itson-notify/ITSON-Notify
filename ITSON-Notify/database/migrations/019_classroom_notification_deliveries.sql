-- ITN-50 / ITN-44. Review/apply manually; never executed at startup.
-- Requires 006, 008, 014, 016, 017 (and compatible with 018 and 020).
-- The migration runner must wrap this entire file in one transaction (no begin/commit here).
--
-- Additive delivery ledger for Google Classroom task events (classroom_task_events),
-- isolated from grade_changes and notifications_log:
--   - UNIQUE (source, event_id, channel) with channels 'email' and 'web_push'.
--   - Frozen required_channels manifest and authorization generation (google_id, created_at).
--   - Two-phase atomic claim (FOR UPDATE SKIP LOCKED -> claimed with lease_until) and
--     beginSend (revalidates task scope and event integrity right before I/O -> sending
--     with send_deadline) + CAS ack by claim_token.
--   - Expired 'sending' deadlines transition to 'unknown', never blindly re-claimed.
--   - Exhausted 'retry_wait' rows (attempts >= max_attempts) transition to 'dead' in claim.
--   - 'ack' with outcome 'sent' is only accepted from 'sending' or 'unknown', never from 'claimed'.
--   - Deleting classroom_task_events (e.g. disable_classroom_tasks in 018) triggers
--     atomic cancellation of pending/claimed/retry_wait/blocked rows and flags
--     cancel_requested on sending/unknown rows without deleting ledger history.
--
-- Unified Lock Hierarchy (prevents 40P01 deadlocks against sync_classroom and
-- activate/disable_classroom_tasks in 016/017/018):
--   1. public.app_users (FOR UPDATE)
--   2. public.google_authorizations (FOR UPDATE / FOR SHARE)
--   3. public.classroom_task_events (FOR UPDATE / FOR SHARE)
--   4. public.classroom_notification_deliveries (FOR UPDATE)
-- materialize, begin_send and ack read user_id/event_id without a lock first and then
-- acquire locks strictly in the order above; claim uses FOR UPDATE OF d SKIP LOCKED.
set local lock_timeout = '5s';

create table if not exists public.classroom_notification_deliveries (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references public.app_users(id) on delete cascade,
  source text not null default 'classroom'
    constraint classroom_deliveries_source_check
    check (source = 'classroom'),
  event_id uuid not null,
  channel text not null
    constraint classroom_deliveries_channel_check
    check (channel in ('email', 'web_push')),
  required_channels text[] not null
    constraint classroom_deliveries_required_channels_check
    check (
      cardinality(required_channels) >= 1
      and required_channels <@ array['email', 'web_push']::text[]
    ),
  policy_version text not null default 'v1'
    constraint classroom_deliveries_policy_version_check
    check (char_length(policy_version) between 1 and 32),
  authorization_google_id text
    constraint classroom_deliveries_auth_google_id_check
    check (authorization_google_id is null or char_length(authorization_google_id) between 1 and 128),
  authorization_created_at timestamptz,
  state text not null default 'pending'
    constraint classroom_deliveries_state_check
    check (state in ('pending', 'claimed', 'sending', 'retry_wait', 'blocked', 'unknown', 'sent', 'dead', 'cancelled')),
  attempts integer not null default 0
    constraint classroom_deliveries_attempts_check
    check (attempts >= 0 and attempts <= 100),
  next_attempt_at timestamptz not null default now(),
  claim_token uuid,
  lease_until timestamptz,
  send_deadline timestamptz,
  cancel_requested boolean not null default false,
  template_version text not null default 'v1'
    constraint classroom_deliveries_template_version_check
    check (char_length(template_version) between 1 and 32),
  payload jsonb
    constraint classroom_deliveries_payload_check
    check (payload is null or jsonb_typeof(payload) = 'object'),
  recipient_fingerprint text
    constraint classroom_deliveries_fingerprint_check
    check (recipient_fingerprint is null or recipient_fingerprint ~ '^v1:[0-9a-f]{64}$'),
  idempotency_key text
    constraint classroom_deliveries_idempotency_key_check
    check (idempotency_key is null or char_length(idempotency_key) between 1 and 200),
  provider_reference text
    constraint classroom_deliveries_provider_ref_check
    check (provider_reference is null or char_length(provider_reference) between 1 and 200),
  last_error_code text
    constraint classroom_deliveries_error_code_check
    check (last_error_code is null or last_error_code ~ '^[a-z0-9_]{1,64}$'),
  sent_at timestamptz,
  read_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint classroom_deliveries_source_event_channel_key unique (source, event_id, channel)
);

create index if not exists idx_classroom_deliveries_queue
  on public.classroom_notification_deliveries (next_attempt_at, id)
  where state in ('pending', 'retry_wait');

create index if not exists idx_classroom_deliveries_lease
  on public.classroom_notification_deliveries (lease_until, id)
  where state = 'claimed';

create index if not exists idx_classroom_deliveries_sending
  on public.classroom_notification_deliveries (send_deadline, id)
  where state in ('sending', 'unknown');

create index if not exists idx_classroom_deliveries_event
  on public.classroom_notification_deliveries (event_id);

create index if not exists idx_classroom_deliveries_user_created
  on public.classroom_notification_deliveries (user_id, created_at desc);

alter table public.classroom_notification_deliveries enable row level security;
revoke all on public.classroom_notification_deliveries from public, anon, authenticated, service_role;
grant select, insert, update, delete on public.classroom_notification_deliveries to service_role;

-- Trigger on classroom_task_events deletion (e.g. disable_classroom_tasks in 018):
-- Invoked while caller already holds app_users FOR UPDATE -> google_authorizations
-- FOR UPDATE -> classroom_task_events DELETE lock, and then locks/updates
-- classroom_notification_deliveries (step 4 of the lock hierarchy).
-- Preserves all ledger rows while cancelling non-started deliveries and flagging
-- cancel_requested on in-flight sending/unknown rows.
create or replace function public.handle_classroom_task_event_delete()
returns trigger
language plpgsql security invoker set search_path = pg_catalog, public as $$
declare
  v_now timestamptz := clock_timestamp();
begin
  update public.classroom_notification_deliveries
    set state = case
          when state in ('pending', 'claimed', 'retry_wait', 'blocked') then 'cancelled'
          else state
        end,
        cancel_requested = true,
        claim_token = case
          when state in ('pending', 'claimed', 'retry_wait', 'blocked') then null
          else claim_token
        end,
        lease_until = case
          when state in ('pending', 'claimed', 'retry_wait', 'blocked') then null
          else lease_until
        end,
        last_error_code = case
          when state in ('pending', 'claimed', 'retry_wait', 'blocked') then coalesce(last_error_code, 'event_deleted')
          else last_error_code
        end,
        updated_at = v_now
    where source = 'classroom'
      and event_id = old.id
      and state in ('pending', 'claimed', 'retry_wait', 'blocked', 'sending', 'unknown');

  return old;
end;
$$;
revoke all on function public.handle_classroom_task_event_delete() from public, anon, authenticated;
grant execute on function public.handle_classroom_task_event_delete() to service_role;

drop trigger if exists trg_classroom_task_event_delete on public.classroom_task_events;
create trigger trg_classroom_task_event_delete
  before delete on public.classroom_task_events
  for each row execute function public.handle_classroom_task_event_delete();

-- 1) Materialize delivery plan for a classroom_task_events row.
-- Lock order: reads user_id unlocked -> app_users FOR UPDATE -> google_authorizations
-- FOR SHARE -> classroom_task_events FOR UPDATE -> classroom_notification_deliveries.
-- Verifies owner consistency (event/work/course), PUBLISHED task state, non-null
-- coursework_baseline_at with event.created_at > baseline, and active Google
-- authorization with task scope and event.created_at >= auth.created_at.
-- If a plan already exists for the event, returns it without adding or removing channels.
create or replace function public.materialize_classroom_deliveries(
  p_event_id uuid,
  p_channels text[],
  p_policy_version text default 'v1'
)
returns jsonb
language plpgsql security invoker set search_path = pg_catalog, public as $$
declare
  courses_scope constant text := 'https://www.googleapis.com/auth/classroom.courses.readonly';
  work_scopes constant text[] := array[
    'https://www.googleapis.com/auth/classroom.coursework.me.readonly',
    'https://www.googleapis.com/auth/classroom.student-submissions.me.readonly'
  ];
  v_channels text[];
  v_policy text := coalesce(nullif(trim(p_policy_version), ''), 'v1');
  v_now timestamptz := clock_timestamp();
  v_user_id uuid;
  v_has_auth boolean := false;
  v_event record;
  v_work record;
  v_course record;
  v_auth record;
  v_scopes text[];
  v_initial_state text := 'pending';
  v_reason text := null;
  v_google_id text := null;
  v_auth_created_at timestamptz := null;
  v_existing jsonb;
  v_ch text;
begin
  if p_event_id is null then
    raise exception 'invalid_delivery_event' using errcode = '22023';
  end if;
  if p_channels is null or cardinality(p_channels) = 0
     or not (p_channels <@ array['email', 'web_push']::text[]) then
    raise exception 'invalid_delivery_channels' using errcode = '22023';
  end if;

  select array_agg(ch order by ord) into v_channels
    from (values ('email', 1), ('web_push', 2)) as valid(ch, ord)
    where ch = any(p_channels);

  if v_channels is null or cardinality(v_channels) = 0 then
    raise exception 'invalid_delivery_channels' using errcode = '22023';
  end if;

  -- Step 0: read user_id without lock so we can lock app_users first.
  select user_id into v_user_id
    from public.classroom_task_events
    where id = p_event_id;

  if not found then
    return jsonb_build_object('status', 'missing_event', 'deliveries', '[]'::jsonb);
  end if;

  -- Lock 1: app_users
  perform 1 from public.app_users where id = v_user_id for update;
  if not found then
    raise exception 'classroom_authorization_required' using errcode = '42501';
  end if;

  -- Lock 2: google_authorizations
  select user_id, google_id, email, scope, status, created_at
    into v_auth
    from public.google_authorizations
    where user_id = v_user_id
    for share;
  v_has_auth := found;

  -- Lock 3: classroom_task_events (evento)
  select id, user_id, coursework_id, event_type, created_at, delivered_at
    into v_event
    from public.classroom_task_events
    where id = p_event_id and user_id = v_user_id
    for update;

  if not found then
    return jsonb_build_object('status', 'missing_event', 'deliveries', '[]'::jsonb);
  end if;

  -- Lock 4: classroom_notification_deliveries (entrega)
  select jsonb_agg(jsonb_build_object(
           'id', d.id, 'event_id', d.event_id, 'channel', d.channel,
           'state', d.state, 'required_channels', d.required_channels,
           'policy_version', d.policy_version, 'attempts', d.attempts,
           'last_error_code', d.last_error_code
         ) order by d.channel)
    into v_existing
    from public.classroom_notification_deliveries d
    where d.source = 'classroom' and d.event_id = p_event_id;

  if v_existing is not null then
    return jsonb_build_object('status', 'existing', 'deliveries', v_existing);
  end if;

  select id, user_id, course_id, title, state, due_at, alternate_link
    into v_work
    from public.classroom_coursework
    where id = v_event.coursework_id;

  if found then
    select id, user_id, name, coursework_baseline_at
      into v_course
      from public.classroom_courses
      where id = v_work.course_id;
  end if;

  if v_event.event_type is distinct from 'classroom.task.created'
     or v_work.id is null or v_course.id is null
     or v_work.user_id is distinct from v_event.user_id
     or v_course.user_id is distinct from v_event.user_id then
    v_initial_state := 'cancelled';
    v_reason := 'owner_or_event_invalid';
  elsif v_work.state is distinct from 'PUBLISHED'
        or v_course.coursework_baseline_at is null
        or v_event.created_at <= v_course.coursework_baseline_at then
    v_initial_state := 'cancelled';
    v_reason := 'event_not_eligible';
  elsif not v_has_auth then
    v_initial_state := 'cancelled';
    v_reason := 'authorization_missing';
  else
    v_google_id := v_auth.google_id;
    v_auth_created_at := v_auth.created_at;
    v_scopes := string_to_array(coalesce(v_auth.scope, ''), ' ');

    if v_event.created_at < v_auth.created_at then
      v_initial_state := 'cancelled';
      v_reason := 'backlog_before_grant';
    elsif not (courses_scope = any(v_scopes)) or not (v_scopes && work_scopes) then
      v_initial_state := 'cancelled';
      v_reason := 'tasks_scope_missing';
    elsif v_auth.status is distinct from 'active' then
      v_initial_state := 'blocked';
      v_reason := 'needs_relink';
    end if;
  end if;

  foreach v_ch in array v_channels loop
    insert into public.classroom_notification_deliveries (
      user_id, source, event_id, channel, required_channels, policy_version,
      authorization_google_id, authorization_created_at, state, attempts,
      next_attempt_at, last_error_code, created_at, updated_at
    )
    values (
      v_event.user_id, 'classroom', v_event.id, v_ch, v_channels, v_policy,
      v_google_id, v_auth_created_at, v_initial_state, 0,
      v_now, v_reason, v_now, v_now
    )
    on conflict (source, event_id, channel) do nothing;
  end loop;

  select jsonb_agg(jsonb_build_object(
           'id', d.id, 'event_id', d.event_id, 'channel', d.channel,
           'state', d.state, 'required_channels', d.required_channels,
           'policy_version', d.policy_version, 'attempts', d.attempts,
           'last_error_code', d.last_error_code
         ) order by d.channel)
    into v_existing
    from public.classroom_notification_deliveries d
    where d.source = 'classroom' and d.event_id = p_event_id;

  return jsonb_build_object(
    'status', case when v_initial_state = 'pending' then 'materialized' else v_initial_state end,
    'deliveries', coalesce(v_existing, '[]'::jsonb)
  );
end;
$$;
revoke all on function public.materialize_classroom_deliveries(uuid, text[], text) from public, anon, authenticated;
grant execute on function public.materialize_classroom_deliveries(uuid, text[], text) to service_role;

-- 2) Atomic claim of one eligible delivery using FOR UPDATE SKIP LOCKED and DB clock.
-- All row locks on classroom_notification_deliveries use FOR UPDATE OF d SKIP LOCKED,
-- so claim never waits on locks held by concurrent transactions.
--   - Expired 'sending' deadlines transition to 'unknown' (never re-claimed).
--   - 'retry_wait' (or 'pending') rows with attempts >= max_attempts transition to 'dead'.
--   - Expired 'claimed' leases are reclaimed with a new claim_token without incrementing attempts.
create or replace function public.claim_classroom_delivery(
  p_lease_seconds integer default 60,
  p_max_attempts integer default 5
)
returns jsonb
language plpgsql security invoker set search_path = pg_catalog, public as $$
declare
  courses_scope constant text := 'https://www.googleapis.com/auth/classroom.courses.readonly';
  work_scopes constant text[] := array[
    'https://www.googleapis.com/auth/classroom.coursework.me.readonly',
    'https://www.googleapis.com/auth/classroom.student-submissions.me.readonly'
  ];
  v_now timestamptz := clock_timestamp();
  v_lease interval := make_interval(secs => greatest(coalesce(p_lease_seconds, 60), 5));
  v_max integer := greatest(coalesce(p_max_attempts, 5), 1);
  v_claimed record;
begin
  -- (a) Move expired 'sending' rows to 'unknown' (never re-claim sending automatically).
  with expired_sending as (
    select d.id
      from public.classroom_notification_deliveries d
      where d.state = 'sending'
        and d.send_deadline is not null
        and d.send_deadline < v_now
      order by d.id
      for update of d skip locked
  )
  update public.classroom_notification_deliveries d
    set state = 'unknown',
        lease_until = null,
        send_deadline = null,
        last_error_code = coalesce(d.last_error_code, 'send_deadline_expired'),
        updated_at = v_now
    from expired_sending x
    where d.id = x.id;

  -- (b) Move 'retry_wait' (or 'pending' / expired 'claimed') rows that reached max attempts to 'dead'.
  with exhausted as (
    select d.id
      from public.classroom_notification_deliveries d
      where d.attempts >= v_max
        and (
          d.state in ('retry_wait', 'pending')
          or (d.state = 'claimed' and d.lease_until < v_now)
        )
      order by d.id
      for update of d skip locked
  )
  update public.classroom_notification_deliveries d
    set state = 'dead',
        claim_token = null,
        lease_until = null,
        send_deadline = null,
        last_error_code = coalesce(d.last_error_code, 'max_attempts_reached'),
        updated_at = v_now
    from exhausted x
    where d.id = x.id;

  -- (c) Unblock 'blocked' rows if the same authorization recovered to active with task scopes.
  with unblocked as (
    select d.id
      from public.classroom_notification_deliveries d
      join public.classroom_task_events e on e.id = d.event_id
      join public.google_authorizations auth on auth.user_id = d.user_id
      where d.state = 'blocked'
        and d.cancel_requested = false
        and d.last_error_code = 'needs_relink'
        and auth.google_id is not distinct from d.authorization_google_id
        and auth.created_at is not distinct from d.authorization_created_at
        and auth.status = 'active'
        and courses_scope = any(string_to_array(coalesce(auth.scope, ''), ' '))
        and string_to_array(coalesce(auth.scope, ''), ' ') && work_scopes
      order by d.id
      for update of d skip locked
  )
  update public.classroom_notification_deliveries d
    set state = 'pending',
        last_error_code = null,
        next_attempt_at = v_now,
        updated_at = v_now
    from unblocked x
    where d.id = x.id;

  -- (d) Claim one eligible delivery.
  with eligible as (
    select d.id
      from public.classroom_notification_deliveries d
      where d.cancel_requested = false
        and d.attempts < v_max
        and (
          (d.state in ('pending', 'retry_wait') and d.next_attempt_at <= v_now)
          or (d.state = 'claimed' and d.lease_until < v_now)
        )
      order by d.next_attempt_at asc, d.id asc
      for update of d skip locked
      limit 1
  )
  update public.classroom_notification_deliveries d
    set state = 'claimed',
        claim_token = gen_random_uuid(),
        lease_until = v_now + v_lease,
        updated_at = v_now
    from eligible x
    where d.id = x.id
    returning d.id, d.event_id, d.user_id, d.source, d.channel, d.state,
              d.attempts, d.claim_token, d.lease_until, d.required_channels,
              d.policy_version
    into v_claimed;

  if not found then
    return null;
  end if;

  return jsonb_build_object(
    'id', v_claimed.id,
    'event_id', v_claimed.event_id,
    'user_id', v_claimed.user_id,
    'source', v_claimed.source,
    'channel', v_claimed.channel,
    'state', v_claimed.state,
    'attempts', v_claimed.attempts,
    'claim_token', v_claimed.claim_token,
    'lease_until', v_claimed.lease_until,
    'required_channels', v_claimed.required_channels,
    'policy_version', v_claimed.policy_version
  );
end;
$$;
revoke all on function public.claim_classroom_delivery(integer, integer) from public, anon, authenticated;
grant execute on function public.claim_classroom_delivery(integer, integer) to service_role;

-- 3) Begin send transaction right before external I/O.
-- Lock order: reads (user_id, event_id) unlocked -> app_users FOR UPDATE ->
-- google_authorizations FOR SHARE -> classroom_task_events FOR SHARE ->
-- classroom_notification_deliveries FOR UPDATE.
-- Verifies state='claimed', matching claim_token and unexpired lease_until;
-- re-validates event/work/course ownership and active Google authorization with
-- task scope and unchanged generation; freezes immutable payload, recipient_fingerprint,
-- and idempotency_key; increments attempts and transitions to 'sending'.
create or replace function public.begin_classroom_delivery_send(
  p_delivery_id uuid,
  p_claim_token uuid,
  p_send_deadline_seconds integer default 30,
  p_max_attempts integer default 5,
  p_recipient_fingerprint text default null,
  p_template_version text default 'v1'
)
returns jsonb
language plpgsql security invoker set search_path = pg_catalog, public as $$
declare
  courses_scope constant text := 'https://www.googleapis.com/auth/classroom.courses.readonly';
  work_scopes constant text[] := array[
    'https://www.googleapis.com/auth/classroom.coursework.me.readonly',
    'https://www.googleapis.com/auth/classroom.student-submissions.me.readonly'
  ];
  v_now timestamptz := clock_timestamp();
  v_deadline interval := make_interval(secs => greatest(coalesce(p_send_deadline_seconds, 30), 5));
  v_max integer := greatest(coalesce(p_max_attempts, 5), 1);
  v_user_id uuid;
  v_event_id uuid;
  v_has_user boolean := false;
  v_has_auth boolean := false;
  v_has_event boolean := false;
  v_d record;
  v_event record;
  v_work record;
  v_course record;
  v_auth record;
  v_scopes text[];
  v_payload jsonb;
  v_idempotency_key text;
  v_fingerprint text;
  v_template text;
begin
  -- Step 0: read user_id and event_id without lock so we can lock in canonical hierarchy.
  select user_id, event_id
    into v_user_id, v_event_id
    from public.classroom_notification_deliveries
    where id = p_delivery_id;

  if not found then
    return jsonb_build_object('allowed', false, 'reason_code', 'invalid_or_expired_claim');
  end if;

  -- Lock 1: app_users
  perform 1 from public.app_users where id = v_user_id for update;
  v_has_user := found;

  -- Lock 2: google_authorizations
  select user_id, google_id, email, scope, status, created_at
    into v_auth
    from public.google_authorizations
    where user_id = v_user_id
    for share;
  v_has_auth := found;

  -- Lock 3: classroom_task_events (evento)
  select id, user_id, coursework_id, event_type, created_at
    into v_event
    from public.classroom_task_events
    where id = v_event_id and user_id = v_user_id
    for share;
  v_has_event := found;

  -- Lock 4: classroom_notification_deliveries (entrega)
  select *
    into v_d
    from public.classroom_notification_deliveries
    where id = p_delivery_id and user_id = v_user_id
    for update;

  if not found then
    return jsonb_build_object('allowed', false, 'reason_code', 'invalid_or_expired_claim');
  end if;

  if v_d.cancel_requested then
    if v_d.state in ('pending', 'claimed', 'retry_wait', 'blocked') then
      update public.classroom_notification_deliveries
        set state = 'cancelled',
            claim_token = null,
            lease_until = null,
            last_error_code = coalesce(last_error_code, 'cancel_requested'),
            updated_at = v_now
        where id = v_d.id;
    end if;
    return jsonb_build_object('allowed', false, 'reason_code', 'cancel_requested', 'state', 'cancelled');
  end if;

  if v_d.state is distinct from 'claimed'
     or v_d.claim_token is null
     or v_d.claim_token is distinct from p_claim_token
     or v_d.lease_until is null
     or v_d.lease_until < v_now then
    return jsonb_build_object('allowed', false, 'reason_code', 'invalid_or_expired_claim');
  end if;

  if v_d.attempts >= v_max then
    update public.classroom_notification_deliveries
      set state = 'dead',
          claim_token = null,
          lease_until = null,
          last_error_code = 'max_attempts_reached',
          updated_at = v_now
      where id = v_d.id;
    return jsonb_build_object('allowed', false, 'reason_code', 'max_attempts_reached', 'state', 'dead');
  end if;

  if v_has_event then
    select id, user_id, course_id, title, state, due_at, alternate_link
      into v_work
      from public.classroom_coursework
      where id = v_event.coursework_id;
  end if;

  if v_work.id is not null then
    select id, user_id, name, coursework_baseline_at
      into v_course
      from public.classroom_courses
      where id = v_work.course_id;
  end if;

  if not v_has_user
     or not v_has_event
     or v_work.id is null
     or v_course.id is null
     or v_event.user_id is distinct from v_d.user_id
     or v_work.user_id is distinct from v_d.user_id
     or v_course.user_id is distinct from v_d.user_id
     or v_event.event_type is distinct from 'classroom.task.created'
     or v_work.state is distinct from 'PUBLISHED'
     or v_course.coursework_baseline_at is null
     or v_event.created_at <= v_course.coursework_baseline_at then
    update public.classroom_notification_deliveries
      set state = 'cancelled',
          claim_token = null,
          lease_until = null,
          last_error_code = 'event_no_longer_valid',
          updated_at = v_now
      where id = v_d.id;
    return jsonb_build_object('allowed', false, 'reason_code', 'event_no_longer_valid', 'state', 'cancelled');
  end if;

  if not v_has_auth
     or v_auth.google_id is distinct from v_d.authorization_google_id
     or v_auth.created_at is distinct from v_d.authorization_created_at
     or v_event.created_at < v_auth.created_at then
    update public.classroom_notification_deliveries
      set state = 'cancelled',
          claim_token = null,
          lease_until = null,
          last_error_code = 'authorization_revoked',
          updated_at = v_now
      where id = v_d.id;
    return jsonb_build_object('allowed', false, 'reason_code', 'authorization_revoked', 'state', 'cancelled');
  end if;

  v_scopes := string_to_array(coalesce(v_auth.scope, ''), ' ');
  if not (courses_scope = any(v_scopes)) or not (v_scopes && work_scopes) then
    update public.classroom_notification_deliveries
      set state = 'cancelled',
          claim_token = null,
          lease_until = null,
          last_error_code = 'tasks_scope_revoked',
          updated_at = v_now
      where id = v_d.id;
    return jsonb_build_object('allowed', false, 'reason_code', 'tasks_scope_revoked', 'state', 'cancelled');
  end if;

  if v_auth.status is distinct from 'active' then
    update public.classroom_notification_deliveries
      set state = 'blocked',
          claim_token = null,
          lease_until = null,
          last_error_code = 'needs_relink',
          updated_at = v_now
      where id = v_d.id;
    return jsonb_build_object('allowed', false, 'reason_code', 'needs_relink', 'state', 'blocked');
  end if;

  if v_d.recipient_fingerprint is not null
     and p_recipient_fingerprint is not null
     and v_d.recipient_fingerprint is distinct from p_recipient_fingerprint then
    update public.classroom_notification_deliveries
      set state = 'cancelled',
          claim_token = null,
          lease_until = null,
          last_error_code = 'recipient_changed',
          updated_at = v_now
      where id = v_d.id;
    return jsonb_build_object('allowed', false, 'reason_code', 'recipient_changed', 'state', 'cancelled');
  end if;

  v_payload := coalesce(
    v_d.payload,
    jsonb_build_object(
      'course_name', v_course.name,
      'task_title', v_work.title,
      'due_at', v_work.due_at,
      'alternate_link', v_work.alternate_link
    )
  );
  v_idempotency_key := coalesce(
    v_d.idempotency_key,
    'classroom:' || v_d.source || ':' || v_d.event_id::text || ':' || v_d.channel
  );
  v_fingerprint := coalesce(v_d.recipient_fingerprint, p_recipient_fingerprint);
  v_template := coalesce(nullif(trim(p_template_version), ''), v_d.template_version);

  update public.classroom_notification_deliveries
    set state = 'sending',
        attempts = v_d.attempts + 1,
        payload = v_payload,
        idempotency_key = v_idempotency_key,
        recipient_fingerprint = v_fingerprint,
        template_version = v_template,
        send_deadline = v_now + v_deadline,
        updated_at = v_now
    where id = v_d.id;

  return jsonb_build_object(
    'allowed', true,
    'delivery_id', v_d.id,
    'event_id', v_d.event_id,
    'user_id', v_d.user_id,
    'channel', v_d.channel,
    'claim_token', v_d.claim_token,
    'attempts', v_d.attempts + 1,
    'idempotency_key', v_idempotency_key,
    'recipient_fingerprint', v_fingerprint,
    'recipient_email', v_auth.email,
    'authorization_google_id', v_auth.google_id,
    'payload', v_payload,
    'created_at', v_d.created_at,
    'send_deadline', v_now + v_deadline
  );
end;
$$;
revoke all on function public.begin_classroom_delivery_send(uuid, uuid, integer, integer, text, text) from public, anon, authenticated;
grant execute on function public.begin_classroom_delivery_send(uuid, uuid, integer, integer, text, text) to service_role;

-- 4) CAS ACK of a delivery attempt by claim_token.
-- Lock order: reads (user_id, event_id) unlocked -> app_users FOR UPDATE ->
-- google_authorizations FOR SHARE -> classroom_task_events FOR UPDATE ->
-- classroom_notification_deliveries FOR UPDATE.
--   - 'sent' (and 'unknown' / 'retry_wait') is only accepted from 'sending' or 'unknown',
--     never from 'claimed'.
--   - Repeated ACK of the same sent attempt is idempotent.
--   - Late ACK with the current token can resolve 'unknown'.
--   - Marks classroom_task_events.delivered_at if and only if all required_channels
--     exist and are in state = 'sent'.
create or replace function public.ack_classroom_delivery(
  p_delivery_id uuid,
  p_claim_token uuid,
  p_outcome text,
  p_provider_reference text default null,
  p_error_code text default null,
  p_retry_delay_seconds integer default 60,
  p_max_attempts integer default 5
)
returns jsonb
language plpgsql security invoker set search_path = pg_catalog, public as $$
declare
  v_now timestamptz := clock_timestamp();
  v_delay interval := make_interval(secs => greatest(coalesce(p_retry_delay_seconds, 60), 1));
  v_max integer := greatest(coalesce(p_max_attempts, 5), 1);
  v_user_id uuid;
  v_event_id uuid;
  v_d record;
  v_new_state text;
  v_error text := case
    when p_error_code is not null and p_error_code ~ '^[a-z0-9_]{1,64}$' then p_error_code
    else null
  end;
  v_ref text := case
    when p_provider_reference is not null and char_length(trim(p_provider_reference)) between 1 and 200
      then trim(p_provider_reference)
    else null
  end;
  v_keep_token uuid := null;
  v_sent_at timestamptz := null;
  v_next_attempt timestamptz;
  v_req_count integer;
  v_total_rows integer;
  v_sent_rows integer;
  v_event_delivered boolean := false;
begin
  -- Step 0: read user_id and event_id without lock so we can lock in canonical hierarchy.
  select user_id, event_id
    into v_user_id, v_event_id
    from public.classroom_notification_deliveries
    where id = p_delivery_id;

  if not found then
    return jsonb_build_object('acknowledged', false, 'reason_code', 'token_mismatch');
  end if;

  -- Lock 1: app_users
  perform 1 from public.app_users where id = v_user_id for update;

  -- Lock 2: google_authorizations
  perform 1 from public.google_authorizations where user_id = v_user_id for share;

  -- Lock 3: classroom_task_events (evento)
  perform 1 from public.classroom_task_events where id = v_event_id and user_id = v_user_id for update;

  -- Lock 4: classroom_notification_deliveries (entrega)
  select *
    into v_d
    from public.classroom_notification_deliveries
    where id = p_delivery_id and user_id = v_user_id
    for update;

  if not found or v_d.claim_token is null or v_d.claim_token is distinct from p_claim_token then
    return jsonb_build_object('acknowledged', false, 'reason_code', 'token_mismatch');
  end if;

  if v_d.state = 'sent' and p_outcome = 'sent' then
    return jsonb_build_object('acknowledged', true, 'state', 'sent', 'idempotent', true, 'event_delivered', false);
  end if;

  if v_d.state not in ('sending', 'unknown', 'claimed') then
    return jsonb_build_object('acknowledged', false, 'reason_code', 'invalid_state_transition');
  end if;

  -- 'sent', 'unknown' and 'retry_wait' are only valid after begin_send ('sending' or 'unknown'), never from 'claimed'.
  if p_outcome in ('sent', 'unknown', 'retry_wait') and v_d.state not in ('sending', 'unknown') then
    return jsonb_build_object('acknowledged', false, 'reason_code', 'invalid_state_transition');
  end if;

  v_next_attempt := v_d.next_attempt_at;

  if p_outcome = 'sent' then
    v_new_state := 'sent';
    v_sent_at := coalesce(v_d.sent_at, v_now);
    v_error := null;
    v_keep_token := v_d.claim_token;
  elsif p_outcome = 'retry_wait' then
    if v_d.cancel_requested then
      v_new_state := 'cancelled';
      v_error := coalesce(v_error, 'cancel_requested');
    elsif v_d.attempts >= v_max then
      v_new_state := 'dead';
      v_error := coalesce(v_error, 'max_attempts_reached');
    else
      v_new_state := 'retry_wait';
      v_next_attempt := v_now + v_delay;
      v_error := coalesce(v_error, 'transient_error');
    end if;
  elsif p_outcome = 'unknown' then
    v_new_state := 'unknown';
    v_error := coalesce(v_error, 'ambiguous_delivery');
    v_keep_token := v_d.claim_token;
  elsif p_outcome = 'dead' then
    v_new_state := 'dead';
    v_error := coalesce(v_error, 'permanent_rejection');
  elsif p_outcome = 'blocked' then
    if v_d.cancel_requested then
      v_new_state := 'cancelled';
      v_error := coalesce(v_error, 'cancel_requested');
    else
      v_new_state := 'blocked';
      v_error := coalesce(v_error, 'blocked');
    end if;
  elsif p_outcome = 'cancelled' then
    v_new_state := 'cancelled';
    v_error := coalesce(v_error, 'cancelled');
  elsif p_outcome = 'release' and v_d.state = 'claimed' then
    if v_d.cancel_requested then
      v_new_state := 'cancelled';
      v_error := coalesce(v_error, 'cancel_requested');
    else
      v_new_state := 'pending';
    end if;
  else
    raise exception 'invalid_delivery_outcome' using errcode = '22023';
  end if;

  update public.classroom_notification_deliveries
    set state = v_new_state,
        claim_token = v_keep_token,
        lease_until = null,
        send_deadline = null,
        next_attempt_at = v_next_attempt,
        provider_reference = coalesce(v_ref, provider_reference),
        last_error_code = v_error,
        sent_at = coalesce(v_sent_at, sent_at),
        updated_at = v_now
    where id = v_d.id;

  if v_new_state = 'sent' then
    v_req_count := cardinality(v_d.required_channels);
    select count(*), count(*) filter (where state = 'sent')
      into v_total_rows, v_sent_rows
      from public.classroom_notification_deliveries
      where source = v_d.source
        and event_id = v_d.event_id
        and channel = any(v_d.required_channels);

    if v_req_count > 0 and v_total_rows = v_req_count and v_sent_rows = v_req_count then
      update public.classroom_task_events
        set delivered_at = coalesce(delivered_at, v_now)
        where id = v_d.event_id;
      v_event_delivered := found;
    end if;
  end if;

  return jsonb_build_object(
    'acknowledged', true,
    'state', v_new_state,
    'event_delivered', v_event_delivered
  );
end;
$$;
revoke all on function public.ack_classroom_delivery(uuid, uuid, text, text, text, integer, integer) from public, anon, authenticated;
grant execute on function public.ack_classroom_delivery(uuid, uuid, text, text, text, integer, integer) to service_role;
