// ITN-27 / ITN-40 - Configuración del backend leída de variables de entorno.
// Si falta alguna o es inválida, el arranque falla con un mensaje que nombra
// la variable, nunca su valor.

const REQUERIDAS = ["PORT", "INTERNAL_API_KEY", "SUPABASE_URL", "SUPABASE_SERVICE_ROLE_KEY"];

const GOOGLE_OAUTH_VARIABLES = [
  "GOOGLE_CLIENT_ID",
  "GOOGLE_CLIENT_SECRET",
  "GOOGLE_REDIRECT_URI",
  "GOOGLE_OAUTH_SCOPES",
];

const ALLOWED_GOOGLE_OAUTH_SCOPE = "https://www.googleapis.com/auth/classroom.courses.readonly";
const ALLOWED_GOOGLE_OAUTH_SCOPES = Object.freeze([ALLOWED_GOOGLE_OAUTH_SCOPE]);
const ALLOWED_GOOGLE_OAUTH_ENABLED_VALUES = Object.freeze(["true", "false", "1", "0"]);

// La llave compartida con el worker debe ser difícil de adivinar
// (p. ej. `openssl rand -hex 32`).
const MIN_API_KEY_LENGTH = 32;

function isValidRedirectUri(rawUri) {
  let parsed;
  try {
    parsed = new URL(rawUri);
  } catch {
    return false;
  }

  if (parsed.username !== "" || parsed.password !== "" || parsed.hash !== "") {
    return false;
  }

  if (parsed.protocol === "https:") {
    return Boolean(parsed.hostname);
  }

  if (parsed.protocol === "http:") {
    return parsed.hostname === "localhost" || parsed.hostname === "127.0.0.1";
  }

  return false;
}

function parseAndValidateScopes(rawScopes) {
  const scopes = rawScopes
    .split(/[\s,]+/)
    .map((s) => s.trim())
    .filter(Boolean);

  if (scopes.length === 0) {
    return { valid: false, scopes: [] };
  }

  const allAllowed = scopes.every((scope) => ALLOWED_GOOGLE_OAUTH_SCOPES.includes(scope));
  if (!allAllowed) {
    return { valid: false, scopes: [] };
  }

  return { valid: true, scopes: Array.from(new Set(scopes)) };
}

function createDisabledGoogleOAuthConfig() {
  return Object.freeze({
    enabled: false,
    clientId: null,
    clientSecret: null,
    redirectUri: null,
    scopes: Object.freeze([]),
  });
}

function loadGoogleOAuthConfig(valor) {
  const oauthFlag = valor("GOOGLE_OAUTH_ENABLED").toLowerCase();

  if (oauthFlag !== "" && !ALLOWED_GOOGLE_OAUTH_ENABLED_VALUES.includes(oauthFlag)) {
    return {
      faltan: [],
      invalidas: ["GOOGLE_OAUTH_ENABLED (booleano inválido)"],
      config: createDisabledGoogleOAuthConfig(),
    };
  }

  const explicitEnabled = oauthFlag === "true" || oauthFlag === "1";
  const explicitDisabled = oauthFlag === "false" || oauthFlag === "0";
  const anyOAuthVarDefined = GOOGLE_OAUTH_VARIABLES.some((name) => valor(name) !== "");

  // Si GOOGLE_OAUTH_ENABLED es false/0 (incluso con otras variables GOOGLE_* definidas)
  // o si está ausente/vacía sin otras variables OAuth, se deshabilita sin consumir valores.
  if (explicitDisabled || (!explicitEnabled && !anyOAuthVarDefined)) {
    return {
      faltan: [],
      invalidas: [],
      config: createDisabledGoogleOAuthConfig(),
    };
  }

  const faltan = GOOGLE_OAUTH_VARIABLES.filter((name) => valor(name) === "");
  const invalidas = [];

  const clientId = valor("GOOGLE_CLIENT_ID");
  const clientSecret = valor("GOOGLE_CLIENT_SECRET");
  const redirectUri = valor("GOOGLE_REDIRECT_URI");
  const rawScopes = valor("GOOGLE_OAUTH_SCOPES");

  if (redirectUri !== "" && !isValidRedirectUri(redirectUri)) {
    invalidas.push(
      "GOOGLE_REDIRECT_URI (URL https o http://localhost / http://127.0.0.1 en desarrollo, sin credenciales ni fragmentos)",
    );
  }

  let parsedScopes = [];
  if (rawScopes !== "") {
    const scopeResult = parseAndValidateScopes(rawScopes);
    if (!scopeResult.valid) {
      invalidas.push(
        `GOOGLE_OAUTH_SCOPES (solo se permite el scope de lectura ${ALLOWED_GOOGLE_OAUTH_SCOPE})`,
      );
    } else {
      parsedScopes = scopeResult.scopes;
    }
  }

  const oauthConfig = {
    enabled: true,
    clientId,
    redirectUri,
    scopes: Object.freeze(parsedScopes),
  };

  // clientSecret no es enumerable para evitar exposición accidental en logs o serialización JSON.
  Object.defineProperty(oauthConfig, "clientSecret", {
    value: clientSecret,
    writable: false,
    enumerable: false,
    configurable: false,
  });

  return {
    faltan,
    invalidas,
    config: Object.freeze(oauthConfig),
  };
}

