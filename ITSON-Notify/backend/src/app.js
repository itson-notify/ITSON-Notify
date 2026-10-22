// ITN-27 - App de Express, separada del arranque (server.js) para probarla con
// supertest. Las dependencias (config, cliente de Supabase, logger) se
// inyectan: las pruebas usan un Supabase simulado.
const express = require("express");
const { requireApiKey } = require("./middleware/apiKey");
const { createLogger } = require("./utils/logger");

function createApp({ config, supabase, logger = createLogger(), now = () => Date.now() }) {
  if (!config?.internalApiKey) throw new Error("createApp requiere config.internalApiKey");
  if (!supabase) throw new Error("createApp requiere un cliente de Supabase");

  const app = express();
  app.disable("x-powered-by");

  // Sin autenticación y sin revelar configuración ni estado de dependencias.
  app.get("/health", (req, res) => {
    res.json({ status: "ok" });
  });

  // Rutas del worker. La llave se revisa ANTES de parsear el body.
  app.use("/internal", requireApiKey(config.internalApiKey), express.json({ limit: "1mb" }));

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
