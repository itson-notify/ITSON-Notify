// ITN-54 - Suscripciones Web Push huérfanas cuando falla la limpieza del logout.
// El logout marca la sesión con revoked_at; la purga previa al envío (y la de
// Desconectar) borra el Push de las sesiones marcadas. Datos inventados.
const { describe, test, beforeEach } = require("node:test");
const assert = require("node:assert/strict");
const request = require("supertest");
const crypto = require("crypto");
const webPush = require("web-push");
const { createApp } = require("../../src/app");
const { createFakeSupabase } = require("../helpers/fakeSupabase");
const { encrypt } = require("../../src/utils/secureToken");
const { createLogger } = require("../../src/utils/logger");
const { webPushChannel } = require("../../src/services/notificationChannels");
const { createNotificationRepository } = require("../../src/repositories/notificationRepository");

const vapidKeys = webPush.generateVAPIDKeys();
const FRONTEND = "http://localhost:5173";
const EMAIL = "alumno@potros.itson.edu.mx";
const GOOGLE_ID = "g-itn54";
const LAPTOP = "https://fcm.test/laptop";
const TELEFONO = "https://fcm.test/telefono";

const hash = (id) => crypto.createHash("sha256").update(id).digest("hex");

describe("ITN-54 - Push huérfano tras un logout con limpieza fallida", () => {
  let app, db, secret, userId, pushRepo, logs;

  // Crea una sesión en google_app_sessions y devuelve su cookie y su hash.
  function sesion({ revokedAt = null } = {}) {
    const sessionId = crypto.randomBytes(16).toString("hex");
    const exp = Date.now() + 60 * 60 * 1000;
    db.tables.google_app_sessions.push({
      id: hash(sessionId), user_id: userId, google_id: GOOGLE_ID,
      expires_at: new Date(exp).toISOString(), revoked_at: revokedAt,
    });
    const token = encrypt({ userId, googleId: GOOGLE_ID, sessionId, exp }, secret, "google-session");
    return { cookie: `itn41_google_session=${token}`, hash: hash(sessionId) };
  }

  const suscribir = (cookie, endpoint) => request(app).post("/push/subscriptions")
    .set("Origin", FRONTEND).set("Cookie", cookie)
    .send({ subscription: { endpoint, keys: { p256dh: `p-${endpoint}`, auth: `a-${endpoint}` } } });

  const logout = (cookie) => request(app).post("/auth/google/logout")
    .set("Origin", FRONTEND).set("Cookie", cookie);

  const desconectar = (cookie) => request(app).delete("/auth/google/session")
    .set("Origin", FRONTEND).set("Cookie", cookie);

  // Canal Web Push con un envío simulado que registra a qué endpoint llegó.
  function canal() {
    const entregas = [];
    const channel = webPushChannel({
      vapidPublicKey: vapidKeys.publicKey,
      vapidPrivateKey: vapidKeys.privateKey,
      pushRepo,
      webpushImpl: {
        setVapidDetails: () => {},
        sendNotification: async (sub) => entregas.push(sub.endpoint),
      },
    });
    const enviar = () => channel.send({ subject: "ITSON Notify", text: "Cálculo: 90 a 95." }, { userId, gradeChangeId: "gc-54" });
    return { entregas, enviar };
  }

  const endpoints = () => db.tables.push_subscriptions.map((s) => s.endpoint).sort();
  const revocadas = () => db.tables.google_app_sessions.filter((s) => s.revoked_at);

  // Laptop y teléfono suscritos; el logout de la laptop falla al borrar su Push.
  async function logoutLaptopConLimpiezaFallida() {
    const laptop = sesion();
    const telefono = sesion();
    assert.equal((await suscribir(laptop.cookie, LAPTOP)).status, 201);
    assert.equal((await suscribir(telefono.cookie, TELEFONO)).status, 201);
    db.failNext("push_subscriptions", "delete");
    const res = await logout(laptop.cookie);
    assert.equal(res.status, 204);
    return { laptop, telefono, res };
  }

  beforeEach(() => {
    db = createFakeSupabase();
    secret = crypto.randomBytes(32).toString("hex");
    userId = crypto.randomUUID();
    logs = [];
    db.tables.app_users.push({ id: userId, email: EMAIL });
    db.tables.google_authorizations.push({
      user_id: userId, google_id: GOOGLE_ID, email: EMAIL, scope: "classroom", refresh_token: "cifrado",
    });
    pushRepo = createNotificationRepository(db.client);
    app = createApp({
      config: {
        internalApiKey: "k".repeat(32),
        credentialsEncryptionKey: crypto.randomBytes(32),
        googleAuthSecret: secret,
        frontendUrl: FRONTEND,
        vapidPublicKey: vapidKeys.publicKey,
        vapidPrivateKey: vapidKeys.privateKey,
      },
      supabase: db.client,
      logger: createLogger((line) => logs.push(line)),
    });
  });

  test("regresión: falla la limpieza Push en el logout y el siguiente envío purga la huérfana sin volver a suscribirse", async () => {
    const { laptop, res } = await logoutLaptopConLimpiezaFallida();

    // Contrato del logout intacto: 204 con las cookies borradas.
    assert.match(res.headers["set-cookie"].join(";"), /itn41_google_session=;.*(Max-Age=0|Expires=Thu, 01 Jan 1970)/);
    // La huérfana sigue, pero la sesión quedó marcada y ya no da acceso.
    assert.deepEqual(endpoints(), [LAPTOP, TELEFONO]);
    assert.deepEqual(revocadas().map((s) => s.id), [laptop.hash]);
    assert.equal((await request(app).get("/auth/google/session").set("Cookie", laptop.cookie)).status, 401);

    const { entregas, enviar } = canal();
    await enviar();

    assert.deepEqual(entregas, [TELEFONO]);
    assert.deepEqual(endpoints(), [TELEFONO]);
    assert.equal(revocadas().length, 0);
    assert.equal(db.tables.google_app_sessions.some((s) => s.id === laptop.hash), false);
  });

  test("la purga en el envío falla cerrado: no entrega a nadie y el siguiente intento purga y entrega", async () => {
    const { laptop } = await logoutLaptopConLimpiezaFallida();
    const { entregas, enviar } = canal();

    db.failNext("push_subscriptions", "delete");
    await assert.rejects(enviar());
    assert.deepEqual(entregas, []);
    assert.deepEqual(endpoints(), [LAPTOP, TELEFONO]);
    assert.deepEqual(revocadas().map((s) => s.id), [laptop.hash]);

    await enviar();
    assert.deepEqual(entregas, [TELEFONO]);
    assert.deepEqual(endpoints(), [TELEFONO]);
  });

  test("si falla leer las sesiones revocadas, el envío también falla cerrado", async () => {
    await logoutLaptopConLimpiezaFallida();
    const { entregas, enviar } = canal();
    db.failNext("google_app_sessions", "select", "57014");
    await assert.rejects(enviar());
    assert.deepEqual(entregas, []);
  });

  test("sin la migración 011 (42703 al leer revoked_at) el envío sigue como antes", async () => {
    const telefono = sesion();
    await suscribir(telefono.cookie, TELEFONO);
    const { entregas, enviar } = canal();
    db.failNext("google_app_sessions", "select", "42703");
    await enviar();
    assert.deepEqual(entregas, [TELEFONO]);
  });

  test("un logout con limpieza correcta no deja sesiones marcadas", async () => {
    const laptop = sesion();
    const telefono = sesion();
    await suscribir(laptop.cookie, LAPTOP);
    await suscribir(telefono.cookie, TELEFONO);

    assert.equal((await logout(laptop.cookie)).status, 204);
    assert.deepEqual(endpoints(), [TELEFONO]);
    assert.equal(db.tables.google_app_sessions.some((s) => s.id === laptop.hash), false);
    assert.equal(revocadas().length, 0);
  });

  test("la purga no toca filas con session_id null ni un endpoint que una sesión nueva volvió a suscribir", async () => {
    const { laptop } = await logoutLaptopConLimpiezaFallida();
    // Fila heredada sin sesión (valor por defecto de savePushSubscription).
    await pushRepo.savePushSubscription({ userId, endpoint: "https://fcm.test/heredada", p256dh: "p", auth: "a" });
    // El mismo navegador vuelve a entrar y suscribe el mismo endpoint: el upsert
    // reasigna session_id a la sesión nueva.
    const nueva = sesion();
    assert.equal((await suscribir(nueva.cookie, LAPTOP)).status, 201);

    const { entregas, enviar } = canal();
    await enviar();

    assert.deepEqual(entregas.sort(), ["https://fcm.test/heredada", LAPTOP, TELEFONO]);
    assert.deepEqual(endpoints(), ["https://fcm.test/heredada", LAPTOP, TELEFONO]);
    assert.equal(db.tables.google_app_sessions.some((s) => s.id === laptop.hash), false);
  });

  test("Desconectar después de un logout con limpieza fallida purga la huérfana antes del cascade y conserva el Push", async () => {
    const { telefono } = await logoutLaptopConLimpiezaFallida();

    assert.equal((await desconectar(telefono.cookie)).status, 204);
    assert.equal(db.tables.google_authorizations.length, 0);
    assert.equal(db.tables.google_app_sessions.length, 0);
    // La huérfana se purgó; el teléfono sigue suscrito aunque Desconectar borró su sesión.
    assert.deepEqual(endpoints(), [TELEFONO]);

    const { entregas, enviar } = canal();
    await enviar();
    assert.deepEqual(entregas, [TELEFONO]);
  });

  test("si la purga falla en Desconectar, responde 500 y no borra la autorización ni las marcas", async () => {
    const { laptop, telefono } = await logoutLaptopConLimpiezaFallida();

    db.failNext("push_subscriptions", "delete");
    const res = await desconectar(telefono.cookie);
    assert.equal(res.status, 500);
    assert.deepEqual(res.body, { error: "error_interno" });
    assert.equal(db.tables.google_authorizations.length, 1);
    assert.deepEqual(revocadas().map((s) => s.id), [laptop.hash]);
    assert.deepEqual(endpoints(), [LAPTOP, TELEFONO]);

    // Al reintentar, se purga y Desconectar termina.
    assert.equal((await desconectar(telefono.cookie)).status, 204);
    assert.deepEqual(endpoints(), [TELEFONO]);
  });

  test("sin la migración 011 (42703 en el update) el logout vuelve a borrar la sesión y responde 204", async () => {
    const laptop = sesion();
    await suscribir(laptop.cookie, LAPTOP);
    db.failNext("google_app_sessions", "update", "42703");

    const res = await logout(laptop.cookie);
    assert.equal(res.status, 204);
    assert.equal(db.tables.google_app_sessions.length, 0);
    assert.deepEqual(endpoints(), []);
    assert.ok(logs.some((l) => l.includes('"session_revocation_column_missing"') && l.includes('"error_code":"42703"')));
  });

  test("los logs del flujo no llevan endpoint, correo ni user_id", async () => {
    const { telefono } = await logoutLaptopConLimpiezaFallida();
    db.failNext("push_subscriptions", "delete");
    await desconectar(telefono.cookie);
    await desconectar(telefono.cookie);

    const texto = logs.join("\n");
    assert.ok(texto.includes('"push_cleanup_failed"'));
    assert.ok(texto.includes('"push_orphan_purge_failed"'));
    assert.ok(texto.includes('"push_orphans_purged"'));
    for (const privado of [LAPTOP, TELEFONO, EMAIL, userId, "fcm.test"]) {
      assert.equal(texto.includes(privado), false, privado);
    }
  });

  test("con el logger real, push_cleanup_failed conserva error_code y target y descarta endpoint, email y user_id", async () => {
    // Por la ruta: fallan los dos borrados Push del logout (sesión y endpoint).
    const laptop = sesion();
    await suscribir(laptop.cookie, LAPTOP);
    db.failNext("push_subscriptions", "delete", "XX000");
    db.failNext("push_subscriptions", "delete", "XX000");
    const res = await request(app).post("/auth/google/logout")
      .set("Origin", FRONTEND).set("Cookie", laptop.cookie).send({ endpoint: LAPTOP });
    assert.equal(res.status, 204);

    const eventos = logs.map((l) => JSON.parse(l)).filter((e) => e.event === "push_cleanup_failed");
    assert.deepEqual(eventos.map(({ level, error_code, target }) => ({ level, error_code, target })), [
      { level: "warn", error_code: "XX000", target: "session" },
      { level: "warn", error_code: "XX000", target: "endpoint" },
    ]);
    for (const evento of eventos) {
      assert.deepEqual(Object.keys(evento).sort(), ["error_code", "event", "level", "target", "ts"]);
    }
    // user_id está en la lista blanca desde ITN-27 (eventos de snapshots), así que
    // el logger no lo descartaría: la garantía es que la ruta nunca lo envía.
    for (const privado of [LAPTOP, EMAIL, userId]) {
      assert.equal(logs.join("\n").includes(privado), false, privado);
    }

    // Directo: aunque alguien pase campos no permitidos, el logger los descarta.
    const lineas = [];
    createLogger((l) => lineas.push(l)).warn("push_cleanup_failed", {
      error_code: "XX000", target: "endpoint", endpoint: LAPTOP, email: EMAIL,
    });
    const evento = JSON.parse(lineas[0]);
    assert.deepEqual(Object.keys(evento).sort(), ["error_code", "event", "level", "target", "ts"]);
    assert.equal(evento.error_code, "XX000");
    assert.equal(evento.target, "endpoint");
    for (const privado of [LAPTOP, EMAIL]) assert.equal(lineas[0].includes(privado), false, privado);
    // target también pasa por valorSeguro: un endpoint completo no cabe en TEXTO_SEGURO.
    lineas.length = 0;
    createLogger((l) => lineas.push(l)).warn("push_cleanup_failed", { error_code: "XX000", target: LAPTOP });
    assert.equal("target" in JSON.parse(lineas[0]), false);
  });

  describe("cada lector de google_app_sessions rechaza una sesión revocada", () => {
    const lectores = [
      ["GET /auth/google/session (¿tiene sesión?)", (c) => request(app).get("/auth/google/session").set("Cookie", c)],
      ["DELETE /auth/google/session (Desconectar)", (c) => desconectar(c)],
      ["GET /api/me", (c) => request(app).get("/api/me").set("Cookie", c)],
      ["GET /api/notifications", (c) => request(app).get("/api/notifications").set("Cookie", c)],
      ["GET /api/credentials/ivirtual", (c) => request(app).get("/api/credentials/ivirtual").set("Cookie", c)],
      ["POST /push/subscriptions", (c) => suscribir(c, LAPTOP)],
      ["DELETE /push/subscriptions", (c) => request(app).delete("/push/subscriptions")
        .set("Origin", FRONTEND).set("Cookie", c).send({ endpoint: LAPTOP })],
    ];
    for (const [nombre, llamar] of lectores) {
      test(`${nombre} responde 401`, async () => {
        const { cookie } = sesion({ revokedAt: new Date().toISOString() });
        assert.equal((await llamar(cookie)).status, 401);
        // Desconectar con sesión revocada no toca la autorización.
        assert.equal(db.tables.google_authorizations.length, 1);
      });
    }

    test("POST /auth/google/logout con sesión revocada responde 204 sin tocar el Push", async () => {
      const vigente = sesion();
      await suscribir(vigente.cookie, TELEFONO);
      const { cookie } = sesion({ revokedAt: new Date().toISOString() });
      assert.equal((await logout(cookie)).status, 204);
      assert.deepEqual(endpoints(), [TELEFONO]);
    });
  });
});
