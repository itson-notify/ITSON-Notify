// ITN-50 / ITN-44 - Pruebas del ledger aditivo de entregas de notificaciones de
// Google Classroom (019_classroom_notification_deliveries.sql), repositorio,
// servicio consumidor y adaptadores tipados de email (Resend) y web_push.
// Sin red real; datos 100% sintéticos.
const { test, describe } = require("node:test");
const assert = require("node:assert/strict");
const crypto = require("node:crypto");

const {
  createClassroomDeliveryRepository,
  ClassroomLedgerError,
} = require("../../src/repositories/classroomDeliveryRepository");
const {
  processClassroomDeliveries,
  createClassroomEmailTransport,
  createClassroomWebPushTransport,
  computeRecipientFingerprint,
  formatClassroomTaskMessage,
  toClassroomDeliveryNotif,
  RESEND_IDEMPOTENCY_TTL_MS,
} = require("../../src/services/classroomDeliveryService");

const COURSES_SCOPE = "https://www.googleapis.com/auth/classroom.courses.readonly";
const WORK_SCOPE_A = "https://www.googleapis.com/auth/classroom.coursework.me.readonly";
const WORK_SCOPE_B = "https://www.googleapis.com/auth/classroom.student-submissions.me.readonly";
const SECRET = "secreto-hmac-pruebas-classroom-ledger-019";

const T0 = Date.parse("2026-11-20T15:00:00.000Z");
const iso = (offsetMs = 0) => new Date(T0 + offsetMs).toISOString();

