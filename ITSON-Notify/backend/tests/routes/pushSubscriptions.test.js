const { describe, test, beforeEach } = require("node:test");
const assert = require("node:assert");
const request = require("supertest");
const crypto = require("crypto");
const webPush = require("web-push");
const { createApp } = require("../../src/app");
const { createFakeSupabase } = require("../helpers/fakeSupabase");
const { encrypt } = require("../../src/utils/secureToken");
const { webPushChannel } = require("../../src/services/notificationChannels");
const { createNotificationRepository } = require("../../src/repositories/notificationRepository");
const { notifyGroupedChanges } = require("../../src/services/notificationService");

const vapidKeys = webPush.generateVAPIDKeys();

function crearSesion(db, secret, { email = "alumno@potros.itson.edu.mx", googleId = "g12345" } = {}) {
  const userId = crypto.randomUUID();
  const sessionId = crypto.randomBytes(16).toString("hex");
  const exp = Date.now() + 1000 * 60 * 60;

  db.tables.app_users.push({ id: userId, email });
  db.tables.google_app_sessions.push({
    id: crypto.createHash("sha256").update(sessionId).digest("hex"),
    user_id: userId,
    google_id: googleId,
    expires_at: new Date(exp).toISOString(),
  });

  const sessionToken = encrypt({ userId, googleId, sessionId, exp }, secret, "google-session");
  return {
    userId,
    googleId,
    sessionId,
    cookie: `itn41_google_session=${sessionToken}`,
  };
}

