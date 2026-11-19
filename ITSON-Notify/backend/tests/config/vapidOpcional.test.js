// Push es opcional: llaves VAPID inválidas o ausentes NO deben tumbar el backend.
// Cubre el validador, loadConfig, los endpoints /push con push deshabilitado y el
// arranque real del proceso (src/server.js) en los tres casos: inválida, ausente
// y válida. Todas las llaves se generan en tiempo de ejecución.
const { test, describe } = require("node:test");
const assert = require("node:assert/strict");
const crypto = require("crypto");
const path = require("node:path");
const { spawn } = require("node:child_process");
const request = require("supertest");
const webPush = require("web-push");

const { validateVapidConfig, MOTIVOS_VAPID } = require("../../src/config/vapid");
const { loadConfig } = require("../../src/config/env");
const { createApp } = require("../../src/app");
const { buildChannels } = require("../../src/services/notificationChannels");
const { createFakeSupabase } = require("../helpers/fakeSupabase");
const { encrypt } = require("../../src/utils/secureToken");

const BACKEND_DIR = path.resolve(__dirname, "../..");
const FRONTEND = "http://localhost:5173";

const baseEnv = () => ({
  PORT: "3000",
  INTERNAL_API_KEY: ["llave", "interna", "z".repeat(32)].join("-"),
  SUPABASE_URL: "http://127.0.0.1:9",
  SUPABASE_SERVICE_ROLE_KEY: ["rol", "servicio", "w".repeat(20)].join("-"),
  CREDENTIALS_ENCRYPTION_KEY: crypto.randomBytes(32).toString("base64"),
});

// Llaves inválidas pero con apariencia de secreto, para comprobar que no se filtran.
function llavesInvalidas() {
  return {
    publica: `INVALIDA_PUB_${crypto.randomBytes(12).toString("hex")}`,
    privada: `INVALIDA_PRIV_${crypto.randomBytes(12).toString("hex")}`,
  };
}

describe("validateVapidConfig", () => {
  test("llaves válidas: habilitado", () => {
    const k = webPush.generateVAPIDKeys();
    const r = validateVapidConfig({ publicKey: k.publicKey, privateKey: k.privateKey });
    assert.equal(r.enabled, true);
    assert.equal(r.reason, null);
  });

  test("ambas ausentes: deshabilitado (vapid_ausente)", () => {
    assert.deepEqual(validateVapidConfig({}), { enabled: false, reason: MOTIVOS_VAPID.AUSENTE });
  });

  test("solo una llave: deshabilitado (vapid_incompleta)", () => {
    const k = webPush.generateVAPIDKeys();
    assert.equal(validateVapidConfig({ publicKey: k.publicKey }).reason, MOTIVOS_VAPID.INCOMPLETA);
    assert.equal(validateVapidConfig({ privateKey: k.privateKey }).reason, MOTIVOS_VAPID.INCOMPLETA);
  });

  test("formato inválido: deshabilitado (vapid_invalida) sin lanzar", () => {
    const { publica, privada } = llavesInvalidas();
    const r = validateVapidConfig({ publicKey: publica, privateKey: privada });
    assert.deepEqual(r, { enabled: false, reason: MOTIVOS_VAPID.INVALIDA });
  });

  test("pública que no corresponde a la privada: vapid_invalida", () => {
    const a = webPush.generateVAPIDKeys();
    const b = webPush.generateVAPIDKeys();
    assert.equal(validateVapidConfig({ publicKey: a.publicKey, privateKey: b.privateKey }).reason, MOTIVOS_VAPID.INVALIDA);
  });

  test("subject inválido: vapid_invalida", () => {
    const k = webPush.generateVAPIDKeys();
    const r = validateVapidConfig({ publicKey: k.publicKey, privateKey: k.privateKey, subject: "no-es-url" });
    assert.equal(r.reason, MOTIVOS_VAPID.INVALIDA);
  });
});

describe("loadConfig con VAPID opcional", () => {
  test("llave inválida no lanza y deja push deshabilitado sin exponer valores", () => {
    const { publica, privada } = llavesInvalidas();
    const config = loadConfig({ ...baseEnv(), VAPID_PUBLIC_KEY: publica, VAPID_PRIVATE_KEY: privada });
    assert.equal(config.pushEnabled, false);
    assert.equal(config.pushDisabledReason, MOTIVOS_VAPID.INVALIDA);
    assert.equal(config.vapidPublicKey, null);
    assert.equal(config.vapidPrivateKey, null);
    const serializada = JSON.stringify(config);
    assert.ok(!serializada.includes(publica) && !serializada.includes(privada));
  });

  test("llave ausente no lanza", () => {
    const config = loadConfig(baseEnv());
    assert.equal(config.pushEnabled, false);
    assert.equal(config.pushDisabledReason, MOTIVOS_VAPID.AUSENTE);
  });

  test("solo una llave definida ya no tumba el arranque", () => {
    const k = webPush.generateVAPIDKeys();
    const config = loadConfig({ ...baseEnv(), VAPID_PUBLIC_KEY: k.publicKey });
    assert.equal(config.pushEnabled, false);
    assert.equal(config.pushDisabledReason, MOTIVOS_VAPID.INCOMPLETA);
  });

  test("llave válida: push habilitado y la privada no es enumerable", () => {
    const k = webPush.generateVAPIDKeys();
    const config = loadConfig({ ...baseEnv(), VAPID_PUBLIC_KEY: k.publicKey, VAPID_PRIVATE_KEY: k.privateKey });
    assert.equal(config.pushEnabled, true);
    assert.equal(config.vapidPublicKey, k.publicKey);
    assert.equal(config.vapidPrivateKey, k.privateKey);
    assert.ok(!JSON.stringify(config).includes(k.privateKey));
  });
});

