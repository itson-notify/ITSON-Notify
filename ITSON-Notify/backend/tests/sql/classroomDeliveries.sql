-- Disposable local PostgreSQL cluster test suite for 019_classroom_notification_deliveries.sql.
-- Synthetic users and metadata only; requires 006, 008, 014, 016, 017, 019 applied.

create or replace function public.test_assert(ok boolean, label text) returns void language plpgsql as $$
begin
  if ok is distinct from true then
    raise exception 'FAILED: %', label;
  end if;
end;
$$;

-- 1) RLS and ACL verification before switching to service_role
select test_assert(
  (select relrowsecurity from pg_class where oid = 'public.classroom_notification_deliveries'::regclass),
  'deliveries RLS enabled'
);
select test_assert(
  (select count(*) = 0 from pg_policies where schemaname = 'public' and tablename = 'classroom_notification_deliveries'),
  'deliveries zero public policies'
);
select test_assert(
  not has_table_privilege('anon', 'public.classroom_notification_deliveries', 'SELECT'),
  'anon cannot select deliveries'
);
select test_assert(
  not has_table_privilege('authenticated', 'public.classroom_notification_deliveries', 'SELECT'),
  'authenticated cannot select deliveries'
);
select test_assert(
  not has_function_privilege('anon', 'public.materialize_classroom_deliveries(uuid,text[],text)', 'EXECUTE'),
  'anon cannot materialize'
);
select test_assert(
  not has_function_privilege('authenticated', 'public.claim_classroom_delivery(integer,integer)', 'EXECUTE'),
  'authenticated cannot claim'
);
select test_assert(
  not has_function_privilege('authenticated', 'public.begin_classroom_delivery_send(uuid,uuid,integer,integer,text,text)', 'EXECUTE'),
  'authenticated cannot beginSend'
);
select test_assert(
  not has_function_privilege('authenticated', 'public.ack_classroom_delivery(uuid,uuid,text,text,text,integer,integer)', 'EXECUTE'),
  'authenticated cannot ack'
);

insert into public.app_users(id) values
  ('00000000-0000-4000-8000-000000000011'),
  ('00000000-0000-4000-8000-000000000012')
on conflict (id) do nothing;

insert into public.google_authorizations(user_id, google_id, email, scope, refresh_token, status, created_at)
values
  (
    '00000000-0000-4000-8000-000000000011',
    'g-ledger-1',
    'student1@potros.itson.edu.mx',
    'https://www.googleapis.com/auth/classroom.courses.readonly https://www.googleapis.com/auth/classroom.coursework.me.readonly',
    'cipher-1',
    'active',
    '2026-11-01T00:00:00Z'
  ),
  (
    '00000000-0000-4000-8000-000000000012',
    'g-ledger-2',
    'student2@potros.itson.edu.mx',
    'https://www.googleapis.com/auth/classroom.courses.readonly',
    'cipher-2',
    'active',
    '2026-11-01T00:00:00Z'
  )
on conflict (user_id) do update
  set google_id = excluded.google_id,
      email = excluded.email,
      scope = excluded.scope,
      status = excluded.status,
      created_at = excluded.created_at;

set role service_role;

-- Create baseline course + tasks, then incremental tasks for student 1
perform public.sync_classroom(
  '00000000-0000-4000-8000-000000000011',
  'g-ledger-1',
  '[{"id":"c-ledger-1","name":"Arquitectura de Software","coursework":[{"id":"w-base","title":"Tarea base","state":"PUBLISHED"}]}]'::jsonb
);
perform public.sync_classroom(
  '00000000-0000-4000-8000-000000000011',
  'g-ledger-1',
  '[{"id":"c-ledger-1","name":"Arquitectura de Software","coursework":[
    {"id":"w-base","title":"Tarea base","state":"PUBLISHED"},
    {"id":"w-new-1","title":"Proyecto Unidad 1","state":"PUBLISHED","due_at":"2026-11-25T06:59:00Z","alternate_link":"https://classroom.google.com/c/1/a/2/details"},
    {"id":"w-new-2","title":"Proyecto Unidad 2","state":"PUBLISHED"},
    {"id":"w-new-3","title":"Proyecto Unidad 3","state":"PUBLISHED"}
  ]}]'::jsonb
);

-- 2) Materialization idempotency and manifest freeze
do $$
declare
  v_ev1 uuid;
  v_m1 jsonb;
  v_m2 jsonb;