// Simulador en memoria de las tablas 006/008/011/014/016/017/019 y de las 4 RPCs +
// trigger de 019_classroom_notification_deliveries.sql para pruebas deterministas.
function createLedgerTestHarness({ nowMs = T0 } = {}) {
  let clock = nowMs;
  const nowIso = () => new Date(clock).toISOString();

  const tables = {
    app_users: [],
    google_authorizations: [],
    google_app_sessions: [],
    push_subscriptions: [],
    classroom_courses: [],
    classroom_coursework: [],
    classroom_task_events: [],
    classroom_notification_deliveries: [],
  };

  let nextRpcError = null;
  const activeClaims = new Set();
  const lockTraces = [];

  function recordLockTrace(op, locks) {
    lockTraces.push({ op, locks });
  }

  function hasWorkScope(scopeStr) {
    const tokens = String(scopeStr ?? "").split(" ").filter(Boolean);
    return tokens.includes(COURSES_SCOPE) && (tokens.includes(WORK_SCOPE_A) || tokens.includes(WORK_SCOPE_B));
  }

  // Simula el trigger BEFORE DELETE ON classroom_task_events de la migración 019
  function deleteTaskEvent(eventId) {
    const idx = tables.classroom_task_events.findIndex((e) => e.id === eventId);
    if (idx === -1) return false;
    for (const d of tables.classroom_notification_deliveries) {
      if (d.source === "classroom" && d.event_id === eventId) {
        if (["pending", "claimed", "retry_wait", "blocked"].includes(d.state)) {
          d.state = "cancelled";
          d.cancel_requested = true;
          d.claim_token = null;
          d.lease_until = null;
          d.last_error_code = d.last_error_code ?? "event_deleted";
          d.updated_at = nowIso();
        } else if (["sending", "unknown"].includes(d.state)) {
          d.cancel_requested = true;
          d.updated_at = nowIso();
        }
      }
    }
    tables.classroom_task_events.splice(idx, 1);
    return true;
  }

  // Simula disable_classroom_tasks(p_user_id) de 018_classroom_tasks_opt_in.sql
  // Orden de candados: app_users -> google_authorizations -> classroom_task_events -> classroom_notification_deliveries
  function disableClassroomTasks(userId) {
    const user = tables.app_users.find((u) => u.id === userId);
    if (!user) return { data: null, error: { code: "42501", message: "classroom_authorization_required" } };
    const auth = tables.google_authorizations.find((a) => a.user_id === userId);
    if (!auth) return { data: null, error: { code: "42501", message: "classroom_authorization_required" } };

    recordLockTrace("disable_classroom_tasks", [
      "app_users",
      "google_authorizations",
      "classroom_task_events",
      "classroom_notification_deliveries",
    ]);

    const keepTokens = String(auth.scope ?? "")
      .split(" ")
      .filter((tok) => Boolean(tok) && tok !== WORK_SCOPE_A && tok !== WORK_SCOPE_B);
    auth.scope = keepTokens.join(" ");

    const userEventIds = tables.classroom_task_events.filter((e) => e.user_id === userId).map((e) => e.id);
    for (const evId of userEventIds) {
      deleteTaskEvent(evId);
    }
    tables.classroom_coursework = tables.classroom_coursework.filter((w) => w.user_id !== userId);
    for (const c of tables.classroom_courses) {
      if (c.user_id === userId) c.coursework_baseline_at = null;
    }
    return { data: { tasks_enabled: false, scope: auth.scope }, error: null };
  }

  function rpc(name, args) {
    if (nextRpcError) {
      const err = nextRpcError;
      nextRpcError = null;
      return { data: null, error: err };
    }

    if (name === "disable_classroom_tasks") {
      return disableClassroomTasks(args?.p_user_id);
    }

    if (name === "materialize_classroom_deliveries") {
      const { p_event_id, p_channels, p_policy_version = "v1" } = args;
      if (!p_event_id) return { data: null, error: { code: "22023", message: "invalid_delivery_event" } };
      if (!Array.isArray(p_channels) || p_channels.length === 0 || p_channels.some((c) => !["email", "web_push"].includes(c))) {
        return { data: null, error: { code: "22023", message: "invalid_delivery_channels" } };
      }
      const channels = ["email", "web_push"].filter((c) => p_channels.includes(c));
      // 1) Lectura de user_id sin candado para respetar orden app_users -> google_authorizations -> evento -> entrega
      const unlockedEvent = tables.classroom_task_events.find((e) => e.id === p_event_id);
      if (!unlockedEvent) return { data: { status: "missing_event", deliveries: [] }, error: null };

      const user = tables.app_users.find((u) => u.id === unlockedEvent.user_id);
      if (!user) return { data: null, error: { code: "42501", message: "classroom_authorization_required" } };

      const auth = tables.google_authorizations.find((a) => a.user_id === unlockedEvent.user_id);
      const event = tables.classroom_task_events.find((e) => e.id === p_event_id && e.user_id === unlockedEvent.user_id);
      if (!event) return { data: { status: "missing_event", deliveries: [] }, error: null };

      recordLockTrace("materialize_classroom_deliveries", [
        "app_users",
        "google_authorizations",
        "classroom_task_events",
        "classroom_notification_deliveries",
      ]);

      const projectMaterialized = (d) => ({
        id: d.id,
        event_id: d.event_id,
        channel: d.channel,
        state: d.state,
        required_channels: [...d.required_channels],
        policy_version: d.policy_version,
        attempts: d.attempts,
        last_error_code: d.last_error_code,
      });

      const existing = tables.classroom_notification_deliveries
        .filter((d) => d.source === "classroom" && d.event_id === p_event_id)
        .sort((a, b) => a.channel.localeCompare(b.channel));
      if (existing.length > 0) {
        return { data: { status: "existing", deliveries: existing.map(projectMaterialized) }, error: null };
      }

      const work = tables.classroom_coursework.find((w) => w.id === event.coursework_id);
      const course = work ? tables.classroom_courses.find((c) => c.id === work.course_id) : null;

      let initialState = "pending";
      let reason = null;
      let googleId = null;
      let authCreatedAt = null;

      if (
        event.event_type !== "classroom.task.created" ||
        !work ||
        !course ||
        work.user_id !== event.user_id ||
        course.user_id !== event.user_id
      ) {
        initialState = "cancelled";
        reason = "owner_or_event_invalid";
      } else if (
        work.state !== "PUBLISHED" ||
        !course.coursework_baseline_at ||
        Date.parse(event.created_at) <= Date.parse(course.coursework_baseline_at)
      ) {
        initialState = "cancelled";
        reason = "event_not_eligible";
      } else if (!auth) {
        initialState = "cancelled";
        reason = "authorization_missing";
      } else {
        googleId = auth.google_id;
        authCreatedAt = auth.created_at;
        if (Date.parse(event.created_at) < Date.parse(auth.created_at)) {
          initialState = "cancelled";
          reason = "backlog_before_grant";
        } else if (!hasWorkScope(auth.scope)) {
          initialState = "cancelled";
          reason = "tasks_scope_missing";
        } else if (auth.status !== "active") {
          initialState = "blocked";
          reason = "needs_relink";
        }
      }

      for (const ch of channels) {
        tables.classroom_notification_deliveries.push({
          id: crypto.randomUUID(),
          user_id: event.user_id,
          source: "classroom",
          event_id: event.id,
          channel: ch,
          required_channels: [...channels],
          policy_version: p_policy_version || "v1",
          authorization_google_id: googleId,
          authorization_created_at: authCreatedAt,
          state: initialState,
          attempts: 0,
          next_attempt_at: nowIso(),
          claim_token: null,
          lease_until: null,
          send_deadline: null,
          cancel_requested: false,
          template_version: "v1",
          payload: null,
          recipient_fingerprint: null,
          idempotency_key: null,
          provider_reference: null,
          last_error_code: reason,
          sent_at: null,
          read_at: null,
          created_at: nowIso(),
          updated_at: nowIso(),
        });
      }

      const created = tables.classroom_notification_deliveries
        .filter((d) => d.source === "classroom" && d.event_id === p_event_id)
        .sort((a, b) => a.channel.localeCompare(b.channel));
      return {
        data: {
          status: initialState === "pending" ? "materialized" : initialState,
          deliveries: created.map(projectMaterialized),
        },
        error: null,
      };
    }

    if (name === "claim_classroom_delivery") {
      const leaseSecs = Math.max(args?.p_lease_seconds ?? 60, 5);
      const maxAttempts = Math.max(args?.p_max_attempts ?? 5, 1);

      // 1) Expire sending -> unknown (never re-claim sending)
      for (const d of tables.classroom_notification_deliveries) {
        if (!activeClaims.has(d.id) && d.state === "sending" && d.send_deadline && Date.parse(d.send_deadline) < clock) {
          d.state = "unknown";
          d.lease_until = null;
          d.send_deadline = null;
          d.last_error_code = d.last_error_code ?? "send_deadline_expired";
          d.updated_at = nowIso();
        }
      }

      // 2) Transition exhausted rows (retry_wait / pending / expired claimed with attempts >= maxAttempts) -> dead
      for (const d of tables.classroom_notification_deliveries) {
        if (
          !activeClaims.has(d.id) &&
          d.attempts >= maxAttempts &&
          (["retry_wait", "pending"].includes(d.state) ||
            (d.state === "claimed" && (!d.lease_until || Date.parse(d.lease_until) < clock)))
        ) {
          d.state = "dead";
          d.claim_token = null;
          d.lease_until = null;
          d.send_deadline = null;
          d.last_error_code = "max_attempts_reached";
          d.updated_at = nowIso();
        }
      }

      // 3) Unblock blocked rows if same authorization recovered to active with task scopes
      for (const d of tables.classroom_notification_deliveries) {
        if (!activeClaims.has(d.id) && d.state === "blocked" && !d.cancel_requested && d.last_error_code === "needs_relink") {
          const auth = tables.google_authorizations.find((a) => a.user_id === d.user_id);
          const ev = tables.classroom_task_events.find((e) => e.id === d.event_id);
          if (
            ev &&
            auth &&
            auth.google_id === d.authorization_google_id &&
            auth.created_at === d.authorization_created_at &&
            auth.status === "active" &&
            hasWorkScope(auth.scope)
          ) {
            d.state = "pending";
            d.last_error_code = null;
            d.next_attempt_at = nowIso();
            d.updated_at = nowIso();
          }
        }
      }

      // 4) FOR UPDATE SKIP LOCKED selection
      const candidates = tables.classroom_notification_deliveries
        .filter((d) => {
          if (activeClaims.has(d.id)) return false;
          if (d.cancel_requested || d.attempts >= maxAttempts) return false;
          if (["pending", "retry_wait"].includes(d.state) && Date.parse(d.next_attempt_at) <= clock) return true;
          if (d.state === "claimed" && d.lease_until && Date.parse(d.lease_until) < clock) return true;
          return false;
        })
        .sort((a, b) => Date.parse(a.next_attempt_at) - Date.parse(b.next_attempt_at) || a.id.localeCompare(b.id));

      const target = candidates[0];
      if (!target) return { data: null, error: null };

      target.state = "claimed";
      target.claim_token = crypto.randomUUID();
      target.lease_until = new Date(clock + leaseSecs * 1000).toISOString();
      target.updated_at = nowIso();
      // Proyección exacta de claim_classroom_delivery en 019_classroom_notification_deliveries.sql
      return {
        data: {
          id: target.id,
          event_id: target.event_id,
          user_id: target.user_id,
          source: target.source,
          channel: target.channel,
          state: target.state,
          attempts: target.attempts,
          claim_token: target.claim_token,
          lease_until: target.lease_until,
          required_channels: [...target.required_channels],
          policy_version: target.policy_version,
        },
        error: null,
      };
    }

    if (name === "begin_classroom_delivery_send") {
      const {
        p_delivery_id,
        p_claim_token,
        p_send_deadline_seconds = 30,
        p_max_attempts = 5,
        p_recipient_fingerprint = null,
        p_template_version = "v1",
      } = args;

      // 1) Lectura de (user_id, event_id) sin candado para adquirir candados en orden:
      // app_users -> google_authorizations -> classroom_task_events -> classroom_notification_deliveries
      const unlockedD = tables.classroom_notification_deliveries.find((r) => r.id === p_delivery_id);
      if (!unlockedD) {
        return { data: { allowed: false, reason_code: "invalid_or_expired_claim" }, error: null };
      }

      const user = tables.app_users.find((u) => u.id === unlockedD.user_id);
      if (!user) return { data: null, error: { code: "42501", message: "classroom_authorization_required" } };

      const auth = tables.google_authorizations.find((a) => a.user_id === unlockedD.user_id);
      const event = tables.classroom_task_events.find((e) => e.id === unlockedD.event_id);
      const d = tables.classroom_notification_deliveries.find((r) => r.id === p_delivery_id);

      recordLockTrace("begin_classroom_delivery_send", [
        "app_users",
        "google_authorizations",
        "classroom_task_events",
        "classroom_notification_deliveries",
      ]);

      if (
        !d ||
        d.state !== "claimed" ||
        !d.claim_token ||
        d.claim_token !== p_claim_token ||
        !d.lease_until ||
        Date.parse(d.lease_until) < clock
      ) {
        return { data: { allowed: false, reason_code: "invalid_or_expired_claim" }, error: null };
      }

      if (d.cancel_requested) {
        d.state = "cancelled";
        d.claim_token = null;
        d.lease_until = null;
        d.last_error_code = "cancel_requested";
        d.updated_at = nowIso();
        return { data: { allowed: false, reason_code: "cancel_requested", state: "cancelled" }, error: null };
      }

      if (d.attempts >= p_max_attempts) {
        d.state = "dead";
        d.claim_token = null;
        d.lease_until = null;
        d.last_error_code = "max_attempts_reached";
        d.updated_at = nowIso();
        return { data: { allowed: false, reason_code: "max_attempts_reached", state: "dead" }, error: null };
      }

      const work = event ? tables.classroom_coursework.find((w) => w.id === event.coursework_id) : null;
      const course = work ? tables.classroom_courses.find((c) => c.id === work.course_id) : null;

      if (
        !event ||
        !work ||
        !course ||
        event.user_id !== d.user_id ||
        work.user_id !== d.user_id ||
        course.user_id !== d.user_id ||
        event.event_type !== "classroom.task.created" ||
        work.state !== "PUBLISHED" ||
        !course.coursework_baseline_at ||
        Date.parse(event.created_at) <= Date.parse(course.coursework_baseline_at)
      ) {
        d.state = "cancelled";
        d.claim_token = null;
        d.lease_until = null;
        d.last_error_code = "event_no_longer_valid";
        d.updated_at = nowIso();
        return { data: { allowed: false, reason_code: "event_no_longer_valid", state: "cancelled" }, error: null };
      }

      if (
        !auth ||
        auth.google_id !== d.authorization_google_id ||
        auth.created_at !== d.authorization_created_at ||
        Date.parse(event.created_at) < Date.parse(auth.created_at)
      ) {
        d.state = "cancelled";
        d.claim_token = null;
        d.lease_until = null;
        d.last_error_code = "authorization_revoked";
        d.updated_at = nowIso();
        return { data: { allowed: false, reason_code: "authorization_revoked", state: "cancelled" }, error: null };
      }

      if (!hasWorkScope(auth.scope)) {
        d.state = "cancelled";
        d.claim_token = null;
        d.lease_until = null;
        d.last_error_code = "tasks_scope_revoked";
        d.updated_at = nowIso();
        return { data: { allowed: false, reason_code: "tasks_scope_revoked", state: "cancelled" }, error: null };
      }

      if (auth.status !== "active") {
        d.state = "blocked";
        d.claim_token = null;
        d.lease_until = null;
        d.last_error_code = "needs_relink";
        d.updated_at = nowIso();
        return { data: { allowed: false, reason_code: "needs_relink", state: "blocked" }, error: null };
      }

      if (d.recipient_fingerprint && p_recipient_fingerprint && d.recipient_fingerprint !== p_recipient_fingerprint) {
        d.state = "cancelled";
        d.claim_token = null;
        d.lease_until = null;
        d.last_error_code = "recipient_changed";
        d.updated_at = nowIso();
        return { data: { allowed: false, reason_code: "recipient_changed", state: "cancelled" }, error: null };
      }

      d.payload = d.payload ?? {
        course_name: course.name,
        task_title: work.title,
        due_at: work.due_at ?? null,
        alternate_link: work.alternate_link ?? null,
      };
      d.idempotency_key = d.idempotency_key ?? `classroom:${d.source}:${d.event_id}:${d.channel}`;
      d.recipient_fingerprint = d.recipient_fingerprint ?? p_recipient_fingerprint;
      d.template_version = p_template_version || d.template_version;
      d.state = "sending";
      d.attempts += 1;
      d.send_deadline = new Date(clock + Math.max(p_send_deadline_seconds, 5) * 1000).toISOString();
      d.updated_at = nowIso();

      return {
        data: {
          allowed: true,
          delivery_id: d.id,
          event_id: d.event_id,
          user_id: d.user_id,
          channel: d.channel,
          claim_token: d.claim_token,
          attempts: d.attempts,
          idempotency_key: d.idempotency_key,
          recipient_fingerprint: d.recipient_fingerprint,
          recipient_email: auth.email,
          authorization_google_id: auth.google_id,
          payload: structuredClone(d.payload),
          created_at: d.created_at,
          send_deadline: d.send_deadline,
        },
        error: null,
      };
    }

    if (name === "ack_classroom_delivery") {
      const {
        p_delivery_id,
        p_claim_token,
        p_outcome,
        p_provider_reference = null,
        p_error_code = null,
        p_retry_delay_seconds = 60,
        p_max_attempts = 5,
      } = args;

      // 1) Lectura sin candado de (user_id, event_id) y bloqueo en orden canónico:
      // app_users -> google_authorizations -> classroom_task_events -> classroom_notification_deliveries
      const unlockedD = tables.classroom_notification_deliveries.find((r) => r.id === p_delivery_id);
      if (!unlockedD) {
        return { data: { acknowledged: false, reason_code: "token_mismatch" }, error: null };
      }

      const user = tables.app_users.find((u) => u.id === unlockedD.user_id);
      if (!user) return { data: null, error: { code: "42501", message: "classroom_authorization_required" } };

      tables.google_authorizations.find((a) => a.user_id === unlockedD.user_id);
      const ev = tables.classroom_task_events.find((e) => e.id === unlockedD.event_id);
      const d = tables.classroom_notification_deliveries.find((r) => r.id === p_delivery_id);

      recordLockTrace("ack_classroom_delivery", [
        "app_users",
        "google_authorizations",
        "classroom_task_events",
        "classroom_notification_deliveries",
      ]);

      if (!d || !d.claim_token || d.claim_token !== p_claim_token) {
        return { data: { acknowledged: false, reason_code: "token_mismatch" }, error: null };
      }
      if (d.state === "sent" && p_outcome === "sent") {
        return { data: { acknowledged: true, state: "sent", idempotent: true, event_delivered: false }, error: null };
      }
      if (!["sending", "unknown", "claimed"].includes(d.state)) {
        return { data: { acknowledged: false, reason_code: "invalid_state_transition" }, error: null };
      }
      // ack con 'sent', 'unknown' o 'retry_wait' solo se permite desde 'sending' o 'unknown' (no desde 'claimed')
      if (["sent", "unknown", "retry_wait"].includes(p_outcome) && !["sending", "unknown"].includes(d.state)) {
        return { data: { acknowledged: false, reason_code: "invalid_state_transition" }, error: null };
      }

      const validError = typeof p_error_code === "string" && /^[a-z0-9_]{1,64}$/.test(p_error_code) ? p_error_code : null;
      let newState;
      let keepToken = null;
      let errCode = validError;

      if (p_outcome === "sent") {
        newState = "sent";
        d.sent_at = d.sent_at ?? nowIso();
        errCode = null;
        keepToken = d.claim_token;
      } else if (p_outcome === "retry_wait") {
        if (d.cancel_requested) {
          newState = "cancelled";
          errCode = errCode ?? "cancel_requested";
        } else if (d.attempts >= p_max_attempts) {
          newState = "dead";
          errCode = errCode ?? "max_attempts_reached";
        } else {
          newState = "retry_wait";
          d.next_attempt_at = new Date(clock + Math.max(p_retry_delay_seconds, 1) * 1000).toISOString();
          errCode = errCode ?? "transient_error";
        }
      } else if (p_outcome === "unknown") {
        newState = "unknown";
        errCode = errCode ?? "ambiguous_delivery";
        keepToken = d.claim_token;
      } else if (p_outcome === "dead") {
        newState = "dead";
        errCode = errCode ?? "permanent_rejection";
      } else if (p_outcome === "blocked") {
        newState = d.cancel_requested ? "cancelled" : "blocked";
        errCode = errCode ?? (d.cancel_requested ? "cancel_requested" : "blocked");
      } else if (p_outcome === "cancelled") {
        newState = "cancelled";
        errCode = errCode ?? "cancelled";
      } else if (p_outcome === "release" && d.state === "claimed") {
        newState = d.cancel_requested ? "cancelled" : "pending";
      } else {
        return { data: null, error: { code: "22023", message: "invalid_delivery_outcome" } };
      }

      d.state = newState;
      d.claim_token = keepToken;
      d.lease_until = null;
      d.send_deadline = null;
      if (p_provider_reference) d.provider_reference = p_provider_reference;
      d.last_error_code = errCode;
      d.updated_at = nowIso();

      let eventDelivered = false;
      if (newState === "sent") {
        const req = d.required_channels;
        const rows = tables.classroom_notification_deliveries.filter(
          (r) => r.source === d.source && r.event_id === d.event_id && req.includes(r.channel),
        );
        if (req.length > 0 && rows.length === req.length && rows.every((r) => r.state === "sent")) {
          if (ev) {
            ev.delivered_at = ev.delivered_at ?? nowIso();
            eventDelivered = true;
          }
        }
      }

      return { data: { acknowledged: true, state: newState, event_delivered: eventDelivered }, error: null };
    }

    return { data: null, error: { code: "42883", message: `unknown rpc ${name}` } };
  }

  const supabase = {
    rpc: async (name, args) => rpc(name, args),
    from(tableName) {
      let rows = tables[tableName] ?? [];
      let filters = [];
      let isUpdate = null;

      const builder = {
        select() {
          return builder;
        },
        update(patch) {
          isUpdate = patch;
          return builder;
        },
        eq(col, val) {
          filters.push((r) => r[col] === val);
          return builder;
        },
        is(col, val) {
          filters.push((r) => (r[col] ?? null) === val);
          return builder;
        },
        or(expr) {
          const parts = expr.split(",").map((p) => p.split(".eq."));
          filters.push((r) => parts.some(([col, val]) => r[col] === val));
          return builder;
        },
        order(col, { ascending = true } = {}) {
          const dir = ascending ? 1 : -1;
          const prev = rows;
          rows = [...prev].sort((a, b) => String(a[col] ?? "").localeCompare(String(b[col] ?? "")) * dir);
          return builder;
        },
        limit(n) {
          filters.push((_, idx) => idx < n);
          return builder;
        },
        async maybeSingle() {
          if (nextRpcError) {
            const err = nextRpcError;
            nextRpcError = null;
            return { data: null, error: err };
          }
          const matched = rows.filter((r) => filters.every((fn) => fn(r, 0)));
          return { data: matched[0] ? { ...matched[0] } : null, error: null };
        },
        then(resolve, reject) {
          if (nextRpcError) {
            const err = nextRpcError;
            nextRpcError = null;
            return Promise.resolve({ data: null, error: err }).then(resolve, reject);
          }
          let matched = rows.filter((r) => filters.every((fn, i) => (fn.length === 2 ? true : fn(r))));
          if (isUpdate) {
            for (const r of matched) Object.assign(r, isUpdate);
          }
          const limitFilter = filters.find((fn) => fn.length === 2);
          if (limitFilter) matched = matched.filter((r, idx) => limitFilter(r, idx));
          return Promise.resolve({ data: matched.map((r) => ({ ...r })), error: null }).then(resolve, reject);
        },
      };
      return builder;
    },
  };

  const pushRepo = {
    async purgeRevokedPushSubscriptions(userId) {
      const revokedIds = new Set(
        tables.google_app_sessions.filter((s) => s.user_id === userId && s.revoked_at != null).map((s) => s.id),
      );
      tables.push_subscriptions = tables.push_subscriptions.filter(
        (sub) => !(sub.user_id === userId && sub.session_id && revokedIds.has(sub.session_id)),
      );
    },
    async listPushSubscriptions(userId) {
      return tables.push_subscriptions.filter((s) => s.user_id === userId);
    },
    async deletePushSubscription(userId, endpoint) {
      tables.push_subscriptions = tables.push_subscriptions.filter(
        (s) => !(s.user_id === userId && s.endpoint === endpoint),
      );
    },
  };

  return {
    tables,
    supabase,
    pushRepo,
    repo: createClassroomDeliveryRepository(supabase, { pushRepo }),
    lockTraces,
    disableClassroomTasks,
    advanceClock(ms) {
      clock += ms;
    },
    now: () => clock,
    failNextSql(error) {
      nextRpcError = error;
    },
    lockDeliveryRow(id) {
      activeClaims.add(id);
    },
    unlockDeliveryRow(id) {
      activeClaims.delete(id);
    },
    deleteTaskEvent,
  };
}

