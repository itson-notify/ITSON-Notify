// ITN-50 / ITN-44 - Pruebas de integración de POST /internal/classroom/dispatch
// sobre processClassroomDeliveries (ledger 019), bandera CLASSROOM_DISPATCH_ENABLED
// apagada por defecto, lista permitida de usuarios (solo Pedro por defecto) y
// bandeja GET /api/notifications. Sin tocar fakeSupabase.js, env.js ni logger.js.
const { test, describe } = require("node:test");
const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const request = require("supertest");

const { createApp } = require("../../src/app");
const { createLogger } = require("../../src/utils/logger");
const {
  createClassroomDeliveryRepository,
} = require("../../src/repositories/classroomDeliveryRepository");
const {
  DEFAULT_CLASSROOM_DISPATCH_ALLOWED_USERS,
  loadClassroomDispatchConfig,
  parseClassroomDispatchFlag,
  parseClassroomDispatchAllowedUsers,
} = require("../../src/services/classroomDeliveryService");
const { sessionHash } = require("../../src/middleware/studentSession");
const { encrypt } = require("../../src/utils/secureToken");
const { API_KEY, CREDENTIALS_KEY } = require("../helpers/payloads");

const RUTA = "/internal/classroom/dispatch";
const SECRET = "clave-de-pruebas-despacho-classroom-019-".repeat(2);
const COURSES_SCOPE = "https://www.googleapis.com/auth/classroom.courses.readonly";
const WORK_SCOPE = "https://www.googleapis.com/auth/classroom.coursework.me.readonly";

const T0 = Date.parse("2026-11-20T15:00:00.000Z");
const iso = (offsetMs = 0) => new Date(T0 + offsetMs).toISOString();

const PEDRO_EMAIL = "pedro.izquierdo252587@potros.itson.edu.mx";
const OTRO_EMAIL = "otro.estudiante999999@potros.itson.edu.mx";
const TITULO_SECRETO = "PRIVADO Tarea Calculo Integral 7";
const MATERIA_SECRETA = "PRIVADO Calculo Integral";