begin
  select e.id into v_ev1
    from public.classroom_task_events e
    join public.classroom_coursework w on w.id = e.coursework_id
    where w.external_coursework_id = 'w-new-1';

  v_m1 := public.materialize_classroom_deliveries(v_ev1, array['web_push', 'email'], 'v1');
  perform public.test_assert(v_m1->>'status' = 'materialized', 'first materialize status');
  perform public.test_assert(jsonb_array_length(v_m1->'deliveries') = 2, 'two channels materialized');

  -- Second call with only ['email'] must return 'existing' and keep both channels frozen
  v_m2 := public.materialize_classroom_deliveries(v_ev1, array['email'], 'v2');
  perform public.test_assert(v_m2->>'status' = 'existing', 'second materialize returns existing');
  perform public.test_assert(jsonb_array_length(v_m2->'deliveries') = 2, 'manifest remains frozen at 2 channels');
end;
$$;

-- 3) Expired 'claimed' lease recovery vs expired 'sending' -> 'unknown'
do $$
declare
  v_ev1 uuid;
  v_claim1 jsonb;
  v_claim1_reclaimed jsonb;
  v_old_begin jsonb;
  v_new_begin jsonb;
  v_ack_email jsonb;
  v_claim_push jsonb;
  v_begin_push jsonb;
  v_next_claim jsonb;
  v_late_ack jsonb;
begin
  select e.id into v_ev1
    from public.classroom_task_events e
    join public.classroom_coursework w on w.id = e.coursework_id
    where w.external_coursework_id = 'w-new-1';

  -- Claim first delivery (email)
  v_claim1 := public.claim_classroom_delivery(60, 5);
  perform public.test_assert(v_claim1 is not null and v_claim1->>'channel' = 'email', 'claimed email delivery');
  perform public.test_assert((v_claim1->>'attempts')::int = 0, 'claim does not increment attempts');

  -- Force lease expiration before beginSend
  update public.classroom_notification_deliveries
    set lease_until = clock_timestamp() - interval '10 seconds'
    where id = (v_claim1->>'id')::uuid;

  -- Put the other delivery in future retry_wait so we deterministic-reclaim the expired claimed row
  update public.classroom_notification_deliveries
    set state = 'retry_wait', next_attempt_at = clock_timestamp() + interval '10 minutes'
    where event_id = v_ev1 and channel = 'web_push';

  v_claim1_reclaimed := public.claim_classroom_delivery(60, 5);
  perform public.test_assert(v_claim1_reclaimed->>'id' = v_claim1->>'id', 'expired claimed row is reclaimed');
  perform public.test_assert(v_claim1_reclaimed->>'claim_token' <> v_claim1->>'claim_token', 'new claim_token issued');
  perform public.test_assert((v_claim1_reclaimed->>'attempts')::int = 0, 'reclaiming expired lease keeps attempts at 0');

  -- Old consumer with old claim_token is rejected by beginSend
  v_old_begin := public.begin_classroom_delivery_send(
    (v_claim1->>'id')::uuid,
    (v_claim1->>'claim_token')::uuid,
    30, 5, 'v1:' || repeat('a', 64), 'v1'
  );
  perform public.test_assert((v_old_begin->>'allowed')::boolean = false, 'old claim_token rejected in beginSend');

  -- New consumer passes beginSend -> state='sending', attempts=1
  v_new_begin := public.begin_classroom_delivery_send(
    (v_claim1_reclaimed->>'id')::uuid,
    (v_claim1_reclaimed->>'claim_token')::uuid,
    30, 5, 'v1:' || repeat('a', 64), 'v1'
  );
  perform public.test_assert((v_new_begin->>'allowed')::boolean = true, 'new claim_token allowed in beginSend');
  perform public.test_assert((v_new_begin->>'attempts')::int = 1, 'beginSend increments attempts to 1');

  -- ACK email as 'sent': delivered_at on event must still be NULL because web_push is not sent yet
  v_ack_email := public.ack_classroom_delivery(
    (v_claim1_reclaimed->>'id')::uuid,
    (v_claim1_reclaimed->>'claim_token')::uuid,
    'sent', 'resend-id-123', null, 60, 5
  );
  perform public.test_assert((v_ack_email->>'acknowledged')::boolean = true and v_ack_email->>'state' = 'sent', 'email acked as sent');
  perform public.test_assert((v_ack_email->>'event_delivered')::boolean = false, 'event not marked delivered while push pending');
  perform public.test_assert((select delivered_at is null from public.classroom_task_events where id = v_ev1), 'delivered_at remains null');

  -- Make web_push eligible now, claim and beginSend it, then expire its send_deadline
  update public.classroom_notification_deliveries
    set next_attempt_at = clock_timestamp() - interval '1 second'
    where event_id = v_ev1 and channel = 'web_push';

  v_claim_push := public.claim_classroom_delivery(60, 5);
  perform public.test_assert(v_claim_push->>'channel' = 'web_push', 'claimed web_push');

  v_begin_push := public.begin_classroom_delivery_send(
    (v_claim_push->>'id')::uuid,
    (v_claim_push->>'claim_token')::uuid,
    30, 5, 'v1:' || repeat('b', 64), 'v1'
  );
  perform public.test_assert((v_begin_push->>'allowed')::boolean = true, 'web_push beginSend allowed');

  -- Simulate send_deadline expiration while in 'sending'
  update public.classroom_notification_deliveries
    set send_deadline = clock_timestamp() - interval '5 seconds'
    where id = (v_claim_push->>'id')::uuid;

  -- Calling claim_classroom_delivery must transition expired 'sending' to 'unknown' and return null
  v_next_claim := public.claim_classroom_delivery(60, 5);
  perform public.test_assert(v_next_claim is null, 'expired sending is never re-claimed');
  perform public.test_assert(
    (select state = 'unknown' and last_error_code = 'send_deadline_expired'
       from public.classroom_notification_deliveries
       where id = (v_claim_push->>'id')::uuid),
    'expired sending transitioned to unknown'
  );

  -- Late ACK with the same claim_token resolves 'unknown' to 'sent' and completes delivered_at!
  v_late_ack := public.ack_classroom_delivery(
    (v_claim_push->>'id')::uuid,
    (v_claim_push->>'claim_token')::uuid,
    'sent', 'push_devices:1/1', null, 60, 5
  );
  perform public.test_assert((v_late_ack->>'acknowledged')::boolean = true and v_late_ack->>'state' = 'sent', 'late ack resolves unknown');
  perform public.test_assert((v_late_ack->>'event_delivered')::boolean = true, 'event marked delivered after all required channels sent');
  perform public.test_assert((select delivered_at is not null from public.classroom_task_events where id = v_ev1), 'delivered_at set on classroom_task_events');
