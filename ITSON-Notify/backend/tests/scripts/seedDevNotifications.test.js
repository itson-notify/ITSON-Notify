// ITN-53 - Script de siembra para dev, con el Supabase simulado. Datos inventados.
const { test, describe } = require("node:test");
const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const path = require("node:path");
const { spawnSync } = require("node:child_process");
const request = require("supertest");

const { createApp } = require("../../src/app");
const { createLogger } = require("../../src/utils/logger");
const { sessionHash } = require("../../src/middleware/studentSession");
const { encrypt } = require("../../src/utils/secureToken");
const { retryPendingNotifications } = require("../../src/services/notificationService");
const { createNotificationRepository } = require("../../src/repositories/notificationRepository");
const { seedNotifications, EJEMPLOS } = require("../../scripts/seed-dev-notifications");
const { createFakeSupabase } = require("../helpers/fakeSupabase");
const { API_KEY, CREDENTIALS_KEY } = require("../helpers/payloads");

const SCRIPT = path.join(__dirname, "../../scripts/seed-dev-notifications.js");
const EMAIL = "alumna@example.test";
const SECRET = "clave-de-pruebas-siembra-".repeat(2);
const USER_ID = crypto.randomUUID();
const T0 = Date.parse("2026-11-06T12:00:00Z");

function dbConAlumna() {
  const db = createFakeSupabase();
  db.tables.app_users.push({ id: USER_ID, email: EMAIL });
  return db;
}

const sembrar = (db, env = {}) => seedNotifications({ supabase: db.client, email: EMAIL, env, now: () => T0 });

describe("seed-dev-notifications", () => {
  test("se niega a correr con NODE_ENV=production, sin tocar la base", async () => {
    const db = dbConAlumna();
    await assert.rejects(sembrar(db, { NODE_ENV: "production" }), /NODE_ENV=production/);
    assert.equal(db.calls.length, 0);
  });

  test("el proceso termina con error en producción, antes de conectarse", () => {
    const { status, stdout, stderr } = spawnSync(process.execPath, [SCRIPT], {
      env: { PATH: process.env.PATH, NODE_ENV: "production", SUPABASE_URL: "http://127.0.0.1:9", SUPABASE_SERVICE_ROLE_KEY: "sintetica", SEED_ALUMNO_EMAIL: EMAIL },
      encoding: "utf8",
    });
    assert.equal(status, 1);
    assert.match(stderr, /NODE_ENV=production/);
    assert.equal(stdout, "");
  });

  test("falla sin crear al alumno si no existe en app_users", async () => {
    const db = createFakeSupabase();
    await assert.rejects(sembrar(db), /No existe ese alumno/);
    assert.equal(db.tables.app_users.length, 0);
    assert.equal(db.tables.notifications_log.length, 0);
  });

  test("liga grade_changes y notifications_log al app_users.id del alumno", async () => {
    const db = dbConAlumna();
    assert.equal(await sembrar(db), EJEMPLOS.length);
    assert.equal(db.tables.grade_changes.length, EJEMPLOS.length);
    assert.equal(db.tables.notifications_log.length, EJEMPLOS.length);
    assert.ok(db.tables.grade_changes.every((c) => c.user_id === USER_ID));
    for (const fila of db.tables.notifications_log) {
      assert.equal(fila.user_id, USER_ID);
      assert.equal(fila.channel, "log");
      assert.ok(db.tables.grade_changes.some((c) => c.id === fila.grade_change_id));
    }
  });

  test("repetirla no duplica y restaura el estado de lectura", async () => {
    const db = dbConAlumna();
    await sembrar(db);
    for (const fila of db.tables.notifications_log) fila.read_at = "2026-11-06T13:00:00.000Z";
    await sembrar(db);
    assert.equal(db.tables.notifications_log.length, EJEMPLOS.length);
    assert.equal(db.tables.grade_changes.length, EJEMPLOS.length);
    assert.equal(db.tables.notifications_log.filter((f) => f.read_at === null).length, EJEMPLOS.filter((e) => !e.leida).length);
  });

  test("el reintento de notificaciones no vuelve a enviar lo sembrado", async () => {
    const db = dbConAlumna();
    await sembrar(db);
    const enviados = [];
    const channels = [{ name: "log", send: async (m) => enviados.push(m) }];
    const { retried } = await retryPendingNotifications(USER_ID, { repo: createNotificationRepository(db.client), channels });
    assert.equal(retried, 0);
    assert.equal(enviados.length, 0);
  });

  test("lo sembrado sale completo por GET /api/notifications", async () => {
    const db = dbConAlumna();
    await sembrar(db);
    db.tables.google_app_sessions.push({ id: sessionHash("s"), user_id: USER_ID, google_id: "g", expires_at: new Date(T0 + 60_000).toISOString() });
    const app = createApp({
      config: { internalApiKey: API_KEY, credentialsEncryptionKey: CREDENTIALS_KEY, googleAuthSecret: SECRET },
      supabase: db.client,
      logger: createLogger(() => {}),
      now: () => T0,
      channels: [],
    });
    const cookie = encrypt({ userId: USER_ID, googleId: "g", sessionId: "s", exp: T0 + 60_000 }, SECRET, "google-session");
    const { status, body } = await request(app).get("/api/notifications").set("Cookie", `itn41_google_session=${cookie}`);
    assert.equal(status, 200);
    assert.deepEqual(body.map((n) => n.subject), EJEMPLOS.map((e) => e.materia));
    assert.deepEqual(body.map((n) => n.unread), EJEMPLOS.map((e) => !e.leida));
    assert.deepEqual(body.map((n) => n.title), ["Nueva calificación disponible", "Calificación actualizada", "Nueva calificación disponible"]);
    assert.match(body[1].body, /Examen parcial en Materia de ejemplo B: calificación de 80 a 85\./);
  });
});
