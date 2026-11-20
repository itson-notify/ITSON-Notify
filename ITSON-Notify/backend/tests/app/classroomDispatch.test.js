// ITN-50 - POST /internal/classroom/dispatch con supertest y el Supabase simulado.
// Datos inventados: títulos, materias y correos sintéticos marcados como PRIVADO
// para comprobar que nunca llegan a logs ni respuestas.
const { test, describe } = require("node:test");
const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const request = require("supertest");

const { createApp } = require("../../src/app");
const { loadConfig } = require("../../src/config/env");
const { createLogger } = require("../../src/utils/logger");
const { logChannel } = require("../../src/services/notificationChannels");
const { MAX_ATTEMPTS } = require("../../src/services/notificationService");
const { classroomNotificationId } = require("../../src/repositories/classroomDispatchRepository");
const { sessionHash } = require("../../src/middleware/studentSession");
const { encrypt } = require("../../src/utils/secureToken");
const { createFakeSupabase } = require("../helpers/fakeSupabase");
const { API_KEY, CREDENTIALS_KEY } = require("../helpers/payloads");

const RUTA = "/internal/classroom/dispatch";
const SECRET = "clave-de-pruebas-despacho-classroom-".repeat(2);
const T0 = Date.parse("2026-11-19T12:00:00Z");
const hora = (n) => new Date(T0 + n * 60 * 60 * 1000).toISOString();
const uuid = () => crypto.randomUUID();

const TITULO = "PRIVADO Tarea secreta 7";
const MATERIA = "PRIVADO Materia secreta";
const EMAIL = "privado.alumna@example.test";
const ALUMNA = { userId: uuid(), googleId: "google-a", sessionId: "sesion-a" };

// Canal que guarda lo enviado; `falla.activo` lo hace lanzar con datos sensibles.
function canal(name) {
  const falla = { activo: false };
  const enviados = [];
  return {
    falla,
    enviados,
    channel: {
      name,
      async send(message, meta) {
        if (falla.activo) throw new Error(`Rechazado ${EMAIL} (${message.text})`);
        enviados.push({ message, meta });
      },
    },
  };
}

function setup({ enabled = true, extra = [] } = {}) {
  const db = createFakeSupabase();
  const logs = [];
  const logger = createLogger((line) => logs.push(line));
  const log = canal("web_push");
  const app = createApp({
    config: {
      internalApiKey: API_KEY,
      credentialsEncryptionKey: CREDENTIALS_KEY,
      googleAuthSecret: SECRET,
      classroomDispatchEnabled: enabled,
    },
    supabase: db.client,
    logger,
    now: () => T0,
    // El canal log real (para revisar sus líneas) más canales espía.
    channels: [logChannel(logger), log.channel, ...extra.map((c) => c.channel)],
  });
  db.tables.app_users.push({ id: ALUMNA.userId, email: EMAIL });
  const despachar = () => request(app).post(RUTA).set("x-api-key", API_KEY).send({});
  return { db, app, logs, spy: log, despachar };
}

// Curso con baseline, una tarea y su evento del outbox.
function tarea(db, { baselineAt = hora(-48), eventAt = hora(-1), dueAt = "2026-11-21T06:59:00Z", state = "PUBLISHED", userId = ALUMNA.userId } = {}) {
  const course = { id: uuid(), user_id: userId, external_course_id: uuid(), name: MATERIA, coursework_baseline_at: baselineAt };
  const work = { id: uuid(), user_id: userId, course_id: course.id, external_coursework_id: uuid(), title: TITULO, due_at: dueAt, state };
  const event = { id: uuid(), user_id: userId, coursework_id: work.id, created_at: eventAt, delivered_at: null };
  db.tables.classroom_courses.push(course);
  db.tables.classroom_coursework.push(work);
  db.tables.classroom_task_events.push(event);
  return { course, work, event };
}

const sinPrivados = (texto) => assert.doesNotMatch(texto, /PRIVADO|privado\.alumna|secreta/);