function seedStudentWithEvent(
  h,
  {
    userId = crypto.randomUUID(),
    googleId = "google-student-1",
    email = "alumna.real@potros.itson.edu.mx",
    scope = `${COURSES_SCOPE} ${WORK_SCOPE_A}`,
    authStatus = "active",
    authCreatedAt = iso(-3600_000),
    baselineAt = iso(-1800_000),
    eventCreatedAt = iso(-60_000),
    taskState = "PUBLISHED",
    courseName = "Ingeniería de Software II",
    taskTitle = "Entrega de Arquitectura",
    dueAt = "2026-11-25T06:59:00.000Z",
    alternateLink = "https://classroom.google.com/c/123/a/456/details",
    withPush = false,
  } = {},
) {
  const courseId = crypto.randomUUID();
  const workId = crypto.randomUUID();
  const eventId = crypto.randomUUID();

  if (!h.tables.app_users.some((u) => u.id === userId)) {
    h.tables.app_users.push({ id: userId, email });
  }
  const existingAuthIdx = h.tables.google_authorizations.findIndex((a) => a.user_id === userId);
  const authRow = {
    user_id: userId,
    google_id: googleId,
    email,
    scope,
    status: authStatus,
    refresh_token: "cifrado",
    created_at: authCreatedAt,
  };
  if (existingAuthIdx >= 0) h.tables.google_authorizations[existingAuthIdx] = authRow;
  else h.tables.google_authorizations.push(authRow);

  h.tables.classroom_courses.push({
    id: courseId,
    user_id: userId,
    external_course_id: `ext-c-${courseId.slice(0, 6)}`,
    name: courseName,
    coursework_baseline_at: baselineAt,
  });
  h.tables.classroom_coursework.push({
    id: workId,
    user_id: userId,
    course_id: courseId,
    external_coursework_id: `ext-w-${workId.slice(0, 6)}`,
    title: taskTitle,
    state: taskState,
    due_at: dueAt,
    alternate_link: alternateLink,
  });
  h.tables.classroom_task_events.push({
    id: eventId,
    user_id: userId,
    coursework_id: workId,
    event_type: "classroom.task.created",
    created_at: eventCreatedAt,
    delivered_at: null,
  });

  if (withPush) {
    h.tables.push_subscriptions.push({
      id: crypto.randomUUID(),
      user_id: userId,
      session_id: "sess-1",
      endpoint: `https://push.service.invalid/sub/${userId}`,
      p256dh: "p256dh-key",
      auth: "auth-key",
    });
  }

  return { userId, googleId, email, courseId, workId, eventId };
}

