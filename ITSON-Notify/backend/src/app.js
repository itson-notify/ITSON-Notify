// ITN-27 - App de Express, separada del arranque (server.js) para probarla con
// supertest. Las dependencias (config, cliente de Supabase, logger, canales de
// notificación) se inyectan: las pruebas usan un Supabase simulado. Sin
// `channels`, se arman con `buildChannels`.
const express = require("express");
const { requireApiKey } = require("./middleware/apiKey");
const { createLogger } = require("./utils/logger");
const { gradeSnapshotsRouter } = require("./routes/gradeSnapshots");
const { credentialsRouter } = require("./routes/credentials");
const { authGoogleRouter } = require("./routes/authGoogle");
const { buildChannels } = require("./services/notificationChannels");
const { createNotificationRepository } = require("./repositories/notificationRepository");
const { credentialCryptoFromConfig } = require("./services/credentialCrypto");

function createApp({
  config,
  supabase,
  logger = createLogger(),
  now = () => Date.now(),
  channels,
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

  const setCors = (req, res, next) => {
    res.setHeader("Access-Control-Allow-Origin", new URL(config.frontendUrl || "http://localhost:5173").origin);
    res.setHeader("Access-Control-Allow-Credentials", "true");
    res.setHeader("Access-Control-Allow-Headers", "Content-Type");
    res.setHeader("Access-Control-Allow-Methods", "GET, POST, DELETE, OPTIONS");
    if (req.method === "OPTIONS") return res.sendStatus(204);
    next();
  };

  // Sin autenticación y sin revelar configuración ni estado de dependencias.
  app.get("/health", (req, res) => {
    res.json({ status: "ok" });
  });

  // Rutas del worker. La llave se revisa ANTES de parsear el body.
  app.use("/internal", requireApiKey(config.internalApiKey), express.json({ limit: "1mb" }));
  app.use("/internal/grade-snapshots", gradeSnapshotsRouter({ supabase, logger, now, channels: activeChannels }));
  app.use(
    "/internal/credentials",
    credentialsRouter({ supabase, logger, now, credentialCrypto: credentialCryptoFromConfig(config) }),
  );

  // Autenticación y autorización con Google Classroom (ITN-41)
  app.use("/auth/google", setCors, authGoogleRouter({ config, supabase, logger, now }));

  // Suscripciones Web Push del navegador móvil
  app.use("/push", setCors, express.json({ limit: "64kb" }));

  app.get("/push/vapid-public-key", (req, res) => {
    if (!config.vapidPublicKey) return res.status(503).json({ error: "push_no_disponible" });
    res.json({ publicKey: config.vapidPublicKey });
  });

  app.post("/push/subscriptions", async (req, res, next) => {
    try {
      const { userId, subscription } = req.body ?? {};
      const endpoint = subscription?.endpoint;
      const p256dh = subscription?.keys?.p256dh;
      const auth = subscription?.keys?.auth;
      if (!userId || !endpoint || !p256dh || !auth) {
        return res.status(400).json({ error: "suscripcion_invalida" });
      }
      await notificationRepo.savePushSubscription({
        userId,
        endpoint,
        p256dh,
        auth,
        userAgent: req.headers["user-agent"] ?? null,
      });
      res.status(201).json({ status: "subscribed" });
    } catch (err) {
      next(err);
    }
  });

  app.delete("/push/subscriptions", async (req, res, next) => {
    try {
      const { userId, endpoint } = req.body ?? {};
      if (!userId || !endpoint) return res.status(400).json({ error: "datos_incompletos" });
      await notificationRepo.deletePushSubscription(userId, endpoint);
      res.status(204).end();
    } catch (err) {
      next(err);
    }
  });

  app.use((req, res) => {
    res.status(404).json({ error: "no_encontrado" });
  });

  // Errores no controlados. Nunca se devuelve ni se loguea err.message: puede
  // traer fragmentos del body (JSON mal formado) o mensajes de Supabase.
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