describe("POST /internal/classroom/dispatch", () => {
  test("bandera apagada: 404 sin tocar la base", async () => {
    const s = setup({ enabled: false });
    tarea(s.db);
    const res = await s.despachar();
    assert.equal(res.status, 404);
    assert.deepEqual(res.body, { error: "no_encontrado" });
    assert.deepEqual(s.db.calls, []);
    assert.equal(s.spy.enviados.length, 0);
  });

  test("bandera ausente en la config (pruebas armadas a mano): apagada", async () => {
    const db = createFakeSupabase();
    const app = createApp({
      config: { internalApiKey: API_KEY, credentialsEncryptionKey: CREDENTIALS_KEY },
      supabase: db.client,
      logger: createLogger(() => {}),
      channels: [logChannel(createLogger(() => {}))],
    });
    const res = await request(app).post(RUTA).set("x-api-key", API_KEY).send({});
    assert.equal(res.status, 404);
    assert.deepEqual(db.calls, []);
  });

  test("401 sin llave o con llave incorrecta, antes de parsear el body y sin tocar la base", async () => {
    const s = setup();
    tarea(s.db);
    const sin = await request(s.app).post(RUTA).set("Content-Type", "application/json").send("{no es json");
    const mala = await request(s.app).post(RUTA).set("x-api-key", "otra").send({});
    assert.equal(sin.status, 401);
    assert.equal(mala.status, 401);
    assert.deepEqual(sin.body, { error: "no_autorizado" });
    assert.deepEqual(s.db.calls, []);
    assert.equal(s.spy.enviados.length, 0);
  });

  test("envía el aviso por cada canal, marca el evento y responde solo conteos", async () => {
    const s = setup();
    const { event } = tarea(s.db);
    const res = await s.despachar();
    assert.equal(res.status, 200);
    assert.equal(res.headers["cache-control"], "no-store");
    assert.deepEqual(res.body, { procesados: 1, enviados: 1, fallidos: 0 });
    assert.equal(s.spy.enviados.length, 1);
    const { message, meta } = s.spy.enviados[0];
    assert.equal(message.subject, "ITSON Notify: nueva tarea");
    assert.equal(
      message.text,
      `Nueva tarea publicada: ${TITULO} en ${MATERIA}. Fecha de entrega: viernes 20 de noviembre de 2026, 23:59 (hora de Hermosillo).`,
    );
    assert.deepEqual(meta, { userId: ALUMNA.userId, classroomTaskEventId: event.id });
    assert.equal(s.db.tables.classroom_task_events[0].delivered_at, new Date(T0).toISOString());
    const filas = s.db.tables.notifications_log;
    assert.equal(filas.length, 2);
    assert.ok(filas.every((f) => f.status === "sent" && f.grade_change_id === null && f.user_id === ALUMNA.userId));
    assert.deepEqual(filas.map((f) => f.id).sort(), ["log", "web_push"].map((c) => classroomNotificationId(event.id, c)).sort());
    assert.equal(filas[0].payload.source, "classroom");
    assert.equal(filas[0].payload.classroom_task_event_id, event.id);
  });

  test("idempotente: dos corridas no duplican avisos ni filas", async () => {
    const s = setup();
    tarea(s.db);
    const r1 = await s.despachar();
    const r2 = await s.despachar();
    assert.deepEqual(r1.body, { procesados: 1, enviados: 1, fallidos: 0 });
    assert.deepEqual(r2.body, { procesados: 0, enviados: 0, fallidos: 0 });
    assert.equal(s.spy.enviados.length, 1);
    assert.equal(s.db.tables.notifications_log.length, 2);
  });

  test("idempotente aunque el evento no se haya podido marcar: no reenvía", async () => {
    const s = setup();
    tarea(s.db);
    s.db.failNext("classroom_task_events", "update");
    const r1 = await s.despachar();
    assert.deepEqual(r1.body, { procesados: 1, enviados: 0, fallidos: 1 });
    assert.equal(s.db.tables.classroom_task_events[0].delivered_at, null);
    const r2 = await s.despachar();
    assert.deepEqual(r2.body, { procesados: 1, enviados: 1, fallidos: 0 });
    assert.equal(s.spy.enviados.length, 1);
    assert.equal(s.db.tables.notifications_log.length, 2);
  });

  test("un canal que falla no tumba el despacho; se reintenta solo ese canal", async () => {
    const email = canal("email");
    const s = setup({ extra: [email] });
    tarea(s.db);
    tarea(s.db, { eventAt: hora(-0.5) });
    email.falla.activo = true;
    const r1 = await s.despachar();
    assert.equal(r1.status, 200);
    assert.deepEqual(r1.body, { procesados: 2, enviados: 0, fallidos: 2 });
    assert.equal(s.spy.enviados.length, 2);
    assert.ok(s.db.tables.classroom_task_events.every((e) => e.delivered_at === null));
    const fallidas = s.db.tables.notifications_log.filter((f) => f.channel === "email");
    assert.ok(fallidas.every((f) => f.status === "failed" && f.attempts === 1));

    email.falla.activo = false;
    const r2 = await s.despachar();
    assert.deepEqual(r2.body, { procesados: 2, enviados: 2, fallidos: 0 });
    assert.equal(s.spy.enviados.length, 2, "los canales que ya salieron no se reenvían");
    assert.equal(email.enviados.length, 2);
    assert.ok(s.db.tables.notifications_log.every((f) => f.status === "sent"));
    assert.equal(s.db.tables.notifications_log.filter((f) => f.channel === "email")[0].attempts, 2);
    assert.ok(s.db.tables.classroom_task_events.every((e) => e.delivered_at !== null));
  });

  test("un canal agotado (MAX_ATTEMPTS) deja de reintentarse y no bloquea el evento", async () => {
    const email = canal("email");
    const s = setup({ extra: [email] });
    tarea(s.db);
    email.falla.activo = true;
    for (let i = 0; i < MAX_ATTEMPTS; i++) await s.despachar();
    const r = await s.despachar();
    assert.deepEqual(r.body, { procesados: 1, enviados: 1, fallidos: 0 });
    assert.equal(s.spy.enviados.length, 1);
    assert.equal(s.db.tables.notifications_log.find((f) => f.channel === "email").attempts, MAX_ATTEMPTS);
  });

  test("baseline nunca se envía: curso sin baseline o evento anterior a ella", async () => {
    const s = setup();
    tarea(s.db, { baselineAt: null });
    tarea(s.db, { baselineAt: hora(-1), eventAt: hora(-2) });
    tarea(s.db, { baselineAt: hora(-1), eventAt: hora(-1) });
    tarea(s.db, { state: "DELETED" });
    const res = await s.despachar();
    assert.deepEqual(res.body, { procesados: 4, enviados: 0, fallidos: 0 });
    assert.equal(s.spy.enviados.length, 0);
    assert.equal(s.db.tables.notifications_log.length, 0);
    // Marcados para que no se queden en la cola.
    assert.ok(s.db.tables.classroom_task_events.every((e) => e.delivered_at !== null));
    assert.deepEqual((await s.despachar()).body, { procesados: 0, enviados: 0, fallidos: 0 });
  });

  test("tarea de otro alumno que la del evento: no se envía", async () => {
    const s = setup();
    const { event } = tarea(s.db);
    event.user_id = uuid();
    const res = await s.despachar();
    assert.deepEqual(res.body, { procesados: 1, enviados: 0, fallidos: 0 });
    assert.equal(s.spy.enviados.length, 0);
  });

  test("sin fecha de entrega: el aviso lo dice", async () => {
    const s = setup();
    tarea(s.db, { dueAt: null });
    await s.despachar();
    assert.equal(s.spy.enviados[0].message.text, `Nueva tarea publicada: ${TITULO} en ${MATERIA}. Sin fecha de entrega.`);
    assert.equal(s.db.tables.notifications_log[0].payload.due_at, null);
  });

  test("privacidad: logs y respuesta solo con ids y conteos, aun con canales fallando", async () => {
    const email = canal("email");
    const s = setup({ extra: [email] });
    const { event } = tarea(s.db);
    email.falla.activo = true;
    const res = await s.despachar();
    const todo = JSON.stringify([res.body, s.logs]);
    sinPrivados(todo);
    assert.doesNotMatch(todo, /Nueva tarea|Hermosillo/);
    const lineas = s.logs.map((l) => JSON.parse(l));
    assert.ok(lineas.some((l) => l.event === "notificacion_enviada" && l.classroom_task_event_id === event.id));
    assert.ok(lineas.some((l) => l.event === "notificacion_fallida" && l.channel === "email"));
    const resumen = lineas.find((l) => l.event === "despacho_classroom");
    assert.deepEqual(
      { procesados: resumen.procesados, enviados: resumen.enviados, fallidos: resumen.fallidos, omitidos: resumen.omitidos },
      { procesados: 1, enviados: 0, fallidos: 1, omitidos: 0 },
    );
  });

  test("migración 017 sin aplicar: 503 controlado sin enviar", async () => {
    const s = setup();
    tarea(s.db);
    s.db.withoutColumn("classroom_courses", "coursework_baseline_at");
    const res = await s.despachar();
    assert.equal(res.status, 503);
    assert.deepEqual(res.body, { error: "classroom_migracion_requerida" });
    assert.equal(s.spy.enviados.length, 0);
    sinPrivados(JSON.stringify(s.logs));
  });

  test("falla al leer la cola: 500 sin detalles", async () => {
    const s = setup();
    tarea(s.db);
    s.db.failNext("classroom_task_events", "select");
    const res = await s.despachar();
    assert.equal(res.status, 500);
    assert.deepEqual(res.body, { error: "error_interno" });
    sinPrivados(JSON.stringify(s.logs));
  });
});

