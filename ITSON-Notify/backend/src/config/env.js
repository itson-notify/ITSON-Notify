// ITN-27 - Configuración del backend leída de variables de entorno.
// Si falta alguna o es inválida, el arranque falla con un mensaje que nombra
// la variable, nunca su valor.

const REQUERIDAS = ["PORT", "INTERNAL_API_KEY", "SUPABASE_URL", "SUPABASE_SERVICE_ROLE_KEY"];

// La llave compartida con el worker debe ser difícil de adivinar
// (p. ej. `openssl rand -hex 32`).
const MIN_API_KEY_LENGTH = 32;

function loadConfig(env = process.env) {
  const valor = (name) => (typeof env[name] === "string" ? env[name].trim() : "");

  const faltan = REQUERIDAS.filter((name) => valor(name) === "");
  if (faltan.length > 0) {
    throw new Error(`Faltan variables de entorno: ${faltan.join(", ")}`);
  }

  const invalidas = [];

  const port = Number(valor("PORT"));
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    invalidas.push("PORT (entero entre 1 y 65535)");
  }

  if (valor("INTERNAL_API_KEY").length < MIN_API_KEY_LENGTH) {
    invalidas.push(`INTERNAL_API_KEY (mínimo ${MIN_API_KEY_LENGTH} caracteres)`);
  }

  let supabaseUrl;
  try {
    supabaseUrl = new URL(valor("SUPABASE_URL"));
  } catch {
    supabaseUrl = null;
  }
  if (!supabaseUrl || !["https:", "http:"].includes(supabaseUrl.protocol)) {
    invalidas.push("SUPABASE_URL (URL http o https)");
  }

  if (invalidas.length > 0) {
    throw new Error(`Variables de entorno inválidas: ${invalidas.join(", ")}`);
  }

  return {
    port,
    internalApiKey: valor("INTERNAL_API_KEY"),
    supabaseUrl: valor("SUPABASE_URL"),
    supabaseServiceRoleKey: valor("SUPABASE_SERVICE_ROLE_KEY"),
  };
}

module.exports = { loadConfig, REQUERIDAS, MIN_API_KEY_LENGTH };
