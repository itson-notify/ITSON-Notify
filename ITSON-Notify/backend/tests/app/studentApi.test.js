// ITN-53 - /api con supertest y el Supabase simulado. Datos inventados.
const { test, describe } = require("node:test");
const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const request = require("supertest");

const { createApp } = require("../../src/app");
const { createLogger } = require("../../src/utils/logger");
const { sessionHash } = require("../../src/middleware/studentSession");
const { encrypt } = require("../../src/utils/secureToken");
const { createFakeSupabase } = require("../helpers/fakeSupabase");
const { API_KEY, CREDENTIALS_KEY } = require("../helpers/payloads");

const SECRET = "clave-de-pruebas-api-alumno-".repeat(2);
const FRONTEND = "http://localhost:5173";
const T0 = Date.parse("2026-11-06T12:00:00Z");
const NOTAS = "materia-secreta 97";

const uuid = () => crypto.randomUUID();
const hora = (n) => new Date(T0 + n * 60 * 60 * 1000).toISOString();
const ALUMNA = { userId: uuid(), googleId: "google-a", email: "alumna@example.test", sessionId: "sesion-a" };
const OTRO = { userId: uuid(), googleId: "google-b", email: "otro@example.test", sessionId: "sesion-b" };

function setup() {
  const db = createFakeSupabase();
  const logs = [];
  const app = createApp({
    config: { internalApiKey: API_KEY, credentialsEncryptionKey: CREDENTIALS_KEY, googleAuthSecret: SECRET, frontendUrl: FRONTEND },
    supabase: db.client,
    logger: createLogger((line) => logs.push(line)),
    now: () => T0,
    channels: [],
  });
  for (const a of [ALUMNA, OTRO]) {
    db.tables.app_users.push({ id: a.userId, email: a.email });
    db.tables.google_authorizations.push({ user_id: a.userId, google_id: a.googleId, email: a.email, scope: "s", refresh_token: "cifrado-secreto" });
    db.tables.google_app_sessions.push({ id: sessionHash(a.sessionId), user_id: a.userId, google_id: a.googleId, expires_at: hora(1) });
  }
  return { db, app, logs };
}

function cookie({ userId, googleId, sessionId }, exp = T0 + 60_000) {
  return `itn41_google_session=${encrypt({ userId, googleId, sessionId, exp }, SECRET, "google-session")}`;
}

// Un aviso con su fila de grade_changes y su materia. `channels` crea una fila de
// notifications_log por canal, como hace notificationService.
function aviso(db, alumno, { horas = 0, read_at = null, change_type = "updated", channels = ["log"], materia = "Cálculo" } = {}) {
  const subjectId = uuid();
  const changeId = uuid();
  db.tables.subjects.push({ id: subjectId, user_id: alumno.userId, name: materia });
  db.tables.grade_changes.push({
    id: changeId, user_id: alumno.userId, subject_id: subjectId, field_name: "grade_value",
    previous_value: change_type === "created" ? null : "80", current_value: change_type === "deleted" ? null : "97", change_type,
  });
  const filas = channels.map((channel) => {
    const fila = {
      id: uuid(), user_id: alumno.userId, grade_change_id: changeId, channel, status: "sent", attempts: 1,
      payload: { subject: "ITSON Notify: cambio de calificación", text: `Tarea en ${materia}: calificación de 80 a 97.`, grade_change_ids: [changeId] },
      created_at: hora(horas), read_at,
    };
    db.tables.notifications_log.push(fila);
    return fila;
  });
  return filas[0];
}

const post = (app, path, alumno = ALUMNA) =>
  request(app).post(path).set("Origin", FRONTEND).set("Cookie", cookie(alumno));