function createDispatchSupabaseHarness({ nowMs = T0 } = {}) {
  let clock = nowMs;
  const nowIso = () => new Date(clock).toISOString();
  let nextError = null;
  let dbCalls = 0;

  const tables = {
    app_users: [],
    google_authorizations: [],
    google_app_sessions: [],
    push_subscriptions: [],
    classroom_courses: [],
    classroom_coursework: [],
    classroom_task_events: [],
    classroom_notification_deliveries: [],
    notifications_log: [],
    grade_changes: [],
    subjects: [],
    student_credentials: [],
  };

  function hasWorkScope(scopeStr) {
    const tokens = String(scopeStr ?? "").split(" ").filter(Boolean);
    return tokens.includes(COURSES_SCOPE) && tokens.includes(WORK_SCOPE);
  }

  function takeError() {
    if (!nextError) return null;
    const err = nextError;
    nextError = null;
    return err;
  }

  function rpc(name, args) {
    dbCalls += 1;
    const err = takeError();
    if (err) return { data: null, error: err };

    if (name === "materialize_classroom_deliveries") {
      const { p_event_id, p_channels, p_policy_version = "v1" } = args;
      const channels = ["email", "web_push"].filter((c) => (p_channels ?? []).includes(c));
      const event = tables.classroom_task_events.find((e) => e.id === p_event_id);
      if (!event) return { data: { status: "missing_event", deliveries: [] }, error: null };

      const existing = tables.classroom_notification_deliveries
        .filter((d) => d.source === "classroom" && d.event_id === p_event_id)
        .sort((a, b) => a.channel.localeCompare(b.channel));
      if (existing.length > 0) {
        return { data: { status: "existing", deliveries: existing.map((d) => ({ ...d })) }, error: null };
      }

      const work = tables.classroom_coursework.find((w) => w.id === event.coursework_id);
      const course = work ? tables.classroom_courses.find((c) => c.id === work.course_id) : null;
      const auth = tables.google_authorizations.find((a) => a.user_id === event.user_id);

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
          deliveries: created.map((d) => ({ ...d })),
        },
        error: null,
      };
    }

    if (name === "claim_classroom_delivery") {
      const leaseSecs = Math.max(args?.p_lease_seconds ?? 60, 5);
      const maxAttempts = Math.max(args?.p_max_attempts ?? 5, 1);

      for (const d of tables.classroom_notification_deliveries) {
        if (d.state === "sending" && d.send_deadline && Date.parse(d.send_deadline) < clock) {
          d.state = "unknown";
          d.lease_until = null;
          d.send_deadline = null;
          d.last_error_code = d.last_error_code ?? "send_deadline_expired";
          d.updated_at = nowIso();
        }
        if (d.attempts >= maxAttempts && ["retry_wait", "pending"].includes(d.state)) {
          d.state = "dead";
          d.claim_token = null;
          d.lease_until = null;
          d.last_error_code = "max_attempts_reached";
          d.updated_at = nowIso();
        }
      }

      const candidates = tables.classroom_notification_deliveries
        .filter((d) => {
          if (d.cancel_requested || d.attempts >= maxAttempts) return false;
          if (["pending", "retry_wait"].includes(d.state) && Date.parse(d.next_attempt_at) <= clock) return true;
          if (d.state === "claimed" && d.lease_until && Date.parse(d.lease_until) < clock) return true;
          return false;
        })
        .sort((a, b) => Date.parse(a.next_attempt_at) - Date.parse(b.next_attempt_at) || a.channel.localeCompare(b.channel));

      const target = candidates[0];
      if (!target) return { data: null, error: null };

      target.state = "claimed";
      target.claim_token = crypto.randomUUID();
      target.lease_until = new Date(clock + leaseSecs * 1000).toISOString();
      target.updated_at = nowIso();
      return { data: { ...target }, error: null };
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

      const d = tables.classroom_notification_deliveries.find((r) => r.id === p_delivery_id);
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

      const event = tables.classroom_task_events.find((e) => e.id === d.event_id);
      const work = event ? tables.classroom_coursework.find((w) => w.id === event.coursework_id) : null;
      const course = work ? tables.classroom_courses.find((c) => c.id === work.course_id) : null;
      const auth = tables.google_authorizations.find((a) => a.user_id === d.user_id);

      if (
        !event ||
        !work ||
        !course ||
        work.state !== "PUBLISHED" ||
        !course.coursework_baseline_at ||
        Date.parse(event.created_at) <= Date.parse(course.coursework_baseline_at)
      ) {
        d.state = "cancelled";
        d.claim_token = null;
        d.lease_until = null;
        d.last_error_code = "event_no_longer_valid";
        return { data: { allowed: false, reason_code: "event_no_longer_valid", state: "cancelled" }, error: null };
      }

      if (!auth || auth.google_id !== d.authorization_google_id || auth.created_at !== d.authorization_created_at) {
        d.state = "cancelled";
        d.claim_token = null;
        d.lease_until = null;
        d.last_error_code = "authorization_revoked";
        return { data: { allowed: false, reason_code: "authorization_revoked", state: "cancelled" }, error: null };
      }

      if (!hasWorkScope(auth.scope)) {
        d.state = "cancelled";
        d.claim_token = null;
        d.lease_until = null;
        d.last_error_code = "tasks_scope_revoked";
        return { data: { allowed: false, reason_code: "tasks_scope_revoked", state: "cancelled" }, error: null };
      }

      if (auth.status !== "active") {
        d.state = "blocked";
        d.claim_token = null;
        d.lease_until = null;
        d.last_error_code = "needs_relink";
        return { data: { allowed: false, reason_code: "needs_relink", state: "blocked" }, error: null };
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

      const d = tables.classroom_notification_deliveries.find((r) => r.id === p_delivery_id);
      if (!d || !d.claim_token || d.claim_token !== p_claim_token) {
        return { data: { acknowledged: false, reason_code: "token_mismatch" }, error: null };
      }
      if (["sent", "unknown", "retry_wait"].includes(p_outcome) && !["sending", "unknown"].includes(d.state)) {
        return { data: { acknowledged: false, reason_code: "invalid_state_transition" }, error: null };
      }

      let newState = p_outcome;
      let keepToken = null;
      let errCode = p_error_code;

      if (p_outcome === "sent") {
        d.sent_at = d.sent_at ?? nowIso();
        errCode = null;
        keepToken = d.claim_token;
      } else if (p_outcome === "retry_wait") {
        if (d.attempts >= p_max_attempts) {
          newState = "dead";
          errCode = "max_attempts_reached";
        } else {
          d.next_attempt_at = new Date(clock + Math.max(p_retry_delay_seconds, 1) * 1000).toISOString();
        }
      } else if (p_outcome === "unknown") {
        keepToken = d.claim_token;
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
          const ev = tables.classroom_task_events.find((e) => e.id === d.event_id);
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
      dbCalls += 1;
      let rows = tables[tableName] ?? [];
      const filters = [];
      let isUpdate = null;
      let limitCount = null;
      const orders = [];

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
        in(col, vals) {
          filters.push((r) => vals.includes(r[col]));
          return builder;
        },
        is(col, val) {
          filters.push((r) => (r[col] ?? null) === val);
          return builder;
        },
        order(col, { ascending = true } = {}) {
          orders.push({ col, dir: ascending ? 1 : -1 });
          return builder;
        },
        limit(n) {
          limitCount = n;
          return builder;
        },
        async maybeSingle() {
          const err = takeError();
          if (err) return { data: null, error: err };
          const matched = rows.filter((r) => filters.every((fn) => fn(r)));
          return { data: matched[0] ? { ...matched[0] } : null, error: null };
        },
        then(resolve, reject) {
          const err = takeError();
          if (err) return Promise.resolve({ data: null, error: err }).then(resolve, reject);
          let matched = rows.filter((r) => filters.every((fn) => fn(r)));
          if (isUpdate) {
            for (const r of matched) Object.assign(r, isUpdate);
          }
          if (orders.length > 0) {
            matched = [...matched].sort((a, b) => {
              for (const { col, dir } of orders) {
                const cmp = String(a[col] ?? "").localeCompare(String(b[col] ?? ""));
                if (cmp !== 0) return cmp * dir;
              }
              return 0;
            });
          }
          if (limitCount !== null) matched = matched.slice(0, limitCount);
          return Promise.resolve({ data: matched.map((r) => ({ ...r })), error: null }).then(resolve, reject);
        },
      };
      return builder;
    },
  };

  return {
    tables,
    supabase,
    repo: createClassroomDeliveryRepository(supabase),
    getDbCalls: () => dbCalls,
    failNext(error) {
      nextError = error;
    },
    advanceClock(ms) {
      clock += ms;
    },
    now: () => clock,
  };
}