function loadConfig(env = process.env) {
  const valor = (name) => (typeof env[name] === "string" ? env[name].trim() : "");

  const faltanBase = REQUERIDAS.filter((name) => valor(name) === "");
  const oauthResult = loadGoogleOAuthConfig(valor);

  const faltan = [...faltanBase, ...oauthResult.faltan];
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

  invalidas.push(...oauthResult.invalidas);

  const frontendUrl = valor("FRONTEND_URL") || "http://localhost:5173";
  if (!isValidRedirectUri(frontendUrl) || new URL(frontendUrl).search) {
    invalidas.push("FRONTEND_URL (URL https o loopback local, sin query ni fragmentos)");
  }
  const googleCookieSameSite = valor("GOOGLE_COOKIE_SAME_SITE") || "lax";
  if (!["lax", "none"].includes(googleCookieSameSite)) {
    invalidas.push("GOOGLE_COOKIE_SAME_SITE (lax o none)");
  }
  if (googleCookieSameSite === "none" && oauthResult.config.enabled &&
      (!oauthResult.config.redirectUri.startsWith("https:") || !frontendUrl.startsWith("https:"))) {
    invalidas.push("GOOGLE_COOKIE_SAME_SITE (none requiere HTTPS en backend y frontend)");
  }
  const googleAuthSecret = valor("GOOGLE_AUTH_SECRET");
  if (googleAuthSecret && googleAuthSecret.length < 32) {
    invalidas.push("GOOGLE_AUTH_SECRET (mínimo 32 caracteres)");
  }

  if (invalidas.length > 0) {
    throw new Error(`Variables de entorno inválidas: ${invalidas.join(", ")}`);
  }

  const config = {
    frontendUrl,
    googleCookieSameSite,
    port,
    internalApiKey: valor("INTERNAL_API_KEY"),
    supabaseUrl: valor("SUPABASE_URL"),
    supabaseServiceRoleKey: valor("SUPABASE_SERVICE_ROLE_KEY"),
    googleOAuth: oauthResult.config,
  };
  Object.defineProperty(config, "googleAuthSecret", { value: googleAuthSecret, enumerable: false });
  return config;
}

module.exports = {
  loadConfig,
  REQUERIDAS,
  MIN_API_KEY_LENGTH,
  GOOGLE_OAUTH_VARIABLES,
  ALLOWED_GOOGLE_OAUTH_SCOPE,
  ALLOWED_GOOGLE_OAUTH_SCOPES,
  ALLOWED_GOOGLE_OAUTH_ENABLED_VALUES,
};
