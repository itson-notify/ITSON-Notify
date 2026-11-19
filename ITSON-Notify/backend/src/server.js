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
  // Push es opcional: si VAPID falta o es inválida se avisa UNA vez, sin valores.
  if (!config.pushEnabled) {
    logger.warn("push_deshabilitado", { reason: config.pushDisabledReason });
  }
  const supabase = createSupabaseClient(config);
  const notificationRepo = createNotificationRepository(supabase);
  // Email si existe RESEND_API_KEY: cada aviso va al correo del alumno (app_users.email),
  // salvo que NOTIFY_EMAIL_TO (solo pruebas) lo fuerce a una dirección fija.
  // web_push solo si las llaves VAPID pasaron la validación de loadConfig: se
  // toman de config (no de process.env) para no volver a usar llaves inválidas.
  const channels = buildChannels({
    env: {
      RESEND_API_KEY: process.env.RESEND_API_KEY,
      NOTIFY_EMAIL_TO: process.env.NOTIFY_EMAIL_TO,
      NOTIFY_EMAIL_FROM: process.env.NOTIFY_EMAIL_FROM,
      VAPID_PUBLIC_KEY: config.vapidPublicKey,
      VAPID_PRIVATE_KEY: config.vapidPrivateKey,
      VAPID_SUBJECT: config.vapidSubject,
    },
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