describe("ITN-50 / ITN-44 - Materialización y manifiesto congelado", () => {
  test("1. Materialización repetida crea una fila por evento/canal y congela required_channels", async () => {
    const h = createLedgerTestHarness();
    const { eventId } = seedStudentWithEvent(h, { withPush: true });

    const first = await h.repo.materializeEvent({
      eventId,
      channels: ["web_push", "email"],
      policyVersion: "v1",
    });
    assert.equal(first.status, "materialized");
    assert.equal(first.deliveries.length, 2);
    assert.deepEqual(first.deliveries.map((d) => d.channel), ["email", "web_push"]);
    assert.deepEqual(first.deliveries[0].required_channels, ["email", "web_push"]);

    // Segunda llamada intentando cambiar a solo ['email'] no altera el manifiesto
    const second = await h.repo.materializeEvent({
      eventId,
      channels: ["email"],
      policyVersion: "v2",
    });
    assert.equal(second.status, "existing");
    assert.equal(second.deliveries.length, 2);
    assert.deepEqual(second.deliveries[0].required_channels, ["email", "web_push"]);
    assert.equal(second.deliveries[0].policy_version, "v1");
  });

  test("rechaza canales vacíos o desconocidos (no éxito vacío)", async () => {
    const h = createLedgerTestHarness();
    const { eventId } = seedStudentWithEvent(h);
    await assert.rejects(
      () => h.repo.materializeEvent({ eventId, channels: [] }),
      (err) => err instanceof ClassroomLedgerError && err.status === 400,
    );
    await assert.rejects(
      () => h.repo.materializeEvent({ eventId, channels: ["log"] }),
      (err) => err instanceof ClassroomLedgerError && err.status === 400,
    );
  });

  test("cancela eventos de baseline, tareas en borrador, backlog anterior al grant o sin scope de tareas", async () => {
    const h = createLedgerTestHarness();
    // (a) Evento anterior o igual al baseline del curso
    const baseEv = seedStudentWithEvent(h, { baselineAt: iso(0), eventCreatedAt: iso(-1000) });
    // (b) Evento anterior al created_at de la autorización Google actual (backlog)
    const backlogEv = seedStudentWithEvent(h, { authCreatedAt: iso(-10_000), eventCreatedAt: iso(-50_000) });
    // (c) Cuenta que solo tiene scope de cursos (sin coursework.me.readonly)
    const noScopeEv = seedStudentWithEvent(h, { scope: COURSES_SCOPE });

    for (const [ev, expectedReason] of [
      [baseEv, "event_not_eligible"],
      [backlogEv, "backlog_before_grant"],
      [noScopeEv, "tasks_scope_missing"],
    ]) {
      const plan = await h.repo.materializeEvent({ eventId: ev.eventId, channels: ["email"] });
      assert.equal(plan.status, "cancelled");
      assert.equal(plan.deliveries[0].state, "cancelled");
      assert.equal(plan.deliveries[0].last_error_code, expectedReason);
      const eventRow = h.tables.classroom_task_events.find((e) => e.id === ev.eventId);
      assert.equal(eventRow.delivered_at, null, "cancelled no marca delivered_at");
    }
  });
});