describe("Rutas y ciclo de vida de Suscripciones Web Push", () => {
  let app, db, validCookie, userId, googleId, sessionId, secret, pushRepo;

  beforeEach(() => {
    db = createFakeSupabase();
    secret = crypto.randomBytes(32).toString("hex");
    pushRepo = createNotificationRepository(db.client);

    const sesion = crearSesion(db, secret);
    userId = sesion.userId;
    googleId = sesion.googleId;
    sessionId = sesion.sessionId;
    validCookie = sesion.cookie;

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

  test("Cierre de sesión con notificaciones activas revoca las suscripciones del alumno en servidor", async () => {
    const subRes = await request(app)
      .post("/push/subscriptions")
      .set("Origin", "http://localhost:5173")
      .set("Cookie", validCookie)
      .send({
        subscription: { endpoint: "https://fcm.test/activo", keys: { p256dh: "pub-a", auth: "auth-a" } },
      });
    assert.strictEqual(subRes.status, 201);
    assert.strictEqual(db.tables.push_subscriptions.length, 1);

    const logoutRes = await request(app)
      .post("/auth/google/logout")
      .set("Origin", "http://localhost:5173")
      .set("Cookie", validCookie);
    assert.strictEqual(logoutRes.status, 204);
    assert.strictEqual(db.tables.push_subscriptions.length, 0);

    const enviados = [];
    const channel = webPushChannel({
      vapidPublicKey: vapidKeys.publicKey,
      vapidPrivateKey: vapidKeys.privateKey,
      pushRepo,
      webpushImpl: {
        setVapidDetails: () => {},
        sendNotification: async (sub, payload) => enviados.push({ sub, payload }),
      },
    });

    await assert.rejects(
      () => channel.send({ subject: "Aviso", text: "Calificación privada" }, { userId }),
      /Usuario sin suscripciones Web Push/,
    );
    assert.strictEqual(enviados.length, 0);
  });

  test("Flujo A -> logout -> B en el mismo navegador: B no recibe alertas privadas del alumno A", async () => {
    const alumnoB = crearSesion(db, secret, { email: "alumnob@potros.itson.edu.mx", googleId: "g67890" });
    const sharedEndpoint = "https://fcm.test/navegador-compartido";

    // 1. Alumno A activa notificaciones en el navegador compartido
    const resA = await request(app)
      .post("/push/subscriptions")
      .set("Origin", "http://localhost:5173")
      .set("Cookie", validCookie)
      .send({
        subscription: { endpoint: sharedEndpoint, keys: { p256dh: "key-a", auth: "auth-a" } },
      });
    assert.strictEqual(resA.status, 201);

    // 2. Alumno A cierra sesión
    const logoutA = await request(app)
      .post("/auth/google/logout")
      .set("Origin", "http://localhost:5173")
      .set("Cookie", validCookie);
    assert.strictEqual(logoutA.status, 204);
    assert.strictEqual(db.tables.push_subscriptions.length, 0);

    // 3. Alumno B inicia sesión en el mismo navegador y suscribe el mismo endpoint
    const resB = await request(app)
      .post("/push/subscriptions")
      .set("Origin", "http://localhost:5173")
      .set("Cookie", alumnoB.cookie)
      .send({
        subscription: { endpoint: sharedEndpoint, keys: { p256dh: "key-b", auth: "auth-b" } },
      });
    assert.strictEqual(resB.status, 201);
    assert.strictEqual(db.tables.push_subscriptions.length, 1);
    assert.strictEqual(db.tables.push_subscriptions[0].user_id, alumnoB.userId);

    // 4. Se dispara una alerta para el alumno A y otra para el alumno B
    const entregas = [];
    const channel = webPushChannel({
      vapidPublicKey: vapidKeys.publicKey,
      vapidPrivateKey: vapidKeys.privateKey,
      pushRepo,
      webpushImpl: {
        setVapidDetails: () => {},
        sendNotification: async (sub, payload) => entregas.push({ sub, payload: JSON.parse(payload) }),
      },
    });

    await assert.rejects(
      () => channel.send({ subject: "Nota de A", text: "Privado de A" }, { userId, gradeChangeId: "gc-a" }),
      /Usuario sin suscripciones Web Push/,
    );
    assert.strictEqual(entregas.length, 0);

    await channel.send({ subject: "Nota de B", text: "Exclusivo de B" }, { userId: alumnoB.userId, gradeChangeId: "gc-b" });
    assert.strictEqual(entregas.length, 1);
    assert.strictEqual(entregas[0].sub.endpoint, sharedEndpoint);
    assert.strictEqual(entregas[0].sub.keys.auth, "auth-b");
    assert.strictEqual(entregas[0].payload.body, "Exclusivo de B");
  });

  test("Cambio de cuenta directo A -> B reasigna la propiedad exclusiva del endpoint (UNIQUE endpoint)", async () => {
    const alumnoB = crearSesion(db, secret, { email: "alumnob@potros.itson.edu.mx", googleId: "g67890" });
    const sharedEndpoint = "https://fcm.test/endpoint-unico";

    // Alumno A registra el endpoint
    await request(app)
      .post("/push/subscriptions")
      .set("Origin", "http://localhost:5173")
      .set("Cookie", validCookie)
      .send({
        subscription: { endpoint: sharedEndpoint, keys: { p256dh: "p256dh-a", auth: "auth-a" } },
      });
    assert.strictEqual(db.tables.push_subscriptions.length, 1);
    assert.strictEqual(db.tables.push_subscriptions[0].user_id, userId);

    // Alumno B registra el mismo endpoint en el mismo navegador sin que A haya borrado antes su suscripción
    const resB = await request(app)
      .post("/push/subscriptions")
      .set("Origin", "http://localhost:5173")
      .set("Cookie", alumnoB.cookie)
      .send({
        subscription: { endpoint: sharedEndpoint, keys: { p256dh: "p256dh-b", auth: "auth-b" } },
      });
    assert.strictEqual(resB.status, 201);

    // El endpoint pertenece exclusivamente a B; A ya no tiene suscripciones asociadas
    assert.strictEqual(db.tables.push_subscriptions.length, 1);
    assert.strictEqual(db.tables.push_subscriptions[0].user_id, alumnoB.userId);
    assert.strictEqual(db.tables.push_subscriptions[0].p256dh, "p256dh-b");
    assert.strictEqual((await pushRepo.listPushSubscriptions(userId)).length, 0);
    assert.strictEqual((await pushRepo.listPushSubscriptions(alumnoB.userId)).length, 1);
  });

  test("Canal Web Push envía notificaciones agrupadas y depura endpoints que responden HTTP 404 o 410", async () => {
    db.tables.subjects.push({ id: "subj-1", user_id: userId, name: "Ingeniería de Software" });
    db.tables.snapshot_grades.push({
      id: "sg-1",
      snapshot_id: "snap-2",
      subject_id: "subj-1",
      external_item_id: "item-1",
      grade_label: "Entrega Final",
    });

    await pushRepo.savePushSubscription({
      userId,
      endpoint: "https://fcm.test/valido",
      p256dh: "k1",
      auth: "a1",
    });
    await pushRepo.savePushSubscription({
      userId,
      endpoint: "https://fcm.test/no-encontrado-404",
      p256dh: "k2",
      auth: "a2",
    });
    await pushRepo.savePushSubscription({
      userId,
      endpoint: "https://fcm.test/vencido-410",
      p256dh: "k3",
      auth: "a3",
    });
    assert.strictEqual(db.tables.push_subscriptions.length, 3);

    const recibidos = [];
    const channel = webPushChannel({
      vapidPublicKey: vapidKeys.publicKey,
      vapidPrivateKey: vapidKeys.privateKey,
      pushRepo,
      webpushImpl: {
        setVapidDetails: () => {},
        sendNotification: async (sub, payload) => {
          if (sub.endpoint.endsWith("404")) {
            const err = new Error("Not Found");
            err.statusCode = 404;
            throw err;
          }
          if (sub.endpoint.endsWith("410")) {
            const err = new Error("Gone");
            err.statusCode = 410;
            throw err;
          }
          recibidos.push({ sub, payload: JSON.parse(payload) });
        },
      },
    });

    const resultado = await notifyGroupedChanges(
      [
        {
          id: "gc-10",
          user_id: userId,
          subject_id: "subj-1",
          external_item_id: "item-1",
          previous_snapshot_id: "snap-1",
          current_snapshot_id: "snap-2",
          field_name: "grade_label",
          change_type: "created",
          previous_value: null,
          current_value: "Entrega Final",
        },
      ],
      { repo: pushRepo, channels: [channel] },
    );

    assert.strictEqual(resultado.notified, 1);
    assert.strictEqual(resultado.failed, 0);
    assert.strictEqual(recibidos.length, 1);
    assert.strictEqual(recibidos[0].sub.endpoint, "https://fcm.test/valido");
    assert.strictEqual(recibidos[0].payload.title, "ITSON Notify: nueva tarea");
    assert.strictEqual(
      recibidos[0].payload.body,
      "Nueva tarea publicada: Entrega Final en Ingeniería de Software.",
    );
    assert.strictEqual(recibidos[0].payload.tag, "itson-change-gc-10");

    // Los endpoints 404 y 410 fueron depurados automáticamente; solo queda el válido
    assert.strictEqual(db.tables.push_subscriptions.length, 1);
    assert.strictEqual(db.tables.push_subscriptions[0].endpoint, "https://fcm.test/valido");
  });

  test("Si todos los endpoints responden 410, se depuran y el envío se registra como fallido", async () => {
    await pushRepo.savePushSubscription({
      userId,
      endpoint: "https://fcm.test/unico-vencido-410",
      p256dh: "k1",
      auth: "a1",
    });

    const channel = webPushChannel({
      vapidPublicKey: vapidKeys.publicKey,
      vapidPrivateKey: vapidKeys.privateKey,
      pushRepo,
      webpushImpl: {
        setVapidDetails: () => {},
        sendNotification: async () => {
          const err = new Error("Gone");
          err.statusCode = 410;
          throw err;
        },
      },
    });

    await assert.rejects(
      () => channel.send({ subject: "ITSON Notify", text: "Cambio" }, { userId, gradeChangeId: "gc-99" }),
      /Web Push respondió 410/,
    );
    assert.strictEqual(db.tables.push_subscriptions.length, 0);
  });
});