function seedStudentAndEvent(
  h,
  {
    userId = crypto.randomUUID(),
    googleId = `g-${userId.slice(0, 8)}`,
    email = PEDRO_EMAIL,
    scope = `${COURSES_SCOPE} ${WORK_SCOPE}`,
    status = "active",
    authCreatedAt = iso(-3600_000),
    baselineAt = iso(-1800_000),
    eventCreatedAt = iso(-60_000),
    taskState = "PUBLISHED",
    courseName = MATERIA_SECRETA,
    taskTitle = TITULO_SECRETO,
    dueAt = "2026-11-21T06:59:00.000Z",
    sessionId = "sess-pilot-1",
  } = {},
) {
  if (!h.tables.app_users.some((u) => u.id === userId)) {
    h.tables.app_users.push({ id: userId, email });
  }
  const authIdx = h.tables.google_authorizations.findIndex((a) => a.user_id === userId);
  const authRow = {
    user_id: userId,
    google_id: googleId,
    email,
    scope,
    status,
    refresh_token: "cifrado",
    created_at: authCreatedAt,
  };
  if (authIdx >= 0) h.tables.google_authorizations[authIdx] = authRow;
  else h.tables.google_authorizations.push(authRow);

  h.tables.google_app_sessions.push({
    id: sessionHash(sessionId),
    user_id: userId,
    google_id: googleId,
    expires_at: iso(3600_000),
    revoked_at: null,
  });

  const courseId = crypto.randomUUID();
  const workId = crypto.randomUUID();
  const eventId = crypto.randomUUID();

  h.tables.classroom_courses.push({
    id: courseId,
    user_id: userId,
    external_course_id: `c-${courseId.slice(0, 6)}`,
    name: courseName,
    coursework_baseline_at: baselineAt,
  });
  h.tables.classroom_coursework.push({
    id: workId,
    user_id: userId,
    course_id: courseId,
    external_coursework_id: `w-${workId.slice(0, 6)}`,
    title: taskTitle,
    state: taskState,
    due_at: dueAt,
    alternate_link: "https://classroom.google.com/c/1/a/2/details",
  });
  h.tables.classroom_task_events.push({
    id: eventId,
    user_id: userId,
    coursework_id: workId,
    event_type: "classroom.task.created",
    created_at: eventCreatedAt,
    delivered_at: null,
  });

  return { userId, googleId, email, sessionId, courseId, workId, eventId };
}

