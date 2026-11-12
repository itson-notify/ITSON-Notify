const crypto = require("crypto");

// Entrega de la extracción al backend Express (ITN-25 -> ITN-27):
// POST ${BACKEND_URL}/internal/grade-snapshots con x-api-key.
// Contrato del body y de las respuestas: backend/README.md.
//
// Privacidad: nunca se loguea ni se manda en alertas el body, las
// calificaciones, el correo, la API key ni la URL. Solo run_id, status HTTP,
// número de intento y conteos.
//
// ITN-52 - El correo ya no sale de ALUMNO_EMAIL: el cron lo pasa por alumno (viene
// de /internal/credentials/active). La entrega tampoco alerta: el cron junta las
// fallas de todos los alumnos y manda una sola alerta por corrida.

const RUTA = "/internal/grade-snapshots";
const TIMEOUT_MS = 30_000;
// Reintentos después del primer intento (4 intentos en total).
const MAX_REINTENTOS = 3;
const BACKOFF_BASE_MS = 1_000;
// El backend exige al menos 32 caracteres (backend/README.md).
const MIN_LONGITUD_API_KEY = 32;

const VARIABLES_REQUERIDAS = ["BACKEND_URL", "INTERNAL_API_KEY"];
const RE_CORREO = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

// Devuelve { ok: true, config } o { ok: false, error }. El error nombra las
// variables, nunca sus valores.
function leerConfigEntrega(env = process.env) {
  const faltantes = VARIABLES_REQUERIDAS.filter((nombre) => !env[nombre]?.trim());
  if (faltantes.length > 0) {
    return { ok: false, error: `Faltan variables del servicio: ${faltantes.join(", ")}.` };
  }

  const backendUrl = env.BACKEND_URL.trim().replace(/\/+$/, "");
  let url;
  try {
    url = new URL(backendUrl);
  } catch {
    return { ok: false, error: "BACKEND_URL no es una URL válida." };
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    return { ok: false, error: "BACKEND_URL debe empezar con http:// o https://." };
  }

  const apiKey = env.INTERNAL_API_KEY.trim();
  if (apiKey.length < MIN_LONGITUD_API_KEY) {
    return {
      ok: false,
      error: `INTERNAL_API_KEY debe tener al menos ${MIN_LONGITUD_API_KEY} caracteres.`,
    };
  }

  return { ok: true, config: { backendUrl, endpoint: `${backendUrl}${RUTA}`, apiKey } };
}

// Body del contrato. courses va tal cual sale de extractGrades(): ya tiene la
// forma que valida backend/src/models/gradeSnapshotPayload.js.
function armarPayload({ runId, capturedAt, email, courses }) {
  return {
    run_id: runId,
    captured_at: capturedAt,
    source: "ivirtual",
    user: { email },
    courses,
  };
}

// Solo errores de red, timeout y 5xx se reintentan. 400/401/409/413 no se
// arreglan reenviando lo mismo.
const esReintentable = (status) => status === null || status >= 500;

const esperar = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// Un intento. Devuelve { status, respuesta } o { status: null, error } si la
// petición no llegó a tener respuesta (red o timeout).
async function intentarEnvio({ endpoint, apiKey, body, fetchFn, timeoutMs }) {
  try {
    const res = await fetchFn(endpoint, {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-api-key": apiKey },
      body,
      signal: AbortSignal.timeout(timeoutMs),
    });
    const respuesta = res.ok ? await res.json().catch(() => null) : null;
    return { status: res.status, ok: res.ok, respuesta };
  } catch (error) {
    // Solo el tipo: el mensaje de un error de red puede traer la URL.
    return { status: null, ok: false, error: error?.name ?? "Error" };
  }
}

// Manda el resultado de una extracción correcta del alumno `email`. Devuelve
// { ok: true, runId, respuesta }, { ok: true, omitido: true } o
// { ok: false, runId, status, intentos }. No alerta: lo hace el cron una vez.
async function entregarResultados(
  result,
  {
    config,
    email,
    capturedAt = new Date().toISOString(),
    log = console.log,
    logError = console.error,
    fetchFn = globalThis.fetch,
    randomUUID = crypto.randomUUID,
    sleep = esperar,
    timeoutMs = TIMEOUT_MS,
    maxReintentos = MAX_REINTENTOS,
    backoffBaseMs = BACKOFF_BASE_MS,
  },
) {
  // El backend rechaza courses vacío: haría ver como borradas todas las
  // calificaciones del snapshot anterior.
  if (result.courses.length === 0) {
    log("Extracción sin cursos: no se envía al backend.");
    return { ok: true, omitido: true };
  }
  if (typeof email !== "string" || !RE_CORREO.test(email.trim())) {
    logError("Entrega al backend omitida: la cuenta no trae un correo válido.");
    return { ok: false, runId: null, status: "correo_invalido", intentos: 0 };
  }

  // Un run_id por corrida, el mismo en cada reintento: el backend es
  // idempotente por run_id.
  const runId = randomUUID();
  const body = JSON.stringify(
    armarPayload({ runId, capturedAt, email: email.trim(), courses: result.courses }),
  );

  const totalIntentos = maxReintentos + 1;
  let ultimo;
  let intentos = 0;
  for (let intento = 1; intento <= totalIntentos; intento += 1) {
    intentos = intento;
    ultimo = await intentarEnvio({
      endpoint: config.endpoint,
      apiKey: config.apiKey,
      body,
      fetchFn,
      timeoutMs,
    });

    if (ultimo.ok) {
      const r = ultimo.respuesta ?? {};
      log(
        `Entrega al backend correcta: run_id=${runId} status=${ultimo.status} ` +
          `intento=${intento} baseline=${r.baseline ?? "?"} ` +
          `changes_detected=${r.changes_detected ?? "?"}`,
      );
      return { ok: true, runId, respuesta: ultimo.respuesta };
    }

    const status = ultimo.status ?? ultimo.error;
    logError(`Entrega al backend fallida: run_id=${runId} status=${status} intento=${intento}`);
    if (!esReintentable(ultimo.status) || intento === totalIntentos) break;
    await sleep(backoffBaseMs * 2 ** (intento - 1));
  }

  return { ok: false, runId, status: ultimo.status ?? ultimo.error, intentos };
}

module.exports = {
  entregarResultados,
  leerConfigEntrega,
  armarPayload,
  RUTA,
  TIMEOUT_MS,
  MAX_REINTENTOS,
};
