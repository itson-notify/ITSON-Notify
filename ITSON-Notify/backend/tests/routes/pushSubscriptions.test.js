const { describe, test, beforeEach } = require("node:test");
const assert = require("node:assert");
const request = require("supertest");
const crypto = require("crypto");
const webPush = require("web-push");
const { createApp } = require("../../src/app");
const { createFakeSupabase } = require("../helpers/fakeSupabase");
const { encrypt } = require("../../src/utils/secureToken");

const vapidKeys = webPush.generateVAPIDKeys();

describe("Rutas de Suscripciones Web Push", () => {
  let app, db, validCookie, userId, googleId, sessionId, secret;

  beforeEach(() => {
    db = createFakeSupabase();
    userId = crypto.randomUUID();
    googleId = "g12345";
    sessionId = crypto.randomBytes(16).toString("hex");
    secret = crypto.randomBytes(32).toString("hex");

    db.tables.app_users.push({ id: userId, email: "alumno@potros.itson.edu.mx" });
    db.tables.google_app_sessions.push({
      id: crypto.createHash("sha256").update(sessionId).digest("hex"),
      user_id: userId,
      google_id: googleId,
      expires_at: new Date(Date.now() + 1000 * 60 * 60).toISOString(),
    });

    const exp = Date.now() + 1000 * 60 * 60;
    const sessionToken = encrypt({ userId, googleId, sessionId, exp }, secret, "google-session");
    validCookie = `itn41_google_session=${sessionToken}`;

    app = createApp({
      config: {
        internalApiKey: "dummy-key",
        credentialsEncryptionKey: crypto.randomBytes(32),
        googleAuthSecret: secret,
        frontendUrl: "http://localhost:5173",
        vapidPublicKey: vapidKeys.publicKey,
        vapidPrivateKey: vapidKeys.privateKey,
        vapidSubject: "mailto:test@potros.itson.edu.mx",
      },
      supabase: db.client,
      logger: { info: () => {}, error: () => {}, warn: () => {} },
    });
  });

  test("Bloquea 401 en POST y DELETE si no hay cookie de sesión activa", async () => {
    const postRes = await request(app)
      .post("/push/subscriptions")
      .set("Origin", "http://localhost:5173")
      .send({ subscription: { endpoint: "https://fcm.test/1", keys: { p256dh: "a", auth: "b" } } });
    assert.strictEqual(postRes.status, 401);

    const delRes = await request(app)
      .delete("/push/subscriptions")
      .set("Origin", "http://localhost:5173")
      .send({ endpoint: "https://fcm.test/1" });
    assert.strictEqual(delRes.status, 401);
  });

  test("Bloquea 403 si el origen no coincide (Protección CSRF)", async () => {
    const res = await request(app)
      .post("/push/subscriptions")
      .set("Origin", "http://sitio-atacante.com")
      .set("Cookie", validCookie)
      .send({ subscription: { endpoint: "https://fcm.test/1", keys: { p256dh: "a", auth: "b" } } });
    assert.strictEqual(res.status, 403);
  });

  test("Bloquea 403 si un usuario intenta operar con el userId de alguien más", async () => {
    const postRes = await request(app)
      .post("/push/subscriptions")
      .set("Origin", "http://localhost:5173")
      .set("Cookie", validCookie)
      .send({
        userId: "id-ajeno-de-otro-alumno",
        subscription: { endpoint: "https://fcm.test/1", keys: { p256dh: "a", auth: "b" } },
      });
    assert.strictEqual(postRes.status, 403);

    const delRes = await request(app)
      .delete("/push/subscriptions")
      .set("Origin", "http://localhost:5173")
      .set("Cookie", validCookie)
      .send({
        userId: "id-ajeno-de-otro-alumno",
        endpoint: "https://fcm.test/1",
      });
    assert.strictEqual(delRes.status, 403);
  });

  test("Alta (201): Registra la suscripción correctamente extrayendo ID de sesión", async () => {
    const res = await request(app)
      .post("/push/subscriptions")
      .set("Origin", "http://localhost:5173")
      .set("Cookie", validCookie)
      .send({
        subscription: { endpoint: "https://fcm.test/1", keys: { p256dh: "llave-pub", auth: "secreto" } },
      });

    assert.strictEqual(res.status, 201);
    assert.strictEqual(db.tables.push_subscriptions.length, 1);
    assert.strictEqual(db.tables.push_subscriptions[0].user_id, userId);
    assert.strictEqual(db.tables.push_subscriptions[0].endpoint, "https://fcm.test/1");
  });

  test("Baja (204) y aislamiento: Borra solo la suscripción propia sin afectar a otros alumnos", async () => {
    const otroUserId = crypto.randomUUID();
    db.tables.push_subscriptions.push(
      { id: "sub-1", user_id: userId, endpoint: "https://fcm.test/2", p256dh: "a", auth: "b" },
      { id: "sub-2", user_id: otroUserId, endpoint: "https://fcm.test/ajeno", p256dh: "c", auth: "d" },
    );

    // Intento de borrar endpoint ajeno no elimina la fila del otro usuario
    const resAjeno = await request(app)
      .delete("/push/subscriptions")
      .set("Origin", "http://localhost:5173")
      .set("Cookie", validCookie)
      .send({ endpoint: "https://fcm.test/ajeno" });
    assert.strictEqual(resAjeno.status, 204);
    assert.strictEqual(db.tables.push_subscriptions.length, 2);

    // Borrado del endpoint propio
    const resPropio = await request(app)
      .delete("/push/subscriptions")
      .set("Origin", "http://localhost:5173")
      .set("Cookie", validCookie)
      .send({ endpoint: "https://fcm.test/2" });

    assert.strictEqual(resPropio.status, 204);
    assert.strictEqual(db.tables.push_subscriptions.length, 1);
    assert.strictEqual(db.tables.push_subscriptions[0].user_id, otroUserId);
  });
});