function createTestSetup({
  classroomDispatchEnabled = true,
  classroomDispatchAllowedUsers = undefined,
  emailImpl,
  pushImpl,
} = {}) {
  const h = createDispatchSupabaseHarness();
  const logs = [];
  const logger = createLogger((line) => logs.push(line));
  const sentEmails = [];
  const sentPushes = [];

  const classroomTransports = {
    email: {
      name: "email",
      async send(message, permission, options) {
        if (emailImpl) return emailImpl({ message, permission, options });
        sentEmails.push({ message, permission });
        return { status: "accepted", providerReference: "re_test_1" };
      },
    },
  };
  if (pushImpl) {
    classroomTransports.web_push = {
      name: "web_push",
      async send(message, permission, options) {
        sentPushes.push({ message, permission });
        return pushImpl({ message, permission, options });
      },
    };
  }

  const config = {
    internalApiKey: API_KEY,
    credentialsEncryptionKey: CREDENTIALS_KEY,
    googleAuthSecret: SECRET,
    frontendUrl: "http://localhost:5173",
    classroomDispatchEnabled,
    ...(classroomDispatchAllowedUsers !== undefined ? { classroomDispatchAllowedUsers } : {}),
  };

  const app = createApp({
    config,
    supabase: h.supabase,
    logger,
    now: h.now,
    classroomTransports,
    classroomDeliveryRepo: h.repo,
  });

  const despachar = (body = {}) => request(app).post(RUTA).set("x-api-key", API_KEY).send(body);

  return { h, app, logs, sentEmails, sentPushes, despachar };
}