describe("ITN-50 / ITN-44 - Exclusión, leases, sending -> unknown y ACK", () => {
  test("2. Dos consumidores concurrentes reclaman: uno gana (SKIP LOCKED) y el otro progresa con otro alumno", async () => {
    const h = createLedgerTestHarness();
    const s1 = seedStudentWithEvent(h, { email: "s1@potros.itson.edu.mx" });
    const s2 = seedStudentWithEvent(h, { email: "s2@potros.itson.edu.mx", googleId: "google-student-2" });

    await h.repo.materializeEvent({ eventId: s1.eventId, channels: ["email"] });
    h.advanceClock(10);
    await h.repo.materializeEvent({ eventId: s2.eventId, channels: ["email"] });

    const c1 = await h.repo.claimNextDelivery({ leaseSeconds: 60 });
    assert.ok(c1);
    assert.equal(c1.event_id, s1.eventId);

    // Mientras c1 tiene la reserva activa, el segundo consumidor toma s2 (nunca s1)
    const c2 = await h.repo.claimNextDelivery({ leaseSeconds: 60 });
    assert.ok(c2);
    assert.equal(c2.event_id, s2.eventId);
    assert.notEqual(c1.id, c2.id);

    const c3 = await h.repo.claimNextDelivery({ leaseSeconds: 60 });
    assert.equal(c3, null);
  });

  test("3. Reserva claimed vencida se recupera sin incrementar attempts y bloquea al consumidor viejo; sending vencido pasa a unknown y jamás se reclama", async () => {
    const h = createLedgerTestHarness();
    const { eventId } = seedStudentWithEvent(h);
    await h.repo.materializeEvent({ eventId, channels: ["email"] });

    const oldClaim = await h.repo.claimNextDelivery({ leaseSeconds: 30 });
    assert.equal(oldClaim.attempts, 0);

    // Vence la lease antes de beginSend
    h.advanceClock(35_000);
    const newClaim = await h.repo.claimNextDelivery({ leaseSeconds: 30 });
    assert.equal(newClaim.id, oldClaim.id);
    assert.notEqual(newClaim.claim_token, oldClaim.claim_token);
    assert.equal(newClaim.attempts, 0, "recuperar reserva sin I/O no incrementa attempts");

    // El consumidor viejo intenta beginSend con el token expirado: rechazado
    const oldBegin = await h.repo.beginSend({
      deliveryId: oldClaim.id,
      claimToken: oldClaim.claim_token,
    });
    assert.equal(oldBegin.allowed, false);
    assert.equal(oldBegin.reason_code, "invalid_or_expired_claim");

    // El consumidor nuevo pasa beginSend -> state = 'sending', attempts = 1
    const newBegin = await h.repo.beginSend({
      deliveryId: newClaim.id,
      claimToken: newClaim.claim_token,
      sendDeadlineSeconds: 20,
    });
    assert.equal(newBegin.allowed, true);
    assert.equal(newBegin.attempts, 1);

    // Vence send_deadline mientras está en 'sending'
    h.advanceClock(25_000);
    const afterSendingExpired = await h.repo.claimNextDelivery({ leaseSeconds: 30 });
    assert.equal(afterSendingExpired, null, "sending jamás se vuelve a reclamar");

    const row = h.tables.classroom_notification_deliveries[0];
    assert.equal(row.state, "unknown");
    assert.equal(row.last_error_code, "send_deadline_expired");

    // Un ACK tardío del mismo intento con su claim_token sí puede resolver unknown -> sent
    const lateAck = await h.repo.ackDelivery({
      deliveryId: newClaim.id,
      claimToken: newClaim.claim_token,
      outcome: "sent",
      providerReference: "resend-late-ok",
    });
    assert.equal(lateAck.acknowledged, true);
    assert.equal(lateAck.state, "sent");
    assert.equal(lateAck.event_delivered, true);

    // Un ACK repetido del mismo intento es idempotente
    const dupAck = await h.repo.ackDelivery({
      deliveryId: newClaim.id,
      claimToken: newClaim.claim_token,
      outcome: "sent",
    });
    assert.equal(dupAck.acknowledged, true);
    assert.equal(dupAck.idempotent, true);
  });
});

