// ITN-52 - Cliente mínimo de login/token.php de iVirtual (Moodle) para la vinculación.
//
// Duplicado a propósito: es una copia reducida de getToken de
// automation/rpa/ivirtual-api/client.js. El backend y el worker son servicios
// distintos en Railway y el backend no puede importar de automation/. Si cambia
// la forma de pedir el token, hay que cambiar los dos.
//
// Reglas:
//   - Solo POST con el cuerpo form-urlencoded: usuario y contraseña nunca van en la URL.
//   - fetch nativo, timeout por intento y reintento solo en red, timeout o 5xx.
//   - Los mensajes de error pasan por redact del usuario y la contraseña. Aun así,
//     la ruta nunca los lleva a los logs ni a la respuesta.
//   - El token solo se devuelve; nada aquí lo guarda ni lo loguea.

const TOKEN_URL = "https://ivirtual.itson.edu.mx/login/token.php";
const SERVICE = "moodle_mobile_app";

const DEFAULTS = {
  timeoutMs: 15000,
  retries: 2, // reintentos extra, solo en 5xx o fallas de red
  backoffMs: 500, // 500, 1000...
};

// errorcode de token.php que significan que el alumno debe cambiar la contraseña
// en el portal. Reintentar no sirve.
const ERRORES_CAMBIO_PASSWORD = new Set(["forcepasswordchangenotice", "passwordisexpired"]);

// errorcode es el de Moodle o, para fallas propias, "red", "timeout", "http" o
// "respuesta_invalida". `retryable` indica si valía la pena reintentar.
class IvirtualTokenError extends Error {
  constructor(errorcode, message, { status = null, retryable = false } = {}) {
    super(message || errorcode);
    this.name = "IvirtualTokenError";
    this.errorcode = errorcode || "desconocido";
    this.status = status;
    this.retryable = retryable;
  }
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// Quita un secreto de un texto por si Moodle lo llegara a repetir en un mensaje.
function redact(text, secret) {
  if (!text || !secret) return text;
  return String(text).split(secret).join("[oculto]");
}

async function postOnce(body, { timeoutMs, fetchFn }) {
  let res;
  try {
    res = await fetchFn(TOKEN_URL, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded", Accept: "application/json" },
      body,
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch (error) {
    const timeout = error?.name === "TimeoutError" || error?.name === "AbortError";
    throw new IvirtualTokenError(
      timeout ? "timeout" : "red",
      timeout ? `iVirtual no respondió en ${timeoutMs} ms` : "Falla de red al contactar iVirtual",
      { retryable: true },
    );
  }

  if (res.status >= 500) {
    throw new IvirtualTokenError("http", `iVirtual respondió HTTP ${res.status}`, { status: res.status, retryable: true });
  }
  if (!res.ok) {
    throw new IvirtualTokenError("http", `iVirtual respondió HTTP ${res.status}`, { status: res.status });
  }

  let data;
  try {
    data = await res.json();
  } catch {
    throw new IvirtualTokenError("respuesta_invalida", "iVirtual devolvió una respuesta que no es JSON", {
      status: res.status,
    });
  }
  if (data && typeof data === "object" && !Array.isArray(data) && data.errorcode) {
    throw new IvirtualTokenError(String(data.errorcode), data.message || data.error);
  }
  if (!data || typeof data.token !== "string" || !data.token) {
    throw new IvirtualTokenError("sintoken", "token.php no devolvió un token");
  }
  return data.token;
}

// Pide un token del servicio móvil. Devuelve el token o lanza IvirtualTokenError.
async function requestToken({ username, password }, opts = {}) {
  const { timeoutMs, retries, backoffMs } = { ...DEFAULTS, ...opts };
  const fetchFn = opts.fetchFn ?? globalThis.fetch;
  const espera = opts.sleep ?? sleep;
  const body = new URLSearchParams({ username, password, service: SERVICE });
  try {
    for (let intento = 0; ; intento++) {
      try {
        return await postOnce(body, { timeoutMs, fetchFn });
      } catch (error) {
        if (!(error instanceof IvirtualTokenError && error.retryable) || intento >= retries) throw error;
        await espera(backoffMs * 2 ** intento);
      }
    }
  } catch (error) {
    error.message = redact(redact(error.message, password), username);
    throw error;
  }
}

// ITN-52 - Puerto exchangeToken de studentCredentials.js. Contrato ampliado:
//   - resuelve con el token (texto) si iVirtual aceptó;
//   - resuelve con { ok: false, reason: "credenciales" } ante invalidlogin;
//   - resuelve con { ok: false, reason: "cambio_password" } ante
//     forcepasswordchangenotice o passwordisexpired;
//   - lanza ante cualquier otra falla (red, 5xx tras reintentos, otro errorcode).
function createExchangeToken(opts = {}) {
  return async function exchangeToken({ username, password }) {
    try {
      return await requestToken({ username, password }, opts);
    } catch (error) {
      if (error instanceof IvirtualTokenError && error.errorcode === "invalidlogin") {
        return { ok: false, reason: "credenciales" };
      }
      if (error instanceof IvirtualTokenError && ERRORES_CAMBIO_PASSWORD.has(error.errorcode)) {
        return { ok: false, reason: "cambio_password" };
      }
      throw error;
    }
  };
}

module.exports = { requestToken, createExchangeToken, IvirtualTokenError, TOKEN_URL, SERVICE, DEFAULTS };