describe("POST /internal/classroom/dispatch - Autenticación, bandera y lista permitida", () => {
  test("401 sin x-api-key antes de parsear el body y sin tocar la base", async () => {
    const s = createTestSetup();
    const res = await request(s.app)
      .post(RUTA)
      .set("Content-Type", "application/json")
      .send("{json-malformado");
    assert.equal(res.status, 401);
    assert.equal(s.h.getDbCalls(), 0);
  });

  test("404 con CLASSROOM_DISPATCH_ENABLED apagada por defecto y sin tocar la base", async () => {
    const s = createTestSetup({ classroomDispatchEnabled: false });
    seedStudentAndEvent(s.h, { email: PEDRO_EMAIL });
    const callsBefore = s.h.getDbCalls();

    const res = await s.despachar();
    assert.equal(res.status, 404);
    assert.deepEqual(res.body, { error: "no_encontrado" });
    assert.equal(s.h.getDbCalls(), callsBefore, "no consulta Supabase cuando la bandera está apagada");
    assert.equal(s.sentEmails.length, 0);
  });

  test("lista permitida por defecto contiene únicamente el usuario de Pedro y nunca envía a otros estudiantes", async () => {
    assert.deepEqual(DEFAULT_CLASSROOM_DISPATCH_ALLOWED_USERS, [
      "pedro.izquierdo252587@potros.itson.edu.mx",
      "pedro.izquierdo3005@gmail.com",
    ]);

    const s = createTestSetup(); // Usa la lista permitida por defecto (solo Pedro)
    const pedro = seedStudentAndEvent(s.h, { email: PEDRO_EMAIL });
    const otro = seedStudentAndEvent(s.h, { email: OTRO_EMAIL });

    const res = await s.despachar();
    assert.equal(res.status, 200);
    assert.deepEqual(res.body, { procesados: 2, enviados: 1, fallidos: 0 });

    // Solo salió correo a Pedro; nunca al otro estudiante
    assert.equal(s.sentEmails.length, 1);
    assert.equal(s.sentEmails[0].permission.user_id, pedro.userId);
    assert.equal(s.sentEmails[0].permission.recipient_email, PEDRO_EMAIL);

    // El otro estudiante no tiene ninguna entrega materializada ni enviada
    const entregasOtro = s.h.tables.classroom_notification_deliveries.filter((d) => d.user_id === otro.userId);
    assert.equal(entregasOtro.length, 0);

    // Defensa en profundidad: si existía una entrega claimed/pending de otro alumno en la cola, se cancela sin enviar
    s.h.tables.classroom_notification_deliveries.push({
      id: crypto.randomUUID(),
      user_id: otro.userId,
      source: "classroom",
      event_id: otro.eventId,
      channel: "email",
      required_channels: ["email"],
      policy_version: "v1",
      authorization_google_id: otro.googleId,
      authorization_created_at: iso(-3600_000),
      state: "pending",
      attempts: 0,
      next_attempt_at: iso(-1000),
      claim_token: null,
      lease_until: null,
      send_deadline: null,
      cancel_requested: false,
      template_version: "v1",
      payload: null,
      recipient_fingerprint: null,
      idempotency_key: null,
      provider_reference: null,
      last_error_code: null,
      sent_at: null,
      read_at: null,
      created_at: iso(-1000),
      updated_at: iso(-1000),
    });

    const res2 = await s.despachar();
    assert.equal(res2.status, 200);
    assert.equal(s.sentEmails.length, 1, "jamás envía la entrega encolada de otro estudiante");
    const filaOtro = s.h.tables.classroom_notification_deliveries.find((d) => d.user_id === otro.userId);
    assert.equal(filaOtro.state, "cancelled");
    assert.equal(filaOtro.last_error_code, "user_not_allowed");
  });

  test("409 despacho_en_curso si ya hay una corrida activa en la misma instancia", async () => {
    let liberar;
    const bloqueado = new Promise((r) => {
      liberar = r;
    });
    const s = createTestSetup({
      emailImpl: async () => {
        await bloqueado;
        return { status: "accepted", providerReference: "re_slow" };
      },
    });
    seedStudentAndEvent(s.h, { email: PEDRO_EMAIL });

    const p1 = s.despachar().then((r) => r);
    // Damos un turno de microtasks para que p1 entre al handler
    await new Promise((r) => setTimeout(r, 30));
    const res2 = await s.despachar();
    assert.equal(res2.status, 409);
    assert.deepEqual(res2.body, { error: "despacho_en_curso" });

    liberar();
    const res1 = await p1;
    assert.equal(res1.status, 200);
    assert.deepEqual(res1.body, { procesados: 1, enviados: 1, fallidos: 0 });
  });

  test("503 si falta la migración 019 y 500 ante error interno sin filtrar detalles ni PII", async () => {
    const s = createTestSetup();
    seedStudentAndEvent(s.h, { email: PEDRO_EMAIL });

    s.h.failNext({ code: "42883", message: "function materialize_classroom_deliveries does not exist PRIVADO" });
    const res503 = await s.despachar();
    assert.equal(res503.status, 503);
    assert.deepEqual(res503.body, { error: "classroom_migracion_requerida" });

    s.h.failNext({ code: "XX000", message: `fallo con ${PEDRO_EMAIL} y ${TITULO_SECRETO}` });
    const res500 = await s.despachar();
    assert.equal(res500.status, 500);
    assert.deepEqual(res500.body, { error: "error_interno" });

    const todo = JSON.stringify([res503.body, res500.body, s.logs]);
    assert.doesNotMatch(todo, /PRIVADO|potros\.itson/);
  });
});