describe("ITN-50 / ITN-44 - Semántica de transportes, Idempotency-Key y multi-canal", () => {
  test("4 y 5. Resend envía Idempotency-Key estable; reintenta timeout dentro del TTL y pasa a unknown fuera del TTL", async () => {
    const h = createLedgerTestHarness();
    const { eventId } = seedStudentWithEvent(h);

    const calls = [];
    let mode = "timeout";
    const emailTransport = createClassroomEmailTransport({
      apiKey: "re_test_key_123",
      fetchImpl: async (url, options) => {
        calls.push({ url, headers: options.headers, body: JSON.parse(options.body) });
        if (mode === "timeout") {
          const err = new Error("Request timed out con datos privados");
          err.name = "TimeoutError";
          throw err;
        }
        return {
          ok: true,
          status: 200,
          json: async () => ({ id: "re_msg_999" }),
        };
      },
    });

    // Intento 1: timeout dentro de la ventana de 23h de Idempotency-Key -> retry_wait
    const r1 = await processClassroomDeliveries({
      repo: h.repo,
      transports: { email: emailTransport },
      secret: SECRET,
      now: h.now,
      randomFn: () => 0,
    });
    assert.equal(r1.retryWait, 1);
    assert.equal(calls.length, 1);
    const firstKey = calls[0].headers["Idempotency-Key"];
    assert.equal(firstKey, `classroom:classroom:${eventId}:email`);

    // Avanzamos el reloj para que venza next_attempt_at (pero aún dentro de las 23h)
    h.advanceClock(60_000);
    mode = "ok";
    const r2 = await processClassroomDeliveries({
      repo: h.repo,
      transports: { email: emailTransport },
      secret: SECRET,
      now: h.now,
    });
    assert.equal(r2.sent, 1);
    assert.equal(r2.eventsDelivered, 1);
    assert.equal(calls.length, 2);
    assert.equal(calls[1].headers["Idempotency-Key"], firstKey, "conserva exactamente la misma Idempotency-Key");
    assert.equal(calls[0].body.text, calls[1].body.text, "payload inmutable entre reintentos");

    // Si ocurre un timeout después de que expiró el TTL de idempotencia -> unknown (sin retry automático)
    const ev2 = seedStudentWithEvent(h, { email: "otra@potros.itson.edu.mx", googleId: "g-2" });
    mode = "timeout";
    await h.repo.materializeEvent({ eventId: ev2.eventId, channels: ["email"] });
    h.advanceClock(RESEND_IDEMPOTENCY_TTL_MS + 60_000);

    const r3 = await processClassroomDeliveries({
      repo: h.repo,
      transports: { email: emailTransport },
      secret: SECRET,
      now: h.now,
    });
    assert.equal(r3.unknown, 1);
    const row2 = h.tables.classroom_notification_deliveries.find((d) => d.event_id === ev2.eventId);
    assert.equal(row2.state, "unknown");
    assert.equal(row2.last_error_code, "resend_ambiguous_timeout");
  });

  test("6. Multi-canal: email sent y web_push fallido no reenvía email ni marca delivered_at hasta que ambos estén sent", async () => {
    const h = createLedgerTestHarness();
    const { userId, eventId } = seedStudentWithEvent(h, { withPush: true });
    // Agregamos un segundo dispositivo que responde 410 (debe purgarse)
    h.tables.push_subscriptions.push({
      id: crypto.randomUUID(),
      user_id: userId,
      session_id: "sess-1",
      endpoint: "https://push.service.invalid/gone",
      p256dh: "k1",
      auth: "a1",
    });

    let emailCalls = 0;
    let pushFailTransient = true;
    const pushPayloads = [];

    const emailTransport = createClassroomEmailTransport({
      apiKey: "re_key",
      fetchImpl: async () => {
        emailCalls += 1;
        return { ok: true, status: 200, json: async () => ({ id: "re_1" }) };
      },
    });
    const webPushTransport = createClassroomWebPushTransport({
      vapidPublicKey: "pub",
      vapidPrivateKey: "priv",
      pushRepo: h.pushRepo,
      webpushImpl: {
        setVapidDetails() {},
        async sendNotification(sub, body) {
          if (sub.endpoint.endsWith("/gone")) {
            const err = new Error("Gone");
            err.statusCode = 410;
            throw err;
          }
          if (pushFailTransient) {
            const err = new Error("Push 503");
            err.statusCode = 503;
            throw err;
          }
          pushPayloads.push(JSON.parse(body));
        },
      },
    });

    // Corrida 1: email se envía, push falla con 503 (y purga el endpoint 410)
    const run1 = await processClassroomDeliveries({
      repo: h.repo,
      transports: { email: emailTransport, web_push: webPushTransport },
      secret: SECRET,
      now: h.now,
      randomFn: () => 0,
    });
    assert.equal(run1.sent, 1);
    assert.equal(run1.retryWait, 1);
    assert.equal(run1.eventsDelivered, 0);
    assert.equal(emailCalls, 1);
    assert.equal(h.tables.classroom_task_events[0].delivered_at, null, "delivered_at sigue NULL");
    assert.equal(h.tables.push_subscriptions.length, 1, "el endpoint 410 fue eliminado");

    // Corrida 2 tras backoff: solo se reintenta web_push; email NO se vuelve a enviar
    h.advanceClock(60_000);
    pushFailTransient = false;
    const run2 = await processClassroomDeliveries({
      repo: h.repo,
      transports: { email: emailTransport, web_push: webPushTransport },
      secret: SECRET,
      now: h.now,
    });
    assert.equal(run2.sent, 1);
    assert.equal(run2.eventsDelivered, 1);
    assert.equal(emailCalls, 1, "email no se reenvió");
    assert.ok(h.tables.classroom_task_events[0].delivered_at, "delivered_at ya quedó marcado");
    assert.equal(pushPayloads[0].tag, `itson-classroom-task-${eventId}`);
  });
});

