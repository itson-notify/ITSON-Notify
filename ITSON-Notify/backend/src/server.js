// ITN-27 - Arranque del backend. Toda la lógica vive en app.js.
// En local: npm run dev (lee backend/.env con node --env-file).
// En Railway las variables se capturan en el servicio, sin archivo .env.
const { loadConfig } = require("./config/env");
const { createSupabaseClient } = require("./config/supabase");
const { createApp } = require("./app");
const { createLogger } = require("./utils/logger");
const { buildChannels } = require("./services/notificationChannels");
const { createNotificationRepository } = require("./repositories/notificationRepository");
const { createExchangeToken } = require("./services/ivirtualToken");

function main() {
  let config;
  try {
    config = loadConfig(process.env);
  } catch (error) {
    // El mensaje solo nombra variables, nunca valores.
    console.error(`No se pudo arrancar el backend. ${error.message}`);
    process.exit(1);
  }

  const logger = createLogger();
  const supabase = createSupabaseClient(config);
  const notificationRepo = createNotificationRepository(supabase);
  // Email si existe RESEND_API_KEY: cada aviso va al correo del alumno (app_users.email),
  // salvo que NOTIFY_EMAIL_TO (solo pruebas) lo fuerce a una dirección fija.
  // web_push si existen llaves VAPID.
  const channels = buildChannels({
    env: process.env,
    logger,
    pushRepo: notificationRepo,
    emailRepo: notificationRepo,
  });
  // ITN-52 - Vinculación real de iVirtual: cambia usuario y contraseña por un token.
  const exchangeToken = createExchangeToken();
  const app = createApp({ config, supabase, logger, channels, exchangeToken });

  app.listen(config.port, () => {
    logger.info("servidor_iniciado", { port: config.port });
  });
}

main();