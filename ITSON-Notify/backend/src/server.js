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
  const pushRepo = createNotificationRepository(supabase);
  // Email si existen RESEND_API_KEY y NOTIFY_EMAIL_TO; web_push si existen llaves VAPID y pushRepo.
  const channels = buildChannels({ env: process.env, logger, pushRepo });
  // ITN-52 - Vinculación real de iVirtual: cambia usuario y contraseña por un token.
  const exchangeToken = createExchangeToken();
  const app = createApp({ config, supabase, logger, channels, exchangeToken });

  app.listen(config.port, () => {
    logger.info("servidor_iniciado", { port: config.port });
  });
}

main();