describe("ITN-50 / ITN-44 - Revocación, desactivación (018), cambio de destinatario y privacidad", () => {
  test("7. Desactivar tareas (borrado de evento o retiro del scope de tareas) o cambiar correo antes de beginSend cancela sin enviar", async () => {
    const h = createLedgerTestHarness();
    const s1 = seedStudentWithEvent(h, { email: "uno@potros.itson.edu.mx", googleId: "g-1" });
    const s2 = seedStudentWithEvent(h, { email: "dos@potros.itson.edu.mx", googleId: "g-2" });

    await h.repo.materializeEvent({ eventId: s1.eventId, channels: ["email"] });
    await h.repo.materializeEvent({ eventId: s2.eventId, channels: ["email"] });

    // s1 desactiva tareas como en disable_classroom_tasks (018): quita scope y borra evento
    h.tables.google_authorizations.find((a) => a.user_id === s1.userId).scope = COURSES_SCOPE;
    h.deleteTaskEvent(s1.eventId);

    const s1Ledger = h.tables.classroom_notification_deliveries.find((d) => d.event_id === s1.eventId);
    assert.ok(s1Ledger, "la fila del ledger se conserva para auditoría");
    assert.equal(s1Ledger.state, "cancelled");
    assert.equal(s1Ledger.cancel_requested, true);

    // s2 falla el primer intento y luego cambia el correo en google_authorizations:
    // el segundo intento debe cancelarse por recipient_changed sin reutilizar la clave para otro correo
    let sentEmails = 0;
    let shouldFail = true;
    const transport = createClassroomEmailTransport({
      apiKey: "re_key",
      fetchImpl: async () => {
        if (shouldFail) return { ok: false, status: 429, json: async () => ({}) };
        sentEmails += 1;
        return { ok: true, status: 200, json: async () => ({ id: "ok" }) };
      },
    });

    await processClassroomDeliveries({
      repo: h.repo,
      transports: { email: transport },
      secret: SECRET,
      now: h.now,
      randomFn: () => 0,
    });
    // Cambia el correo del grant antes del reintento
    h.tables.google_authorizations.find((a) => a.user_id === s2.userId).email = "otro.correo@potros.itson.edu.mx";
    h.advanceClock(60_000);
    shouldFail = false;

    const r2 = await processClassroomDeliveries({
      repo: h.repo,
      transports: { email: transport },
      secret: SECRET,
      now: h.now,
    });
    assert.equal(sentEmails, 0, "no envía al nuevo correo bajo la misma entrega");
    assert.equal(r2.cancelled, 1);
    const s2Ledger = h.tables.classroom_notification_deliveries.find((d) => d.event_id === s2.eventId);
    assert.equal(s2Ledger.state, "cancelled");
    assert.equal(s2Ledger.last_error_code, "recipient_changed");
  });

  test("9 y 12. Errores SQL de infraestructura fallan cerrado, logs no contienen PII y toClassroomDeliveryNotif formatea para la app", async () => {
    const h = createLedgerTestHarness();
    const { userId, email, eventId } = seedStudentWithEvent(h, {
      email: "privada.alumna@potros.itson.edu.mx",
      courseName: "Materia Secreta",
      taskTitle: "Tarea Confidencial",
    });

    const logLines = [];
    const logger = {
      info: (ev, meta) => logLines.push(JSON.stringify({ ev, meta })),
      warn: (ev, meta) => logLines.push(JSON.stringify({ ev, meta })),
      error: (ev, meta) => logLines.push(JSON.stringify({ ev, meta })),
    };

    const transport = createClassroomEmailTransport({
      apiKey: "re_secret_api_key",
      fetchImpl: async () => ({ ok: true, status: 200, json: async () => ({ id: "re_ref_1" }) }),
    });

    await processClassroomDeliveries({
      repo: h.repo,
      transports: { email: transport },
      secret: SECRET,
      logger,
      now: h.now,
    });

    const allLogs = logLines.join("\n");
    for (const forbidden of [userId, email, "Materia Secreta", "Tarea Confidencial", "re_secret_api_key"]) {
      assert.equal(allLogs.includes(forbidden), false, `El log no debe incluir: ${forbidden}`);
    }

    // Lector aditivo para la bandeja de la app (GET /api/notifications)
    const deliveredRows = await h.repo.listStudentDeliveredEvents(userId);
    assert.equal(deliveredRows.length, 1);
    const notif = toClassroomDeliveryNotif(deliveredRows[0]);
    assert.equal(notif.id, eventId);
    assert.equal(notif.type, "tareas");
    assert.equal(notif.title, "Nueva tarea publicada");
    assert.equal(notif.subject, "Materia Secreta");
    assert.equal(notif.unread, true);
    assert.ok(notif.body.includes("Tarea Confidencial en Materia Secreta"));

    // Marcar como leída
    assert.equal(await h.repo.markDeliveryRead(userId, eventId, iso(5000)), true);
    const afterRead = await h.repo.listStudentDeliveredEvents(userId);
    assert.equal(toClassroomDeliveryNotif(afterRead[0]).unread, false);

    // Error 42501 genérico (ACL/RLS) lanza 500 error_interno; 42883 lanza 503
    h.failNextSql({ code: "42501", message: "permission denied for table classroom_notification_deliveries" });
    await assert.rejects(
      () => h.repo.claimNextDelivery(),
      (err) => err instanceof ClassroomLedgerError && err.status === 500 && err.code === "error_interno",
    );

    h.failNextSql({ code: "42883", message: "function claim_classroom_delivery does not exist" });
    await assert.rejects(
      () => h.repo.claimNextDelivery(),
      (err) => err instanceof ClassroomLedgerError && err.status === 503 && err.code === "classroom_migracion_requerida",
    );
  });

  test("13. ack con 'sent' se rechaza desde 'claimed' (solo válido desde 'sending' o 'unknown') y retry_wait con attempts al máximo pasa a 'dead' en claim", async () => {
    const h = createLedgerTestHarness();
    const { eventId } = seedStudentWithEvent(h);
    await h.repo.materializeEvent({ eventId, channels: ["email"] });

    const claimed = await h.repo.claimNextDelivery({ leaseSeconds: 60 });
    assert.ok(claimed);
    assert.equal(claimed.state, "claimed");

    // (a) Intentar ack con 'sent' directo desde 'claimed' (sin pasar por beginSend) se rechaza
    const badAck = await h.repo.ackDelivery({
      deliveryId: claimed.id,
      claimToken: claimed.claim_token,
      outcome: "sent",
      providerReference: "resend-skip-begin",
    });
    assert.equal(badAck.acknowledged, false);
    assert.equal(badAck.reason_code, "invalid_state_transition");
    assert.equal(
      h.tables.classroom_notification_deliveries[0].state,
      "claimed",
      "la entrega permanece en claimed",
    );

    // (b) Si una fila quedó en retry_wait con attempts >= maxAttempts, claim_classroom_delivery la pasa a 'dead'
    const row = h.tables.classroom_notification_deliveries[0];
    row.state = "retry_wait";
    row.attempts = 5;
    row.claim_token = null;
    row.lease_until = null;
    row.next_attempt_at = new Date(h.now() - 1000).toISOString();

    const nextClaim = await h.repo.claimNextDelivery({ leaseSeconds: 60, maxAttempts: 5 });
    assert.equal(nextClaim, null, "no reclama una entrega con attempts al máximo");
    assert.equal(row.state, "dead");
    assert.equal(row.last_error_code, "max_attempts_reached");
  });

  test("14. Orden canónico de candados (app_users -> google_authorizations -> classroom_task_events -> classroom_notification_deliveries) evita deadlocks con disable_classroom_tasks", async () => {
    const CANONICAL_LOCK_ORDER = [
      "app_users",
      "google_authorizations",
      "classroom_task_events",
      "classroom_notification_deliveries",
    ];

    // Escenario A: materialize vs disable_classroom_tasks
    {
      const h = createLedgerTestHarness();
      const { userId, eventId } = seedStudentWithEvent(h);
      await h.repo.materializeEvent({ eventId, channels: ["email"] });
      h.disableClassroomTasks(userId);

      assert.deepEqual(
        h.lockTraces.map((t) => t.locks),
        [CANONICAL_LOCK_ORDER, CANONICAL_LOCK_ORDER],
      );
      assert.equal(h.tables.classroom_task_events.length, 0);
      assert.equal(h.tables.classroom_notification_deliveries[0].state, "cancelled");
      assert.equal(h.tables.classroom_notification_deliveries[0].cancel_requested, true);
    }

    // Escenario A inverso: disable_classroom_tasks antes de materialize
    {
      const h = createLedgerTestHarness();
      const { userId, eventId } = seedStudentWithEvent(h);
      h.disableClassroomTasks(userId);
      const plan = await h.repo.materializeEvent({ eventId, channels: ["email"] });
      assert.equal(plan.status, "missing_event");
      assert.equal(h.tables.classroom_notification_deliveries.length, 0);
    }

    // Escenario B: disable_classroom_tasks vs beginSend (en ambos órdenes)
    {
      const h = createLedgerTestHarness();
      const { userId, eventId } = seedStudentWithEvent(h);
      await h.repo.materializeEvent({ eventId, channels: ["email"] });
      const claimed = await h.repo.claimNextDelivery({ leaseSeconds: 60 });

      h.lockTraces.length = 0;
      h.disableClassroomTasks(userId);
      const Gate = await h.repo.beginSend({
        deliveryId: claimed.id,
        claimToken: claimed.claim_token,
      });
      assert.equal(Gate.allowed, false);
      assert.equal(h.tables.classroom_notification_deliveries[0].state, "cancelled");
      assert.deepEqual(
        h.lockTraces.map((t) => t.locks),
        [CANONICAL_LOCK_ORDER, CANONICAL_LOCK_ORDER],
      );
    }

    // Escenario C: disable_classroom_tasks mientras la entrega está en 'sending' y luego llega ack('sent') o ack('retry_wait')
    {
      const h = createLedgerTestHarness();
      const { userId, eventId } = seedStudentWithEvent(h);
      await h.repo.materializeEvent({ eventId, channels: ["email", "web_push"] });

      const cEmail = await h.repo.claimNextDelivery({ leaseSeconds: 60 });
      const cPush = await h.repo.claimNextDelivery({ leaseSeconds: 60 });
      await h.repo.beginSend({ deliveryId: cEmail.id, claimToken: cEmail.claim_token });
      await h.repo.beginSend({ deliveryId: cPush.id, claimToken: cPush.claim_token });

      h.lockTraces.length = 0;
      // El usuario desactiva tareas mientras ambos canales están en vuelo ('sending')
      h.disableClassroomTasks(userId);

      // Email ya salió al proveedor y confirma 'sent': se registra 'sent' para auditoría
      const ackEmail = await h.repo.ackDelivery({
        deliveryId: cEmail.id,
        claimToken: cEmail.claim_token,
        outcome: "sent",
        providerReference: "re_inflight_ok",
      });
      assert.equal(ackEmail.acknowledged, true);
      assert.equal(ackEmail.state, "sent");

      // Web push tuvo fallo transitorio y pide 'retry_wait': al tener cancel_requested=true pasa a 'cancelled' (no reintenta)
      const ackPush = await h.repo.ackDelivery({
        deliveryId: cPush.id,
        claimToken: cPush.claim_token,
        outcome: "retry_wait",
        errorCode: "push_503",
      });
      assert.equal(ackPush.acknowledged, true);
      assert.equal(ackPush.state, "cancelled");

      for (const trace of h.lockTraces) {
        assert.deepEqual(trace.locks, CANONICAL_LOCK_ORDER);
      }
    }
  });

  test("15. Regresión TTL de idempotencia Resend: contrato RPC exacto (created_at), falta de fecha falla cerrado como unknown y timeout posterior al TTL nunca reintenta", async () => {
    // (a) Verificar que las 4 RPCs del mock proyectan exactamente los mismos campos que PostgreSQL 019
    const h = createLedgerTestHarness();
    const { eventId } = seedStudentWithEvent(h);
    const mat = await h.repo.materializeEvent({ eventId, channels: ["email"] });
    assert.deepEqual(Object.keys(mat.deliveries[0]).sort(), [
      "attempts",
      "channel",
      "event_id",
      "id",
      "last_error_code",
      "policy_version",
      "required_channels",
      "state",
    ]);

    const claim = await h.repo.claimNextDelivery({ leaseSeconds: 60 });
    assert.deepEqual(Object.keys(claim).sort(), [
      "attempts",
      "channel",
      "claim_token",
      "event_id",
      "id",
      "lease_until",
      "policy_version",
      "required_channels",
      "source",
      "state",
      "user_id",
    ]);

    const begin = await h.repo.beginSend({
      deliveryId: claim.id,
      claimToken: claim.claim_token,
      sendDeadlineSeconds: 30,
      recipientFingerprint: computeRecipientFingerprint({
        channel: "email",
        email: "alumna.real@potros.itson.edu.mx",
        secret: SECRET,
      }),
    });
    assert.deepEqual(Object.keys(begin).sort(), [
      "allowed",
      "attempts",
      "authorization_google_id",
      "channel",
      "claim_token",
      "created_at",
      "delivery_id",
      "event_id",
      "idempotency_key",
      "payload",
      "recipient_email",
      "recipient_fingerprint",
      "send_deadline",
      "user_id",
    ]);
    assert.equal(begin.created_at, h.tables.classroom_notification_deliveries[0].created_at);

    // (b) Si falta created_at o es una fecha inválida / futura fuera de margen, el transporte
    // Resend DEBE fallar cerrado como 'unknown' (jamás hacer fallback a now())
    for (const badCreatedAt of [undefined, null, "", "fecha-invalida", iso(10 * 60_000)]) {
      const timeoutTransport = createClassroomEmailTransport({
        apiKey: "re_test_key",
        fetchImpl: async () => {
          const err = new Error("Timeout");
          err.name = "TimeoutError";
          throw err;
        },
      });
      const rTimeout = await timeoutTransport.send(
        formatClassroomTaskMessage(begin.payload),
        { ...begin, created_at: badCreatedAt },
        { now: () => T0 + 1_000 },
      );
      assert.equal(rTimeout.status, "unknown", `timeout con created_at=${String(badCreatedAt)} debe ser unknown`);
      assert.equal(rTimeout.errorCode, "resend_ambiguous_timeout");

      const serverErrTransport = createClassroomEmailTransport({
        apiKey: "re_test_key",
        fetchImpl: async () => ({ ok: false, status: 502, json: async () => ({}) }),
      });
      const r502 = await serverErrTransport.send(
        formatClassroomTaskMessage(begin.payload),
        { ...begin, created_at: badCreatedAt },
        { now: () => T0 + 1_000 },
      );
      assert.equal(r502.status, "unknown", `502 con created_at=${String(badCreatedAt)} debe ser unknown`);
      assert.equal(r502.errorCode, "resend_ambiguous_after_ttl");
    }

    // (c) Regresión completa: timeout posterior al TTL (incluido cruce del TTL durante el timeout)
    // deja la entrega en 'unknown' y una corrida posterior de processClassroomDeliveries NO reintenta.
    const h2 = createLedgerTestHarness();
    const { eventId: evId2 } = seedStudentWithEvent(h2);
    await h2.repo.materializeEvent({ eventId: evId2, channels: ["email"] });

    // Avanzamos el reloj hasta 5 segundos antes del límite del TTL y el timeout tarda 10 segundos,
    // cruzando la frontera del TTL durante el vuelo.
    h2.advanceClock(RESEND_IDEMPOTENCY_TTL_MS - 5_000);
    let fetchCalls = 0;
    const crossingTimeoutTransport = createClassroomEmailTransport({
      apiKey: "re_test_key",
      fetchImpl: async () => {
        fetchCalls += 1;
        h2.advanceClock(10_000);
        const err = new Error("Timeout crossing TTL");
        err.name = "TimeoutError";
        throw err;
      },
    });

    const run1 = await processClassroomDeliveries({
      repo: h2.repo,
      transports: { email: crossingTimeoutTransport },
      secret: SECRET,
      now: h2.now,
    });
    assert.equal(fetchCalls, 1);
    assert.equal(run1.unknown, 1);
    assert.equal(run1.retryWait, 0);
    assert.equal(run1.enviados, 0);
    assert.equal(h2.tables.classroom_notification_deliveries[0].state, "unknown");
    assert.equal(h2.tables.classroom_notification_deliveries[0].last_error_code, "resend_ambiguous_timeout");
    assert.equal(h2.tables.classroom_task_events[0].delivered_at, null);

    // Siguiente corrida tras avanzar el reloj: jamás vuelve a reclamar ni enviar
    h2.advanceClock(120_000);
    const run2 = await processClassroomDeliveries({
      repo: h2.repo,
      transports: { email: crossingTimeoutTransport },
      secret: SECRET,
      now: h2.now,
    });
    assert.equal(fetchCalls, 1, "no debe reintentar una entrega que pasó a unknown tras vencer el TTL");
    assert.equal(run2.claimed, 0);
  });
});
