// ITN-27 - App de Express, separada del arranque (server.js) para probarla con
// supertest. Las dependencias (config, cliente de Supabase, logger, canales de
// notificación) se inyectan: las pruebas usan un Supabase simulado. Sin
// `channels`, solo se usa el canal log.
const express = require("express");
const { requireApiKey } = require("./middleware/apiKey");
const { createLogger } = require("./utils/logger");
const { gradeSnapshotsRouter } = require("./routes/gradeSnapshots");
const { credentialsRouter } = require("./routes/credentials");
const { authGoogleRouter } = require("./routes/authGoogle");
const { studentApiRouter } = require("./routes/studentApi");
const { buildChannels } = require("./services/notificationChannels");
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
  channels = buildChannels({ env: {}, logger }),
}) {
  if (!config?.internalApiKey) throw new Error("createApp requiere config.internalApiKey");
  if (!config?.credentialsEncryptionKey) throw new Error("createApp requiere config.credentialsEncryptionKey");
  if (!supabase) throw new Error("createApp requiere un cliente de Supabase");

  const app = express();
  app.disable("x-powered-by");

  // Sin autenticación y sin revelar configuración ni estado de dependencias.
  app.get("/health", (req, res) => {
    res.json({ status: "ok" });
  });

  // Rutas del worker. La llave se revisa ANTES de parsear el body.
  app.use("/internal", requireApiKey(config.internalApiKey), express.json({ limit: "1mb" }));
  app.use("/internal/grade-snapshots", gradeSnapshotsRouter({ supabase, logger, now, channels }));
  app.use(
    "/internal/credentials",
    credentialsRouter({ supabase, logger, now, credentialCrypto: credentialCryptoFromConfig(config) }),
  );

  // Autenticación y autorización con Google Classroom (ITN-41)
  app.use(
    "/auth/google",
    frontendCors(config, "GET, POST, DELETE, OPTIONS"),
    authGoogleRouter({ config, supabase, logger, now }),
  );

  // Lecturas del alumno con sesión de Google (ITN-53)
  app.use("/api", frontendCors(config, "GET, POST, OPTIONS"), studentApiRouter({ config, supabase, now }));

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