describe("GET /api/notifications con avisos de Classroom", () => {
  function cookie({ userId, googleId, sessionId }, exp = T0 + 60_000) {
    return `itn41_google_session=${encrypt({ userId, googleId, sessionId, exp }, SECRET, "google-session")}`;
  }

  test("el aviso despachado aparece en Avisos con categoría tareas", async () => {
    const s = setup();
    s.db.tables.google_authorizations.push({ user_id: ALUMNA.userId, google_id: ALUMNA.googleId, email: EMAIL, scope: "s", refresh_token: "cifrado" });
    s.db.tables.google_app_sessions.push({ id: sessionHash(ALUMNA.sessionId), user_id: ALUMNA.userId, google_id: ALUMNA.googleId, expires_at: hora(1) });
    tarea(s.db);
    tarea(s.db, { dueAt: null, eventAt: hora(-0.5) });
    await s.despachar();
    // created_at fijo para ordenar: el evento con fecha es el más antiguo.
    const logs = s.db.tables.notifications_log.filter((f) => f.channel === "log");
    logs[0].created_at = hora(-1);
    logs[1].created_at = hora(-0.5);

    const res = await request(s.app).get("/api/notifications").set("Cookie", cookie(ALUMNA));
    assert.equal(res.status, 200);
    assert.equal(res.body.length, 2, "solo las filas del canal log");
    assert.deepEqual(res.body[1], {
      id: logs[0].id,
      type: "tareas",
      title: "Nueva tarea publicada",
      subject: MATERIA,
      time: hora(-1),
      unread: true,
      body: `Nueva tarea publicada: ${TITULO} en ${MATERIA}. Fecha de entrega: viernes 20 de noviembre de 2026, 23:59 (hora de Hermosillo).`,
      rows: [
        { label: "Materia", value: MATERIA },
        { label: "Tarea", value: TITULO },
        { label: "Entrega", value: "viernes 20 de noviembre de 2026, 23:59 (hora de Hermosillo)" },
      ],
    });
    assert.deepEqual(res.body[0].rows.at(-1), { label: "Entrega", value: "Sin fecha de entrega" });

    // Marcar como leído funciona igual que con los de calificaciones.
    const leido = await request(s.app)
      .post(`/api/notifications/${logs[0].id}/read`)
      .set("Cookie", cookie(ALUMNA))
      .set("Origin", "http://localhost:5173");
    assert.ok([200, 204].includes(leido.status));
  });
});