describe("buildChannels con llaves rechazadas", () => {
  test("si setVapidDetails lanza, omite web_push sin lanzar ni registrar el error", () => {
    const eventos = [];
    const logger = { info: () => {}, error: () => {}, warn: (e, f) => eventos.push([e, f]) };
    const channels = buildChannels({
      env: { VAPID_PUBLIC_KEY: "x", VAPID_PRIVATE_KEY: "y" },
      logger,
      pushRepo: {},
      webpushImpl: {
        setVapidDetails: () => {
          throw new Error("detalle con valor secreto");
        },
      },
    });
    assert.deepEqual(channels.map((c) => c.name), ["log"]);
    assert.deepEqual(eventos, [["canal_web_push_omitido", { reason: "vapid_invalida" }]]);
  });
});

describe("Endpoints /push con push deshabilitado", () => {
  // Sesión de Google sembrada en el Supabase simulado (mismo formato que authGoogle).
  function crearSesion(db, secret) {
    const userId = crypto.randomUUID();
    const sessionId = crypto.randomBytes(16).toString("hex");
    const exp = Date.now() + 60 * 60 * 1000;
    db.tables.app_users.push({ id: userId, email: "alumno@potros.itson.edu.mx" });
    db.tables.google_app_sessions.push({
      id: crypto.createHash("sha256").update(sessionId).digest("hex"),
      user_id: userId,
      google_id: "g12345",
      expires_at: new Date(exp).toISOString(),
    });
    const token = encrypt({ userId, googleId: "g12345", sessionId, exp }, secret, "google-session");
    return { userId, cookie: `itn41_google_session=${token}` };
  }

  function appSinPush() {
    const { publica, privada } = llavesInvalidas();
    const secret = crypto.randomBytes(32).toString("hex");
    const config = {
      ...loadConfig({ ...baseEnv(), VAPID_PUBLIC_KEY: publica, VAPID_PRIVATE_KEY: privada }),
      credentialsEncryptionKey: crypto.randomBytes(32),
      googleAuthSecret: secret,
    };
    assert.equal(config.pushEnabled, false);
    const db = createFakeSupabase();
    const errores = [];
    const app = createApp({
      config,
      supabase: db.client,
      logger: { info: () => {}, warn: () => {}, error: (...a) => errores.push(a) },
    });
    return { app, db, secret, errores };
  }

  test("GET /push/vapid-public-key responde 503 push_no_disponible", async () => {
    const { app } = appSinPush();
    const res = await request(app).get("/push/vapid-public-key").set("Origin", FRONTEND);
    assert.equal(res.status, 503);
    assert.deepEqual(res.body, { error: "push_no_disponible" });
  });

  test("POST /push/subscriptions responde 503 sin 500 ni stack y no guarda nada", async () => {
    const { app, db, secret, errores } = appSinPush();
    const { cookie } = crearSesion(db, secret);
    const res = await request(app)
      .post("/push/subscriptions")
      .set("Origin", FRONTEND)
      .set("Cookie", cookie)
      .send({ subscription: { endpoint: "https://push.test/1", keys: { p256dh: "a", auth: "b" } } });
    assert.equal(res.status, 503);
    assert.deepEqual(res.body, { error: "push_no_disponible" });
    assert.equal(db.tables.push_subscriptions.length, 0);
    assert.equal(errores.length, 0);
  });

  test("DELETE /push/subscriptions sigue borrando la suscripción propia (204)", async () => {
    const { app, db, secret, errores } = appSinPush();
    const { userId, cookie } = crearSesion(db, secret);
    const otroUserId = crypto.randomUUID();
    db.tables.push_subscriptions.push(
      { id: "sub-1", user_id: userId, endpoint: "https://push.test/propio", p256dh: "a", auth: "b" },
      { id: "sub-2", user_id: otroUserId, endpoint: "https://push.test/ajeno", p256dh: "c", auth: "d" },
    );
    const res = await request(app)
      .delete("/push/subscriptions")
      .set("Origin", FRONTEND)
      .set("Cookie", cookie)
      .send({ endpoint: "https://push.test/propio" });
    assert.equal(res.status, 204);
    assert.deepEqual(db.tables.push_subscriptions.map((s) => s.id), ["sub-2"]);
    assert.equal(errores.length, 0);
  });

  test("DELETE /push/subscriptions mantiene sus controles: 401 sin sesión y 403 por origen", async () => {
    const { app } = appSinPush();
    const sinSesion = await request(app)
      .delete("/push/subscriptions")
      .set("Origin", FRONTEND)
      .send({ endpoint: "https://push.test/1" });
    assert.equal(sinSesion.status, 401);
    const otroOrigen = await request(app)
      .delete("/push/subscriptions")
      .set("Origin", "http://sitio-atacante.test")
      .send({ endpoint: "https://push.test/1" });
    assert.equal(otroOrigen.status, 403);
  });

  test("el preflight OPTIONS sigue respondiendo 204 con CORS", async () => {
    const { app } = appSinPush();
    const res = await request(app).options("/push/subscriptions").set("Origin", FRONTEND);
    assert.equal(res.status, 204);
  });

  test("GET /health responde 200", async () => {
    const { app } = appSinPush();
    const res = await request(app).get("/health");
    assert.equal(res.status, 200);
    assert.deepEqual(res.body, { status: "ok" });
  });
});

