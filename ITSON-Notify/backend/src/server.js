// ITN-27 - Arranque del backend. Toda la lógica vive en app.js.
// En local: npm run dev (lee backend/.env con node --env-file).
// En Railway las variables se capturan en el servicio, sin archivo .env.
const { loadConfig } = require("./config/env");
const { createSupabaseClient } = require("./config/supabase");
const { createApp } = require("./app");
const { createLogger } = require("./utils/logger");

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
  const app = createApp({ config, supabase, logger });

  app.listen(config.port, () => {
    logger.info("servidor_iniciado", { port: config.port });
  });
}

main();