describe("GET /api/notifications y marcado de lectura con entregas del ledger 019", () => {
  function cookie({ userId, googleId, sessionId }, exp = T0 + 60_000) {
    return `itn41_google_session=${encrypt({ userId, googleId, sessionId, exp }, SECRET, "google-session")}`;
  }

  test("el aviso despachado a Pedro aparece en GET /api/notifications con categoría tareas y se puede marcar leído", async () => {
    const s = createTestSetup();
    const pedro = seedStudentAndEvent(s.h, {
      email: PEDRO_EMAIL,
      courseName: MATERIA_SECRETA,
      taskTitle: TITULO_SECRETO,
      dueAt: "2026-11-21T06:59:00.000Z",
    });

    const disp = await s.despachar();
    assert.equal(disp.status, 200);
    assert.deepEqual(disp.body, { procesados: 1, enviados: 1, fallidos: 0 });

    const res = await request(s.app).get("/api/notifications").set("Cookie", cookie(pedro));
    assert.equal(res.status, 200);
    assert.equal(res.body.length, 1);
    assert.deepEqual(res.body[0], {
      id: pedro.eventId,
      type: "tareas",
      title: "Nueva tarea publicada",
      subject: MATERIA_SECRETA,
      time: new Date(T0).toISOString(),
      unread: true,
      body: `Nueva tarea publicada: ${TITULO_SECRETO} en ${MATERIA_SECRETA}. Fecha de entrega: viernes 20 de noviembre de 2026, 23:59 (hora de Hermosillo).\nEnlace: https://classroom.google.com/c/1/a/2/details`,
      rows: [
        { label: "Materia", value: MATERIA_SECRETA },
        { label: "Tarea", value: TITULO_SECRETO },
        { label: "Entrega", value: "viernes 20 de noviembre de 2026, 23:59 (hora de Hermosillo)" },
      ],
    });

    // Marcar como leído
    const readRes = await request(s.app)
      .post(`/api/notifications/${pedro.eventId}/read`)
      .set("Cookie", cookie(pedro))
      .set("Origin", "http://localhost:5173");
    assert.equal(readRes.status, 204);

    const afterRead = await request(s.app).get("/api/notifications").set("Cookie", cookie(pedro));
    assert.equal(afterRead.body[0].unread, false);
  });
});

describe("Validación de CLASSROOM_DISPATCH_ENABLED y CLASSROOM_DISPATCH_ALLOWED_USERS", () => {
  test("bandera booleana usa lista cerrada true/false/1/0 y rechaza otros valores sin repetirlos", () => {
    assert.equal(loadClassroomDispatchConfig({}).classroomDispatchEnabled, false);
    assert.equal(loadClassroomDispatchConfig({ CLASSROOM_DISPATCH_ENABLED: "  " }).classroomDispatchEnabled, false);

    for (const [raw, expected] of [
      ["true", true],
      ["1", true],
      ["TRUE", true],
      ["false", false],
      ["0", false],
    ]) {
      assert.equal(loadClassroomDispatchConfig({ CLASSROOM_DISPATCH_ENABLED: raw }).classroomDispatchEnabled, expected);
      assert.equal(parseClassroomDispatchFlag(raw).enabled, expected);
    }

    for (const invalid of ["yes", "si", "verdadero-SECRETO"]) {
      assert.throws(
        () => loadClassroomDispatchConfig({ CLASSROOM_DISPATCH_ENABLED: invalid }),
        (err) => /CLASSROOM_DISPATCH_ENABLED \(booleano inválido\)/.test(err.message) && !err.message.includes(invalid),
      );
    }
  });

  test("lista permitida rechaza comodín '*' y normaliza correos/ids en minúsculas", () => {
    assert.deepEqual(parseClassroomDispatchAllowedUsers("*"), []);
    assert.deepEqual(
      parseClassroomDispatchAllowedUsers(" Pedro.Izquierdo252587@potros.itson.edu.mx , * , "),
      ["pedro.izquierdo252587@potros.itson.edu.mx"],
    );
  });
});
