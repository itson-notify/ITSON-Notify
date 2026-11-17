// ITN-56 - Ensayo sintético del aviso de tarea nueva de iVirtual, de punta a punta
// con el Supabase simulado: snapshot A (línea base) y snapshot B (con una tarea
// nueva sin nota y con fecha de entrega) por POST /internal/grade-snapshots, y
// después grade_changes, notifications_log, los canales reales de correo y Web
// Push (con fetch y web-push simulados) y GET /api/notifications.
// Datos inventados: ningún correo, token ni alumno real.
const { test, describe } = require("node:test");
const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const request = require("supertest");

const { createApp } = require("../../src/app");
const { createLogger } = require("../../src/utils/logger");
const { sessionHash } = require("../../src/middleware/studentSession");
const { encrypt } = require("../../src/utils/secureToken");
const { logChannel, emailChannel, webPushChannel } = require("../../src/services/notificationChannels");
const { createNotificationRepository } = require("../../src/repositories/notificationRepository");
const { createFakeSupabase } = require("../helpers/fakeSupabase");
const { API_KEY, CREDENTIALS_KEY, EMAIL, MATERIA_A, payload } = require("../helpers/payloads");

const RUTA = "/internal/grade-snapshots";
const SECRET = "clave-de-pruebas-ensayo-itn56-".repeat(2);
const FRONTEND = "http://localhost:5173";
const T0 = Date.parse("2026-11-19T18:00:00Z");
const hora = (n) => new Date(T0 + n * 60 * 60 * 1000).toISOString();

// Viernes 20 de noviembre, 23:59 en Hermosillo = sábado 21, 06:59 UTC.
const ENTREGA = "2026-11-21T06:59:00.000Z";
const TAREA = "Tarea nueva de prueba";
const TEXTO_ESPERADO =
  `Nueva tarea publicada: ${TAREA} en ${MATERIA_A}. ` +
  "Fecha de entrega: viernes 20 de noviembre de 2026, 23:59 (hora de Hermosillo).";

// Ítem tal como lo arma el worker para una tarea recién creada en Moodle.
const tareaNueva = (extra = {}) => ({
  externalItemId: "9010", label: TAREA, type: "mod", value: null, text: "-", min: 0, max: 100,
  percentage: "-", categoryId: 70, cmid: 3010, hidden: false,
  dueAt: ENTREGA, opensAt: null, closesAt: null, ...extra,
});

function conTarea(body, tarea = tareaNueva()) {
  body.courses[0].items.push(tarea);
  return body;
}

function setup({ sinMigracion = false } = {}) {
  const db = createFakeSupabase();
  if (sinMigracion) {
    for (const c of ["due_at", "opens_at", "closes_at"]) db.withoutColumn("snapshot_grades", c);
  }
  const logs = [];
  const logger = createLogger((line) => logs.push(line));
  const pushRepo = createNotificationRepository(db.client);

  const correos = [];
  const fetchResend = async (url, init) => {
    correos.push({ url, body: JSON.parse(init.body) });
    return new Response(JSON.stringify({ id: "correo-simulado" }), { status: 200 });
  };
  const pushes = [];
  const webpushImpl = {
    setVapidDetails: () => {},
    sendNotification: async (sub, body) => pushes.push({ endpoint: sub.endpoint, body: JSON.parse(body) }),
  };

  const channels = [
    logChannel(logger),
    emailChannel({ apiKey: "re_prueba_sintetica", from: "ITSON Notify <onboarding@resend.dev>", overrideTo: "destino.prueba@example.test", fetchImpl: fetchResend }),
    webPushChannel({ vapidPublicKey: "publica-simulada", vapidPrivateKey: "privada-simulada", pushRepo, webpushImpl }),
  ];
  const app = createApp({
    config: { internalApiKey: API_KEY, credentialsEncryptionKey: CREDENTIALS_KEY, googleAuthSecret: SECRET, frontendUrl: FRONTEND },
    supabase: db.client,
    logger,
    now: () => T0,
    channels,
  });
  const enviar = (body) => request(app).post(RUTA).set("x-api-key", API_KEY).send(body);

  // Sesión de la app y suscripción Push del alumno sintético (después del snapshot A,
  // que es el que crea app_users).
  function alumno() {
    const userId = db.tables.app_users.find((u) => u.email === EMAIL).id;
    const sessionId = "sesion-ensayo";
    db.tables.google_authorizations.push({ user_id: userId, google_id: "google-ensayo", email: EMAIL, scope: "s", refresh_token: "cifrado" });
    db.tables.google_app_sessions.push({ id: sessionHash(sessionId), user_id: userId, google_id: "google-ensayo", expires_at: hora(2) });
    db.tables.push_subscriptions.push({ id: crypto.randomUUID(), user_id: userId, endpoint: "https://push.example.test/ensayo", p256dh: "k", auth: "a" });
    const cookie = `itn41_google_session=${encrypt({ userId, googleId: "google-ensayo", sessionId, exp: T0 + 60_000 }, SECRET, "google-session")}`;
    return { userId, cookie };
  }
  const notificaciones = (cookie) =>
    request(app).get("/api/notifications").set("Origin", FRONTEND).set("Cookie", cookie);

  return { db, logs, enviar, alumno, notificaciones, correos, pushes };
}