// Arranca src/server.js en un puerto libre, espera servidor_iniciado y devuelve
// la salida capturada. Siempre mata el proceso al terminar.
async function arrancarServidor(envExtra) {
  const port = await new Promise((resolve) => {
    const srv = require("node:net").createServer().listen(0, "127.0.0.1", () => {
      const p = srv.address().port;
      srv.close(() => resolve(p));
    });
  });
  const child = spawn(
    process.execPath,
    ["--require", "./tests/helpers/offlineNetwork.cjs", "src/server.js"],
    {
      cwd: BACKEND_DIR,
      env: { PATH: process.env.PATH, ...baseEnv(), PORT: String(port), ...envExtra },
      stdio: ["ignore", "pipe", "pipe"],
    },
  );
  let salida = "";
  child.stdout.on("data", (d) => (salida += d));
  child.stderr.on("data", (d) => (salida += d));

  const resultado = await new Promise((resolve) => {
    const timer = setTimeout(() => resolve({ iniciado: false }), 10_000);
    child.on("exit", (code) => {
      clearTimeout(timer);
      resolve({ iniciado: false, code });
    });
    child.stdout.on("data", () => {
      if (salida.includes("servidor_iniciado")) {
        clearTimeout(timer);
        resolve({ iniciado: true });
      }
    });
  });

  const base = `http://127.0.0.1:${port}`;
  let health = null;
  let llave = null;
  if (resultado.iniciado) {
    health = await fetch(`${base}/health`);
    llave = await fetch(`${base}/push/vapid-public-key`, { headers: { Origin: FRONTEND } });
  }
  child.kill("SIGTERM");
  await new Promise((r) => (child.exitCode !== null ? r() : child.on("exit", r)));
  return { ...resultado, salida, health, llave };
}

describe("Arranque real del backend (src/server.js)", () => {
  test("llave inválida: arranca, /health 200, push 503 y no imprime llaves", async () => {
    const { publica, privada } = llavesInvalidas();
    const r = await arrancarServidor({ VAPID_PUBLIC_KEY: publica, VAPID_PRIVATE_KEY: privada });
    assert.equal(r.iniciado, true, "el backend no arrancó");
    assert.equal(r.health.status, 200);
    assert.equal(r.llave.status, 503);
    assert.deepEqual(await r.llave.json(), { error: "push_no_disponible" });
    assert.ok(!r.salida.includes(publica) && !r.salida.includes(privada), "se imprimió un valor VAPID");
    const avisos = r.salida.split("\n").filter((l) => l.includes("push_deshabilitado"));
    assert.equal(avisos.length, 1, "debe haber un solo aviso de push deshabilitado");
    assert.match(avisos[0], /"reason":"vapid_invalida"/);
  });

  test("llave ausente: arranca, /health 200 y push 503", async () => {
    const r = await arrancarServidor({});
    assert.equal(r.iniciado, true, "el backend no arrancó");
    assert.equal(r.health.status, 200);
    assert.equal(r.llave.status, 503);
    const avisos = r.salida.split("\n").filter((l) => l.includes("push_deshabilitado"));
    assert.equal(avisos.length, 1);
    assert.match(avisos[0], /"reason":"vapid_ausente"/);
  });

  test("llave válida: arranca con push habilitado y nunca imprime la privada", async () => {
    const k = webPush.generateVAPIDKeys();
    const r = await arrancarServidor({ VAPID_PUBLIC_KEY: k.publicKey, VAPID_PRIVATE_KEY: k.privateKey });
    assert.equal(r.iniciado, true, "el backend no arrancó");
    assert.equal(r.health.status, 200);
    assert.equal(r.llave.status, 200);
    assert.deepEqual(await r.llave.json(), { publicKey: k.publicKey });
    assert.ok(!r.salida.includes("push_deshabilitado"));
    assert.ok(!r.salida.includes(k.privateKey) && !r.salida.includes(k.publicKey));
  });
});