describe("/api sin sesión", () => {
  for (const [metodo, ruta] of [
    ["get", "/api/me"],
    ["get", "/api/notifications"],
    ["post", "/api/notifications/read-all"],
    ["post", `/api/notifications/${uuid()}/read`],
  ]) {
    test(`${metodo} ${ruta.replace(/[0-9a-f-]{36}/, ":id")} responde 401`, async () => {
      const { app } = setup();
      const res = await request(app)[metodo](ruta).set("Origin", FRONTEND);
      assert.equal(res.status, 401);
      assert.deepEqual(res.body, { error: "no_autenticado" });
    });
  }

  test("una sesión caducada, borrada o manipulada responde 401", async () => {
    const { app, db } = setup();
    const caducada = cookie(ALUMNA, T0 - 1);
    assert.equal((await request(app).get("/api/me").set("Cookie", caducada)).status, 401);
    assert.equal((await request(app).get("/api/me").set("Cookie", "itn41_google_session=a.b.c")).status, 401);
    db.tables.google_app_sessions = [];
    assert.equal((await request(app).get("/api/me").set("Cookie", cookie(ALUMNA))).status, 401);
  });
});

describe("CORS y encabezados de /api", () => {
  test("el preflight solo autoriza el origen exacto, con cookies y sin DELETE", async () => {
    const { app } = setup();
    const res = await request(app).options("/api/notifications/read-all").set("Origin", "https://otro.test");
    assert.equal(res.status, 204);
    assert.equal(res.headers["access-control-allow-origin"], FRONTEND);
    assert.equal(res.headers["access-control-allow-credentials"], "true");
    assert.equal(res.headers["access-control-allow-methods"], "GET, POST, OPTIONS");
  });

  test("las respuestas llevan Cache-Control: no-store", async () => {
    const { app } = setup();
    const sin = await request(app).get("/api/me");
    const con = await request(app).get("/api/notifications").set("Cookie", cookie(ALUMNA));
    assert.equal(sin.headers["cache-control"], "no-store");
    assert.equal(con.headers["cache-control"], "no-store");
  });
});

describe("GET /api/me", () => {
  test("devuelve solo email, classroomConnected e itsonStatus", async () => {
    const { app, db } = setup();
    db.tables.student_credentials.push({
      user_id: ALUMNA.userId, portal: "ivirtual", kind: "ivirtual_token", status: "active",
      ciphertext: "\\xdeadbeef", nonce: "\\x00", auth_tag: "\\x00",
    });
    const res = await request(app).get("/api/me").set("Cookie", cookie(ALUMNA));
    assert.equal(res.status, 200);
    assert.deepEqual(res.body, { email: ALUMNA.email, classroomConnected: true, itsonStatus: "ok" });
  });

  test("sin credencial es ok; needs_relink es error", async () => {
    const { app, db } = setup();
    const pedir = () => request(app).get("/api/me").set("Cookie", cookie(ALUMNA));
    assert.equal((await pedir()).body.itsonStatus, "ok");
    db.tables.student_credentials.push({ user_id: ALUMNA.userId, portal: "ivirtual", kind: "ivirtual_token", status: "needs_relink" });
    assert.equal((await pedir()).body.itsonStatus, "error");
  });

  test("una credencial de Classroom o de otro alumno no cambia itsonStatus", async () => {
    const { app, db } = setup();
    db.tables.student_credentials.push(
      { user_id: ALUMNA.userId, portal: "google_classroom", kind: "google_refresh_token", status: "needs_relink" },
      { user_id: OTRO.userId, portal: "ivirtual", kind: "ivirtual_token", status: "needs_relink" },
    );
    const res = await request(app).get("/api/me").set("Cookie", cookie(ALUMNA));
    assert.equal(res.body.itsonStatus, "ok");
  });

  test("classroomConnected es false si la autorización es de otra cuenta de Google", async () => {
    const { app, db } = setup();
    db.tables.google_authorizations.find((g) => g.user_id === ALUMNA.userId).google_id = "otra-cuenta";
    const res = await request(app).get("/api/me").set("Cookie", cookie(ALUMNA));
    assert.equal(res.body.classroomConnected, false);
  });
});