describe("ensayo: tarea nueva de iVirtual con fecha de entrega", () => {
  test("A es línea base; B avisa 'Nueva tarea publicada' con la fecha por log, correo y Push", async () => {
    const s = setup();

    const a = await s.enviar(payload({ capturedAt: hora(-2) }));
    assert.equal(a.status, 200);
    assert.equal(a.body.baseline, true);
    assert.equal(a.body.notified, 0);
    const { cookie } = s.alumno();

    const b = await s.enviar(conTarea(payload({ capturedAt: hora(-1) })));
    assert.equal(b.status, 200);
    assert.equal(b.body.baseline, false);
    assert.equal(b.body.failed, 0);
    assert.equal(b.body.notified, 3, "un grupo por log, email y web_push");

    // grade_changes: la tarea nueva y nada más.
    const cambios = s.db.tables.grade_changes;
    assert.ok(cambios.length > 0);
    assert.ok(cambios.every((c) => c.external_item_id === "9010" && c.change_type === "created"));

    // snapshot_grades guarda la fecha.
    const fila = s.db.tables.snapshot_grades.find((g) => g.snapshot_id === b.body.snapshot_id && g.external_item_id === "9010");
    assert.equal(fila.due_at, ENTREGA);
    assert.equal(fila.opens_at, null);

    // notifications_log: una fila por canal, todas enviadas con el mismo texto.
    const log = s.db.tables.notifications_log;
    assert.deepEqual(log.map((r) => r.channel).sort(), ["email", "log", "web_push"]);
    for (const r of log) {
      assert.equal(r.status, "sent");
      assert.ok(r.sent_at);
      assert.equal(r.payload.subject, "ITSON Notify: nueva tarea");
      assert.equal(r.payload.text, TEXTO_ESPERADO);
      assert.equal(r.payload.due_at, ENTREGA);
      assert.ok(!r.payload.text.includes("calificación nueva: -"));
    }

    // Correo (Resend simulado) y Push (web-push simulado).
    assert.equal(s.correos.length, 1);
    assert.equal(s.correos[0].body.subject, "ITSON Notify: nueva tarea");
    assert.equal(s.correos[0].body.text, TEXTO_ESPERADO);
    assert.equal(s.pushes.length, 1);
    assert.equal(s.pushes[0].body.title, "ITSON Notify: nueva tarea");
    assert.equal(s.pushes[0].body.body, TEXTO_ESPERADO);

    // Lo que ve el alumno en la app.
    const res = await s.notificaciones(cookie);
    assert.equal(res.status, 200);
    // La app muestra un aviso por grupo, no uno por canal.
    const avisos = res.body.filter((n) => n.title === "Nueva tarea publicada");
    assert.equal(avisos.length, 1);
    assert.equal(avisos[0].body, TEXTO_ESPERADO);
    assert.equal(avisos[0].subject, MATERIA_A);
    assert.deepEqual(avisos[0].rows.find((r) => r.label === "Entrega"), {
      label: "Entrega",
      value: "viernes 20 de noviembre de 2026, 23:59 (hora de Hermosillo)",
    });

    // Los logs no llevan el correo, la materia ni el texto del aviso.
    const todo = s.logs.join("\n");
    for (const sensible of [EMAIL, MATERIA_A, TAREA, "destino.prueba@example.test"]) {
      assert.ok(!todo.includes(sensible), `el log no debe incluir ${sensible}`);
    }
  });

  test("tarea nueva sin fecha (null): el aviso dice 'Sin fecha de entrega.'", async () => {
    const s = setup();
    await s.enviar(payload({ capturedAt: hora(-2) }));
    const { cookie } = s.alumno();

    await s.enviar(conTarea(payload({ capturedAt: hora(-1) }), tareaNueva({ dueAt: null })));

    assert.equal(s.correos[0].body.text, `Nueva tarea publicada: ${TAREA} en ${MATERIA_A}. Sin fecha de entrega.`);
    const res = await s.notificaciones(cookie);
    const fila = res.body[0].rows.find((r) => r.label === "Entrega");
    assert.deepEqual(fila, { label: "Entrega", value: "Sin fecha de entrega" });
  });

  test("fecha omitida = desconocida: se copia del snapshot anterior; null = sin fecha", async () => {
    const s = setup();
    await s.enviar(conTarea(payload({ capturedAt: hora(-3) })));
    const filaDe = (snapshotId) =>
      s.db.tables.snapshot_grades.find((g) => g.snapshot_id === snapshotId && g.external_item_id === "9010");

    // B: el worker no pudo leer las fechas y las omite.
    const { dueAt, opensAt, closesAt, ...sinFechas } = tareaNueva();
    const b = await s.enviar(conTarea(payload({ capturedAt: hora(-2) }), sinFechas));
    assert.equal(filaDe(b.body.snapshot_id).due_at, ENTREGA, "omitida: se conserva la anterior");
    assert.equal(b.body.changes_detected, 0, "un cambio de fecha no genera avisos");

    // C: Moodle dice que ya no tiene fecha (null explícito).
    const c = await s.enviar(conTarea(payload({ capturedAt: hora(-1) }), tareaNueva({ dueAt: null })));
    assert.equal(filaDe(c.body.snapshot_id).due_at, null, "null: se guarda sin fecha");
    assert.equal(c.body.changes_detected, 0);
  });

  test("sin la migración 013 se guarda el snapshot sin fechas y el aviso sale igual", async () => {
    const s = setup({ sinMigracion: true });
    await s.enviar(payload({ capturedAt: hora(-2) }));
    s.alumno();

    const b = await s.enviar(conTarea(payload({ capturedAt: hora(-1) })));

    assert.equal(b.status, 200);
    assert.equal(b.body.failed, 0);
    assert.ok(s.logs.some((l) => l.includes("fechas_sin_migracion")));
    assert.ok(!s.db.tables.snapshot_grades.some((g) => "due_at" in g));
    // Fecha desconocida: el aviso no inventa "sin fecha".
    assert.equal(s.correos[0].body.text, `Nueva tarea publicada: ${TAREA} en ${MATERIA_A}.`);
  });

  test("itson_api descarta las fechas aunque lleguen", async () => {
    const { payloadItsonApi } = require("../helpers/payloads");
    const s = setup();
    const body = payloadItsonApi({ capturedAt: hora(-1) });
    body.courses[0].items[0].dueAt = ENTREGA;

    const res = await s.enviar(body);

    assert.equal(res.status, 200);
    assert.ok(!s.db.tables.snapshot_grades.some((g) => "due_at" in g));
  });
});