describe("CLASSROOM_DISPATCH_ENABLED", () => {
  const base = () => ({
    PORT: "3000",
    INTERNAL_API_KEY: API_KEY,
    SUPABASE_URL: "https://proyecto-inventado.supabase.test",
    SUPABASE_SERVICE_ROLE_KEY: "rol-de-servicio-sintetico",
    CREDENTIALS_ENCRYPTION_KEY: crypto.randomBytes(32).toString("base64"),
  });

  test("ausente o vacía: apagada", () => {
    assert.equal(loadConfig(base()).classroomDispatchEnabled, false);
    assert.equal(loadConfig({ ...base(), CLASSROOM_DISPATCH_ENABLED: "  " }).classroomDispatchEnabled, false);
  });

  test("lista cerrada true/false/1/0, sin distinguir mayúsculas", () => {
    for (const [v, esperado] of [["true", true], ["1", true], ["TRUE", true], ["false", false], ["0", false]]) {
      assert.equal(loadConfig({ ...base(), CLASSROOM_DISPATCH_ENABLED: v }).classroomDispatchEnabled, esperado);
    }
  });

  test("cualquier otro valor falla el arranque sin repetir el valor", () => {
    for (const v of ["yes", "si", "verdadero-PRIVADO"]) {
      assert.throws(
        () => loadConfig({ ...base(), CLASSROOM_DISPATCH_ENABLED: v }),
        (err) => /CLASSROOM_DISPATCH_ENABLED \(booleano inválido\)/.test(err.message) && !err.message.includes(v),
      );
    }
  });
});