describe("GET /api/notifications", () => {
  test("mapea al formato Notif y a la categoría calificaciones", async () => {
    const { app, db } = setup();
    const fila = aviso(db, ALUMNA, { horas: -2, materia: "Cálculo" });
    const res = await request(app).get("/api/notifications").set("Cookie", cookie(ALUMNA));
    assert.equal(res.status, 200);
    assert.deepEqual(res.body, [{
      id: fila.id,
      type: "calificaciones",
      title: "Calificación actualizada",
      subject: "Cálculo",
      time: hora(-2),
      unread: true,
      body: "Tarea en Cálculo: calificación de 80 a 97.",
      rows: [
        { label: "Materia", value: "Cálculo" },
        { label: "Calificación", value: "97" },
        { label: "Anterior", value: "80" },
      ],
    }]);
  });

  test("el título depende del tipo de cambio de la BD", async () => {
    const { app, db } = setup();
    aviso(db, ALUMNA, { horas: -1, change_type: "created" });
    aviso(db, ALUMNA, { horas: -2, change_type: "deleted" });
    aviso(db, ALUMNA, { horas: -3, change_type: "updated" });
    const { body } = await request(app).get("/api/notifications").set("Cookie", cookie(ALUMNA));
    assert.deepEqual(body.map((n) => n.title), ["Nueva calificación disponible", "Calificación eliminada", "Calificación actualizada"]);
    assert.ok(body.every((n) => n.type === "calificaciones"));
  });

  test("agrupa por aviso: solo la fila del canal log, sin duplicar por email", async () => {
    const { app, db } = setup();
    const fila = aviso(db, ALUMNA, { channels: ["log", "email"] });
    const { body } = await request(app).get("/api/notifications").set("Cookie", cookie(ALUMNA));
    assert.deepEqual(body.map((n) => n.id), [fila.id]);
  });

  test("un alumno no ve las notificaciones de otro", async () => {
    const { app, db } = setup();
    const mia = aviso(db, ALUMNA);
    const ajena = aviso(db, OTRO, { materia: "Materia ajena" });
    const res = await request(app).get("/api/notifications").set("Cookie", cookie(ALUMNA));
    assert.deepEqual(res.body.map((n) => n.id), [mia.id]);
    assert.equal(JSON.stringify(res.body).includes("Materia ajena"), false);
    assert.equal(JSON.stringify(res.body).includes(ajena.id), false);
  });

  test("no resuelve cambios de otro alumno aunque el payload los nombre", async () => {
    const { app, db } = setup();
    const ajena = aviso(db, OTRO, { materia: "Materia ajena" });
    const mia = aviso(db, ALUMNA);
    mia.payload.grade_change_ids = [ajena.grade_change_id];
    const { body } = await request(app).get("/api/notifications").set("Cookie", cookie(ALUMNA));
    assert.equal(body[0].subject, "Materia no disponible");
    assert.deepEqual(body[0].rows, []);
  });

  test("ordena de más reciente a más antigua y corta en 100", async () => {
    const { app, db } = setup();
    for (let i = 0; i < 105; i++) aviso(db, ALUMNA, { horas: -i });
    const { body } = await request(app).get("/api/notifications").set("Cookie", cookie(ALUMNA));
    assert.equal(body.length, 100);
    assert.equal(body[0].time, hora(0));
    assert.equal(body[99].time, hora(-99));
  });

  test("read_at define unread y un cambio sin fila usa los textos de respaldo", async () => {
    const { app, db } = setup();
    aviso(db, ALUMNA, { read_at: hora(0) });
    db.tables.notifications_log.push({
      id: uuid(), user_id: ALUMNA.userId, grade_change_id: null, channel: "log", status: "sent", attempts: 1,
      payload: null, created_at: hora(-1), read_at: null,
    });
    const { body } = await request(app).get("/api/notifications").set("Cookie", cookie(ALUMNA));
    assert.equal(body[0].unread, false);
    assert.equal(body[1].unread, true);
    assert.equal(body[1].title, "Cambio de calificación");
    assert.equal(body[1].subject, "Materia no disponible");
    assert.equal(typeof body[1].body, "string");
  });
});

