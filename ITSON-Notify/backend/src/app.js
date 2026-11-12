// ITN-27 - App de Express, separada del arranque (server.js) para probarla con
// supertest. Las dependencias (config, cliente de Supabase, logger, canales de
// notificación) se inyectan: las pruebas usan un Supabase simulado. Sin
// `channels`, se arman con `buildChannels`.
const express = require("express");
const { requireApiKey } = require("./middleware/apiKey");
const { createLogger } = require("./utils/logger");
const { gradeSnapshotsRouter } = require("./routes/gradeSnapshots");
const { credentialsRouter } = require("./routes/credentials");
const { authGoogleRouter, getGoogleSession, sessionHash } = require("./routes/authGoogle");
const { studentApiRouter } = require("./routes/studentApi");
const { buildChannels } = require("./services/notificationChannels");
const { createNotificationRepository } = require("./repositories/notificationRepository");
const { credentialCryptoFromConfig } = require("./services/credentialCrypto");

// Solo el origen exacto del frontend, con cookies.
function frontendCors(config, methods) {
  return (req, res, next) => {
    res.setHeader("Access-Control-Allow-Origin", new URL(config.frontendUrl || "http://localhost:5173").origin);
    res.setHeader("Access-Control-Allow-Credentials", "true");
    res.setHeader("Access-Control-Allow-Headers", "Content-Type");
    res.setHeader("Access-Control-Allow-Methods", methods);
    if (req.method === "OPTIONS") return res.sendStatus(204);
    next();
  };
}

function createApp({
  config,
  supabase,
  logger = createLogger(),
  now = () => Date.now(),
  channels,
  // ITN-51 - Puerto de ITN-52 para cambiar usuario y contraseña de iVirtual por un
  // token. Sin él, PUT /api/credentials/ivirtual responde 501.
  exchangeToken,
  linkLimiter,
}) {
  if (!config?.internalApiKey) throw new Error("createApp requiere config.internalApiKey");
  if (!config?.credentialsEncryptionKey) throw new Error("createApp requiere config.credentialsEncryptionKey");
  if (!supabase) throw new Error("createApp requiere un cliente de Supabase");

  const notificationRepo = createNotificationRepository(supabase);
  const activeChannels =
    channels ??
    buildChannels({
      env: {
        VAPID_PUBLIC_KEY: config.vapidPublicKey,
        VAPID_PRIVATE_KEY: config.vapidPrivateKey,
        VAPID_SUBJECT: config.vapidSubject,
      },
      logger,
      pushRepo: notificationRepo,
    });

  const app = express();
  app.disable("x-powered-by");

  const frontendOrigin = new URL(config.frontendUrl || "http://localhost:5173").origin;
  const credentialCrypto = credentialCryptoFromConfig(config);

  // Sin autenticación y sin revelar configuración ni estado de dependencias.
  app.get("/health", (req, res) => {
    res.json({ status: "ok" });
  });

  // Rutas del worker. La llave se revisa ANTES de parsear el body.
  app.use("/internal", requireApiKey(config.internalApiKey), express.json({ limit: "1mb" }));
  app.use("/internal/grade-snapshots", gradeSnapshotsRouter({ supabase, logger, now, channels: activeChannels }));
  app.use(
    "/internal/credentials",
    credentialsRouter({ supabase, logger, now, credentialCrypto }),
  );

  // Autenticación y autorización con Google Classroom (ITN-41)
  app.use(
    "/auth/google",
    frontendCors(config, "GET, POST, DELETE, OPTIONS"),
    authGoogleRouter({ config, supabase, logger, now }),
  );

  // Lecturas del alumno con sesión de Google (ITN-53) y vinculación de iVirtual (ITN-51)
  app.use(
    "/api",
    frontendCors(config, "GET, POST, PUT, DELETE, OPTIONS"),
    studentApiRouter({ config, supabase, now, logger, credentialCrypto, exchangeToken, linkLimiter }),
  );

  // Suscripciones Web Push del navegador móvil
  app.use("/push", frontendCors(config, "GET, POST, DELETE, OPTIONS"), express.json({ limit: "64kb" }));

  app.get("/push/vapid-public-key", (req, res) => {
    if (!config.vapidPublicKey) return res.status(503).json({ error: "push_no_disponible" });
    res.json({ publicKey: config.vapidPublicKey });
  });

  app.post("/push/subscriptions", async (req, res, next) => {
    if (req.get("origin") !== frontendOrigin) {
      return res.status(403).json({ error: "origen_no_permitido" });
    }
    try {
      const session = await getGoogleSession(req, { config, supabase, now });
      if (!session) return res.status(401).json({ error: "no_autenticado" });

      const { userId: bodyUserId, subscription } = req.body ?? {};
      if (bodyUserId !== undefined && bodyUserId !== session.userId) {
        return res.status(403).json({ error: "no_autorizado" });
      }

      const endpoint = subscription?.endpoint;
      const p256dh = subscription?.keys?.p256dh;
      const auth = subscription?.keys?.auth;
      if (!endpoint || !p256dh || !auth) {
        return res.status(400).json({ error: "suscripcion_invalida" });
      }

      const result = await notificationRepo.savePushSubscription({
        userId: session.userId,
        sessionId: sessionHash(session.sessionId),
        endpoint,
        p256dh,
        auth,
        userAgent: req.headers["user-agent"] ?? null,
      });
      if (result?.forbidden) {
        return res.status(403).json({ error: "no_autorizado" });
      }
      res.status(201).json({ status: "subscribed" });
    } catch (err) {
      next(err);
    }
  });

  app.delete("/push/subscriptions", async (req, res, next) => {
    if (req.get("origin") !== frontendOrigin) {
      return res.status(403).json({ error: "origen_no_permitido" });
    }
    try {
      const session = await getGoogleSession(req, { config, supabase, now });
      if (!session) return res.status(401).json({ error: "no_autenticado" });

      const { userId: bodyUserId, endpoint } = req.body ?? {};
      if (bodyUserId !== undefined && bodyUserId !== session.userId) {
        return res.status(403).json({ error: "no_autorizado" });
      }
      if (!endpoint) return res.status(400).json({ error: "datos_incompletos" });

      const result = await notificationRepo.deletePushSubscription(session.userId, endpoint);
      if (result?.forbidden) {
        return res.status(403).json({ error: "no_autorizado" });
      }
      res.status(204).end();
    } catch (err) {
      next(err);
    }
  });

  app.use((req, res) => {
    res.status(404).json({ error: "no_encontrado" });
  });

  // Errores no controlados. Nunca se devuelve ni se loguea err.message ni err.body:
  // pueden traer fragmentos del body (JSON mal formado, con la contraseña de
  // ITN-51) o mensajes de Supabase.
  app.use((err, req, res, next) => {
    if (err?.type === "entity.parse.failed") {
      return res.status(400).json({ error: "cuerpo_invalido" });
    }
    if (err?.type === "entity.too.large") {
      return res.status(413).json({ error: "cuerpo_demasiado_grande" });
    }
    logger.error("error_no_controlado", { error_code: err?.code ?? null });
    return res.status(500).json({ error: "error_interno" });
  });

  return app;
}

module.exports = { createApp };