end;
$$;

-- 4) Task scope removal / needs_relink before beginSend and event deletion trigger (018 compatibility)
do $$
declare
  v_ev2 uuid;
  v_ev3 uuid;
  v_claim2 jsonb;
  v_begin2 jsonb;
  v_claim3 jsonb;
begin
  select e.id into v_ev2
    from public.classroom_task_events e
    join public.classroom_coursework w on w.id = e.coursework_id
    where w.external_coursework_id = 'w-new-2';

  select e.id into v_ev3
    from public.classroom_task_events e
    join public.classroom_coursework w on w.id = e.coursework_id
    where w.external_coursework_id = 'w-new-3';

  perform public.materialize_classroom_deliveries(v_ev2, array['email'], 'v1');
  perform public.materialize_classroom_deliveries(v_ev3, array['email'], 'v1');

  -- Claim ev2, then revoke task scope (leaving only courses.readonly) before beginSend
  v_claim2 := public.claim_classroom_delivery(60, 5);
  update public.google_authorizations
    set scope = 'https://www.googleapis.com/auth/classroom.courses.readonly'
    where user_id = '00000000-0000-4000-8000-000000000011';

  v_begin2 := public.begin_classroom_delivery_send(
    (v_claim2->>'id')::uuid,
    (v_claim2->>'claim_token')::uuid,
    30, 5, 'v1:' || repeat('a', 64), 'v1'
  );
  perform public.test_assert((v_begin2->>'allowed')::boolean = false, 'beginSend rejects when task scope removed');
  perform public.test_assert(v_begin2->>'state' = 'cancelled' and v_begin2->>'reason_code' = 'tasks_scope_revoked', 'cancelled with tasks_scope_revoked');

  -- Delete ev3 from classroom_task_events (as disable_classroom_tasks in 018 does):
  -- trigger must cancel pending delivery while keeping the ledger row intact.
  delete from public.classroom_task_events where id = v_ev3;
  perform public.test_assert(
    (select count(*) = 1 and bool_and(state = 'cancelled' and cancel_requested = true and last_error_code = 'event_deleted')
       from public.classroom_notification_deliveries
       where event_id = v_ev3),
    'deleting classroom_task_events cancels pending delivery without deleting ledger row'
  );
end;
$$;

reset role;
