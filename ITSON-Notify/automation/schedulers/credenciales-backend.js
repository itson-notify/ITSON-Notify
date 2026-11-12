// ITN-52 - Llamadas del worker a /internal/credentials del backend, con x-api-key:
//   GET  /internal/credentials/active?portal=ivirtual  a quién consultar
//   POST /internal/credentials/get                     token del alumno
//   POST /internal/credentials/needs-relink            el token ya no sirve
// Contrato: backend/README.md.
//
// Privacidad: nunca se loguea ni se devuelve en un error el correo, el token, la API
// key, la URL ni el body. Los resultados solo llevan el status HTTP o el nombre del
// error de red. El token solo sale en el resultado de leerToken y el cron lo descarta
// al terminar con esa cuenta.

const PORTAL = "ivirtual";
const KIND = "ivirtual_token";
const TIMEOUT_MS = 15_000;
// Reintentos después del primer intento, solo en red, timeout o 5xx.
const MAX_REINTENTOS = 2;
const BACKOFF_BASE_MS = 1_000;

const esperar = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const esReintentable = (status) => status === null || status >= 500;

function crearClienteCredenciales({
  config,
  fetchFn = globalThis.fetch,
  sleep = esperar,
  timeoutMs = TIMEOUT_MS,
  maxReintentos = MAX_REINTENTOS,
  backoffBaseMs = BACKOFF_BASE_MS,
}) {
  const base = `${config.backendUrl}/internal/credentials`;

  // Devuelve { ok, status, datos }. status es null si no hubo respuesta; entonces
  // `error` lleva solo el nombre del error (el mensaje puede traer la URL).
  async function llamar(metodo, ruta, body) {
    let ultimo;
    for (let intento = 0; intento <= maxReintentos; intento += 1) {
      try {
        const res = await fetchFn(`${base}${ruta}`, {
          method: metodo,
          headers: {
            "x-api-key": config.apiKey,
            Accept: "application/json",
            ...(body ? { "Content-Type": "application/json" } : {}),
          },
          body: body ? JSON.stringify(body) : undefined,
          signal: AbortSignal.timeout(timeoutMs),
        });
        const datos = res.ok ? await res.json().catch(() => null) : null;
        ultimo = { ok: res.ok, status: res.status, datos };
      } catch (error) {
        ultimo = { ok: false, status: null, error: error?.name ?? "Error" };
      }
      if (ultimo.ok || !esReintentable(ultimo.status) || intento === maxReintentos) break;
      await sleep(backoffBaseMs * 2 ** intento);
    }
    return ultimo;
  }

  const ref = (email) => ({ user: { email }, portal: PORTAL, kind: KIND });
  const fallo = (r) => ({ ok: false, status: r.status ?? r.error });

  // { ok: true, emails } o { ok: false, status }.
  async function listarActivas() {
    const r = await llamar("GET", `/active?portal=${PORTAL}`);
    if (!r.ok) return fallo(r);
    const students = r.datos?.students;
    if (!Array.isArray(students)) return { ok: false, status: "respuesta_invalida" };
    const emails = students.map((s) => s?.email).filter((e) => typeof e === "string" && e.trim() !== "");
    return { ok: true, emails };
  }

  // { ok: true, token } o { ok: false, status }. 404: la desvincularon; 409: ya
  // está en needs_relink.
  async function leerToken(email) {
    const r = await llamar("POST", "/get", ref(email));
    if (!r.ok) return fallo(r);
    const token = r.datos?.secret;
    if (typeof token !== "string" || token === "") return { ok: false, status: "respuesta_invalida" };
    return { ok: true, token };
  }

  // { ok: true } o { ok: false, status }.
  async function marcarRevinculacion(email, reason = "credenciales") {
    const r = await llamar("POST", "/needs-relink", { ...ref(email), reason });
    return r.ok ? { ok: true } : fallo(r);
  }

  return { listarActivas, leerToken, marcarRevinculacion };
}

module.exports = { crearClienteCredenciales, PORTAL, KIND };
