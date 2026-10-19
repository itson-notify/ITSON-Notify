// Cliente mínimo de la API de servicios web de Moodle (iVirtual).
// Usa fetch nativo de Node 20. Las peticiones van por POST con el cuerpo
// form-urlencoded, así el token y la contraseña nunca forman parte de la URL.
// Nunca loguear el token, la contraseña ni el cuerpo de las peticiones.

const BASE_URL = "https://ivirtual.itson.edu.mx";
const TOKEN_URL = `${BASE_URL}/login/token.php`;
const WS_URL = `${BASE_URL}/webservice/rest/server.php`;
const SERVICE = "moodle_mobile_app";

const DEFAULTS = {
  timeoutMs: 15000,
  retries: 2, // reintentos extra, solo en 5xx o fallas de red
  backoffMs: 500, // 500, 1000, 2000...
};

// Error devuelto por Moodle en el JSON ({ exception, errorcode, message } o
// { error, errorcode } en token.php). No se reintenta.
class MoodleError extends Error {
  constructor(errorcode, message) {
    super(message || errorcode || "Error de Moodle");
    this.name = "MoodleError";
    this.errorcode = errorcode || "desconocido";
  }
}

// Error HTTP, de red o de timeout. `retryable` indica si valía la pena reintentar.
class HttpError extends Error {
  constructor(message, { status = null, retryable = false } = {}) {
    super(message);
    this.name = "HttpError";
    this.status = status;
    this.retryable = retryable;
  }
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// Convierte { courseids: [1, 2], options: { a: true } } al formato de Moodle:
// courseids[0]=1&courseids[1]=2&options[a]=1
function encodeParams(params, body = new URLSearchParams(), prefix = "") {
  for (const [key, value] of Object.entries(params)) {
    const name = prefix ? `${prefix}[${key}]` : key;
    if (value === undefined || value === null) continue;
    if (typeof value === "object") {
      encodeParams(value, body, name);
    } else if (typeof value === "boolean") {
      body.append(name, value ? "1" : "0");
    } else {
      body.append(name, String(value));
    }
  }
  return body;
}

// Quita un secreto de un texto por si Moodle lo llegara a repetir en un mensaje.
function redact(text, secret) {
  if (!text || !secret) return text;
  return String(text).split(secret).join("[oculto]");
}

// Una petición con timeout. Lanza HttpError (retryable en 5xx/red/timeout) o
// MoodleError si el JSON trae errorcode.
async function postOnce(url, body, { timeoutMs }) {
  let res;
  try {
    res = await fetch(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
        Accept: "application/json",
      },
      body,
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch (error) {
    const timeout = error.name === "TimeoutError" || error.name === "AbortError";
    throw new HttpError(
      timeout
        ? `iVirtual no respondió en ${timeoutMs} ms`
        : "Falla de red al contactar iVirtual",
      { retryable: true },
    );
  }

  if (res.status >= 500) {
    throw new HttpError(`iVirtual respondió HTTP ${res.status}`, {
      status: res.status,
      retryable: true,
    });
  }
  if (!res.ok) {
    throw new HttpError(`iVirtual respondió HTTP ${res.status}`, {
      status: res.status,
    });
  }

  let data;
  try {
    data = await res.json();
  } catch {
    throw new HttpError("iVirtual devolvió una respuesta que no es JSON", {
      status: res.status,
    });
  }

  if (data && typeof data === "object" && !Array.isArray(data) && data.errorcode) {
    throw new MoodleError(data.errorcode, data.message || data.error);
  }
  return data;
}

// Reintento limitado con backoff exponencial, solo para errores retryable.
async function post(url, body, opts = {}) {
  const { timeoutMs, retries, backoffMs } = { ...DEFAULTS, ...opts };
  for (let intento = 0; ; intento++) {
    try {
      return await postOnce(url, body, { timeoutMs });
    } catch (error) {
      const puedeReintentar = error instanceof HttpError && error.retryable;
      if (!puedeReintentar || intento >= retries) throw error;
      await sleep(backoffMs * 2 ** intento);
    }
  }
}

// Obtiene un token del servicio móvil. El token solo debe vivir en memoria.
async function getToken({ usuario, password }, opts) {
  const body = new URLSearchParams({
    username: usuario,
    password,
    service: SERVICE,
  });
  try {
    const data = await post(TOKEN_URL, body, opts);
    if (!data || typeof data.token !== "string" || !data.token) {
      throw new MoodleError("sintoken", "token.php no devolvió un token");
    }
    return data.token;
  } catch (error) {
    error.message = redact(redact(error.message, password), usuario);
    throw error;
  }
}

// Llama una función del web service y devuelve el JSON ya parseado.
async function callWs(token, wsfunction, params = {}, opts) {
  const body = encodeParams(params);
  body.append("wstoken", token);
  body.append("wsfunction", wsfunction);
  body.append("moodlewsrestformat", "json");
  try {
    return await post(WS_URL, body, opts);
  } catch (error) {
    error.message = `${wsfunction}: ${redact(error.message, token)}`;
    throw error;
  }
}

module.exports = {
  getToken,
  callWs,
  encodeParams,
  MoodleError,
  HttpError,
  BASE_URL,
  DEFAULTS,
};