describe("POST /api/notifications/:id/read", () => {
  test("marca como leída y es idempotente", async () => {
    const { app, db } = setup();
    const fila = aviso(db, ALUMNA);
    const res = await post(app, `/api/notifications/${fila.id}/read`);
    assert.equal(res.status, 204);
    assert.equal(fila.read_at, hora(0));
    assert.equal((await post(app, `/api/notifications/${fila.id}/read`)).status, 204);
  });

  test("la notificación de otro alumno responde 404 y queda igual", async () => {
    const { app, db } = setup();
    const ajena = aviso(db, OTRO);
    const res = await post(app, `/api/notifications/${ajena.id}/read`);
    assert.equal(res.status, 404);
    assert.equal(ajena.read_at, null);
  });

  test("un id que no es uuid responde 400 sin consultar notifications_log", async () => {
    const { app, db } = setup();
    db.calls.length = 0;
    const res = await post(app, "/api/notifications/1%20or%201=1/read");
    assert.equal(res.status, 400);
    assert.deepEqual(res.body, { error: "id_invalido" });
    assert.equal(db.calls.some((c) => c.table === "notifications_log"), false);
  });

  test("no marca filas de otro canal", async () => {
    const { app, db } = setup();
    const fila = aviso(db, ALUMNA, { channels: ["email"] });
    assert.equal((await post(app, `/api/notifications/${fila.id}/read`)).status, 404);
  });
});

describe("POST /api/notifications/read-all", () => {
  test("marca solo las del alumno y conserva la fecha de las ya leídas", async () => {
    const { app, db } = setup();
    const pendiente = aviso(db, ALUMNA);
    const leida = aviso(db, ALUMNA, { read_at: hora(-5) });
    const ajena = aviso(db, OTRO);
    const res = await post(app, "/api/notifications/read-all");
    assert.equal(res.status, 204);
    assert.equal(pendiente.read_at, hora(0));
    assert.equal(leida.read_at, hora(-5));
    assert.equal(ajena.read_at, null);
  });
});

describe("origen de los POST", () => {
  for (const origen of [null, "https://atacante.test", "null"]) {
    test(`origen ${origen} responde 403 sin escribir`, async () => {
      const { app, db } = setup();
      const fila = aviso(db, ALUMNA);
      for (const ruta of [`/api/notifications/${fila.id}/read`, "/api/notifications/read-all"]) {
        const req = request(app).post(ruta).set("Cookie", cookie(ALUMNA));
        if (origen) req.set("Origin", origen);
        const res = await req;
        assert.equal(res.status, 403);
        assert.deepEqual(res.body, { error: "origen_no_permitido" });
      }
      assert.equal(fila.read_at, null);
    });
  }
});

describe("errores y privacidad", () => {
  test("un fallo de Supabase responde genérico y el log no lleva datos", async () => {
    const { app, db, logs } = setup();
    aviso(db, ALUMNA, { materia: NOTAS });
    db.failNext("notifications_log", "select");
    const res = await request(app).get("/api/notifications").set("Cookie", cookie(ALUMNA));
    assert.equal(res.status, 500);
    assert.deepEqual(res.body, { error: "error_interno" });
    assert.equal(logs.length, 1);
    assert.equal(JSON.parse(logs[0]).error_code, "XX000");
  });

  test("un fallo al leer la sesión falla cerrado", async () => {
    const { app, db } = setup();
    db.failNext("google_app_sessions", "select");
    const res = await request(app).get("/api/me").set("Cookie", cookie(ALUMNA));
    assert.equal(res.status, 500);
    assert.deepEqual(res.body, { error: "error_interno" });
  });

  test("las rutas exitosas no escriben logs con correo ni contenido", async () => {
    const { app, db, logs } = setup();
    const fila = aviso(db, ALUMNA, { materia: NOTAS });
    await request(app).get("/api/me").set("Cookie", cookie(ALUMNA));
    await request(app).get("/api/notifications").set("Cookie", cookie(ALUMNA));
    await post(app, `/api/notifications/${fila.id}/read`);
    const texto = logs.join("\n");
    assert.equal(texto.includes(ALUMNA.email), false);
    assert.equal(texto.includes(NOTAS), false);
  });
});
