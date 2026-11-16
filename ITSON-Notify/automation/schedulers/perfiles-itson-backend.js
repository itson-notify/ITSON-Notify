// ITN-55 - GET ${BACKEND_URL}/internal/itson-profiles/active con x-api-key: a quién
// consultar en la API REST de ITSON, con su matrícula y carrera. Solo lectura.
// Contrato: backend/README.md.
//
// Privacidad: nunca se loguea ni se devuelve en un error el correo, la matrícula, la
// carrera, la API key ni la URL. Los resultados de error solo llevan el status HTTP o
// el nombre del error de red.

const RUTA = "/internal/itson-profiles/active";
const TIMEOUT_MS = 15_000;
const MAX_REINTENTOS = 2;
const BACKOFF_BASE_MS = 1_000;

const RE_MATRICULA = /^00000\d{6}$/;
const RE_CARRERA = /^[A-Z]{2,8}$/;
const RE_CORREO = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

const esperar = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const esReintentable = (status) => status === null || status >= 500;

function crearClientePerfilesItson({
  config,
  fetchFn = globalThis.fetch,
  sleep = esperar,
  timeoutMs = TIMEOUT_MS,
  maxReintentos = MAX_REINTENTOS,
  backoffBaseMs = BACKOFF_BASE_MS,
}) {
  // { ok: true, alumnos: [{ email, matricula, career }], descartados } o
  // { ok: false, status }. Una entrada con forma inválida se descarta y se cuenta.
  async function listarActivos() {
    let ultimo;
    for (let intento = 0; intento <= maxReintentos; intento += 1) {
      try {
        const res = await fetchFn(`${config.backendUrl}${RUTA}`, {
          method: "GET",
          headers: { "x-api-key": config.apiKey, Accept: "application/json" },
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

    if (!ultimo.ok) return { ok: false, status: ultimo.status ?? ultimo.error };
    const students = ultimo.datos?.students;
    if (!Array.isArray(students)) return { ok: false, status: "respuesta_invalida" };

    const alumnos = [];
    let descartados = 0;
    for (const s of students) {
      const valido =
        typeof s?.email === "string" && RE_CORREO.test(s.email) &&
        typeof s?.matricula === "string" && RE_MATRICULA.test(s.matricula) &&
        typeof s?.career === "string" && RE_CARRERA.test(s.career);
      if (valido) alumnos.push({ email: s.email, matricula: s.matricula, career: s.career });
      else descartados += 1;
    }
    return { ok: true, alumnos, descartados };
  }

  return { listarActivos };
}

module.exports = { crearClientePerfilesItson, RUTA };
