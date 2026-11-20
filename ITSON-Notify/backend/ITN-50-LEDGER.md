# ITN-50 / ITN-44 — Ledger aditivo de entregas de notificaciones de Google Classroom

Contrato e implementación acordados entre Luis, Julián y Pedro para consumir
`classroom_task_events` (migración `016`, baseline en `017`, autorización de tareas
en `018`) sin acoplar eventos de Classroom a `grade_changes` ni a `notifications_log`.

## 1. Piezas implementadas

* `database/migrations/019_classroom_notification_deliveries.sql`:
  * Tabla `public.classroom_notification_deliveries` con `UNIQUE (source, event_id, channel)`,
    `source = 'classroom'`, `channel in ('email', 'web_push')`, manifiesto congelado
    `required_channels`, `policy_version`, vinculación a la generación del grant
    (`authorization_google_id`, `authorization_created_at`), máquina de estados
    (`pending`, `claimed`, `sending`, `retry_wait`, `blocked`, `unknown`, `sent`,
    `dead`, `cancelled`), `attempts`, `next_attempt_at`, `claim_token`, `lease_until`,
    `send_deadline`, `cancel_requested`, `template_version`, `payload`,
    `recipient_fingerprint` (`^v1:[0-9a-f]{64}$`), `idempotency_key`,
    `provider_reference`, `last_error_code` (`^[a-z0-9_]{1,64}$`), `sent_at`,
    `read_at`, `created_at` y `updated_at`.
  * RLS habilitado sin políticas públicas; permisos revocados a `public`, `anon` y
    `authenticated` y concedidos exclusivamente a `service_role`.
  * Trigger `trg_classroom_task_event_delete` (`BEFORE DELETE ON public.classroom_task_events`):
    compatible con `disable_classroom_tasks` (`018`). Cuando se borran eventos de
    `classroom_task_events` al desactivar tareas, las filas del ledger **no se borran**:
    las entregas `pending/claimed/retry_wait/blocked` pasan atómicamente a `cancelled`
    (`last_error_code = 'event_deleted'`) y las entregas en vuelo (`sending/unknown`)
    marcan `cancel_requested = true`, conservando la auditoría y las llaves de idempotencia.
  * 4 funciones RPC (`security invoker`, `set search_path = pg_catalog, public`, solo `service_role`):
    1. `public.materialize_classroom_deliveries(p_event_id, p_channels, p_policy_version)`
    2. `public.claim_classroom_delivery(p_lease_seconds, p_max_attempts)`
    3. `public.begin_classroom_delivery_send(p_delivery_id, p_claim_token, p_send_deadline_seconds, p_max_attempts, p_recipient_fingerprint, p_template_version)`
    4. `public.ack_classroom_delivery(p_delivery_id, p_claim_token, p_outcome, p_provider_reference, p_error_code, p_retry_delay_seconds, p_max_attempts)`
* `backend/src/repositories/classroomDeliveryRepository.js`:
  * Cliente de las RPCs y lector aditivo de entregas `sent` para la bandeja de la app
    (`listStudentDeliveredEvents`, `markDeliveryRead`, `markAllDeliveriesRead`).
  * Distingue el conflicto de negocio `42501` (`classroom_authorization_required` → `409`)
    de errores reales de privilegios SQL/RLS (`42501` genérico → `500`) y migraciones
    pendientes (`42883`, `PGRST202`, `42P01`, `PGRST205`, `42703` → `503`).
* `backend/src/services/classroomDeliveryService.js`:
  * `processClassroomDeliveries`: materializa planes de eventos pendientes y procesa la
    cola en dos fases (`claim` → `beginSend` → transporte → `ack`).
  * `createClassroomEmailTransport`: usa `google_authorizations.email` validado en
    `beginSend` y envía el header nativo `Idempotency-Key` a Resend. Si ocurre un
    timeout o `5xx` dentro de la ventana certificada de idempotencia, pasa a
    `retry_wait` con la misma llave; fuera de la ventana o sin garantía, pasa a `unknown`.
  * `createClassroomWebPushTransport`: purga sesiones revocadas (`ITN-54`), limpia
    endpoints `404/410`, usa `tag: "itson-classroom-task-<event_id>"` y considera
    `accepted` cuando al menos un dispositivo activo acepta el push.
  * `toClassroomDeliveryNotif`: proyecta entregas `sent` al formato `Notif` (`type: "tareas"`).
* `backend/tests/services/classroomDeliveryService.test.js`,
  `backend/tests/sql/classroomDeliveries.sql` y
  `backend/scripts/verify-classroom-deliveries-sql.cjs`.

## 2. Garantías de exclusión, autorización y finalización

* **Claim atómico en dos fases:** `claim_classroom_delivery` usa `FOR UPDATE OF d SKIP LOCKED`
  y reloj de base de datos (`clock_timestamp()`). Recuperar una reserva `claimed` cuya
  `lease_until` venció emite un `claim_token` nuevo sin incrementar `attempts` e
  impide que el consumidor anterior pase `beginSend`.
* **`sending` jamás se reclama por expiración:** si vence `send_deadline` mientras
  una fila está en `sending`, pasa a `unknown` (`last_error_code = 'send_deadline_expired'`).
  Un ACK tardío con el mismo `claim_token` puede resolver `unknown` a `sent`.
* **Revalidación en `beginSend`:** inmediatamente antes del I/O externo se verifica
  en base de datos que el evento siga existiendo, que `event.user_id = work.user_id = course.user_id`,
  que la tarea siga `PUBLISHED` con `event.created_at > coursework_baseline_at`, y que
  `google_authorizations` esté en `status = 'active'`, conserve la misma generación
  (`google_id`, `created_at`) y tenga el **permiso específico de tareas**
  (`classroom.coursework.me.readonly` o `classroom.student-submissions.me.readonly`)
  además de `classroom.courses.readonly`.
* **`delivered_at` estricto:** `ack_classroom_delivery` solo actualiza
  `classroom_task_events.delivered_at` en la misma transacción cuando existen todas
  las filas de `required_channels` para el evento y todas están en `state = 'sent'`.
  Los estados `blocked`, `unknown`, `dead` y `cancelled` nunca marcan `delivered_at`.
