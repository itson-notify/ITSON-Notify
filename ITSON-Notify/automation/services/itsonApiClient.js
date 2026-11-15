// ITN-55 - Cliente de la API REST de ITSON (no documentada). Endpoints usados:
//   getAlumnoInscrito  GET,  query emplid y carrera          ¿inscrito y fechas del semestre?
//   getProgress        POST, query id y career               semestres y materias aprobadas
//   getGrades          POST, query id, semester y career     calificación final por materia
// La URL base sale de ITSON_API_BASE_URL (variable del servicio worker-rpa).
//
// Cada llamada: timeout de 15 s, hasta 2 reintentos solo en red, timeout o 5xx (nunca
// en 4xx) y una pausa entre llamadas. Nunca lanza por fallas esperadas: devuelve
// { ok: true, ...datos } o { ok: false, motivo, status }. motivo es uno de
// red, timeout, http_4xx, http_5xx, no_json o forma_invalida.
//
// Privacidad: la matrícula y la carrera viajan en la query, así que ni la URL ni el
// mensaje de un error de fetch (que puede citarla) salen de aquí. Los resultados solo
// llevan el motivo y el status HTTP.

const TIMEOUT_MS = 15_000;
const MAX_REINTENTOS = 2;
const BACKOFF_BASE_MS = 1_000;
const PAUSA_ENTRE_LLAMADAS_MS = 1_000;

const esperar = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// Valida ITSON_API_BASE_URL. Devuelve { ok: true, baseUrl } o { ok: false, error }; el
// error nunca cita el valor.
function leerBaseUrl(env = process.env) {
  const valor = env.ITSON_API_BASE_URL?.trim();
  if (!valor) return { ok: false, error: "Falta ITSON_API_BASE_URL." };
  let url;
  try {
    url = new URL(valor);
  } catch {
    return { ok: false, error: "ITSON_API_BASE_URL no es una URL válida." };
  }
  if (url.protocol !== "https:") return { ok: false, error: "ITSON_API_BASE_URL debe empezar con https://." };
  if (url.search || url.hash) return { ok: false, error: "ITSON_API_BASE_URL no debe llevar query ni fragmento." };
  return { ok: true, baseUrl: valor.replace(/\/+$/, "") };
}

// --- Lectura tolerante de las respuestas -------------------------------------

const esObjeto = (v) => v !== null && typeof v === "object" && !Array.isArray(v);

// La carga útil se vio en responseValue (getGrades) y en response (getProgress).
function cargaDe(cuerpo) {
  if (!esObjeto(cuerpo)) return null;
  if (cuerpo.responseValue !== undefined) return cuerpo.responseValue;
  if (cuerpo.response !== undefined) return cuerpo.response;
  return cuerpo;
}

function booleano(v) {
  if (typeof v === "boolean") return v;
  if (v === 1 || v === 0) return v === 1;
  if (typeof v === "string") {
    const t = v.trim().toLowerCase();
    if (["true", "s", "si", "sí", "1"].includes(t)) return true;
    if (["false", "n", "no", "0"].includes(t)) return false;
  }
  return null;
}

const ZONA = "America/Hermosillo";
const diaEnHermosillo = (fecha) =>
  new Intl.DateTimeFormat("en-CA", { timeZone: ZONA, year: "numeric", month: "2-digit", day: "2-digit" }).format(fecha);

// Fecha del semestre como "AAAA-MM-DD" en hora de Hermosillo. getAlumnoInscrito la
// manda en ISO sin zona (aaaa-mm-ddThh:mm:ss), que ya es hora de Hermosillo: se toma
// el día tal cual. Si trae zona (Z o ±hh:mm) se convierte a Hermosillo. También
// acepta dd/mm/aaaa. Cualquier otra cosa es null.
function fechaDia(v) {
  if (typeof v !== "string") return null;
  const t = v.trim();
  if (/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d+)?)?(Z|[+-]\d{2}:?\d{2})$/.test(t)) {
    const fecha = new Date(t);
    return Number.isNaN(fecha.getTime()) ? null : diaEnHermosillo(fecha);
  }
  let m = /^(\d{4})-(\d{2})-(\d{2})(T\d{2}:\d{2}(:\d{2}(\.\d+)?)?)?$/.exec(t);
  if (m) return `${m[1]}-${m[2]}-${m[3]}`;
  m = /^(\d{1,2})\/(\d{1,2})\/(\d{4})/.exec(t);
  if (m) return `${m[3]}-${m[2].padStart(2, "0")}-${m[1].padStart(2, "0")}`;
  return null;
}

const entero = (v) => {
  const n = typeof v === "string" ? Number(v.trim()) : v;
  return Number.isInteger(n) && n >= 0 ? n : null;
};

const vacia = (v) =>
  v === null || (Array.isArray(v) && v.length === 0) || (esObjeto(v) && Object.keys(v).length === 0);

// { inscrito, inicio, fin } o null (forma_invalida). inscrito, inicio o fin quedan en
// null si no se pueden leer: la fase decide con la ventana de fechas y, sin fechas
// legibles, consulta de todos modos (fechas_ilegibles, sin alerta).
// Formas aceptadas:
//   - El objeto, solo o dentro de responseValue o response.
//   - Un arreglo de exactamente un objeto, solo o dentro de responseValue o response
//     (la forma real: [ { inscrito, fechaInicioSemestre, fechaFinSemestre } ]). Con 0
//     o más de un elemento, o un elemento que no es objeto, es forma_invalida: no se
//     elige uno.
//   - responseValue o response vacío (null, [] u {}): resultado válido sin datos.
//   - responseValue o response booleano: es inscrito, sin fechas.
function leerInscripcion(cuerpo) {
  const envuelto = esObjeto(cuerpo) && (cuerpo.responseValue !== undefined || cuerpo.response !== undefined);
  let c = Array.isArray(cuerpo) ? cuerpo : cargaDe(cuerpo);
  if (envuelto && vacia(c)) return { inscrito: null, inicio: null, fin: null };
  if (envuelto && typeof c === "boolean") return { inscrito: c, inicio: null, fin: null };
  if (Array.isArray(c)) {
    if (c.length !== 1 || !esObjeto(c[0])) return null;
    c = c[0];
  }
  if (!esObjeto(c)) return null;
  return {
    inscrito: booleano(c.inscrito),
    inicio: fechaDia(c.fechaInicioSemestre),
    fin: fechaDia(c.fechaFinSemestre),
  };
}

// [{ semesterKey, approvedSubjects, totalSubjects }] o null.
function leerProgreso(cuerpo) {
  const c = cargaDe(cuerpo);
  const lista = Array.isArray(c) ? c : c?.progress;
  if (!Array.isArray(lista)) return null;
  const semestres = [];
  for (const s of lista) {
    if (!esObjeto(s) || typeof s.semesterKey !== "string") return null;
    const aprobadas = entero(s.approvedSubjects);
    const total = entero(s.totalSubjects);
    if (aprobadas === null || total === null) return null;
    semestres.push({ semesterKey: s.semesterKey.trim(), approvedSubjects: aprobadas, totalSubjects: total });
  }
  return semestres;
}

// [{ idCatalog, name, program, gradeValue, studying }] o null.
function leerCalificaciones(cuerpo) {
  const c = cargaDe(cuerpo);
  if (!Array.isArray(c)) return null;
  const materias = [];
  for (const m of c) {
    if (!esObjeto(m) || !esObjeto(m.subject)) return null;
    const { idCatalog, name, program } = m.subject;
    const id = typeof idCatalog === "number" ? String(idCatalog) : idCatalog;
    if (typeof id !== "string" || id.trim() === "" || typeof name !== "string" || name.trim() === "") return null;
    if (typeof program !== "string") return null;
    if (m.gradeValue !== null && m.gradeValue !== undefined && typeof m.gradeValue !== "string") return null;
    materias.push({
      idCatalog: id.trim(),
      name: name.trim(),
      program: program.trim(),
      gradeValue: m.gradeValue ?? null,
      studying: m.studying === true,
    });
  }
  return materias;
}

// --- Cliente -----------------------------------------------------------------

function crearClienteItsonApi({
  baseUrl,
  fetchFn = globalThis.fetch,
  sleep = esperar,
  timeoutMs = TIMEOUT_MS,
  maxReintentos = MAX_REINTENTOS,
  backoffBaseMs = BACKOFF_BASE_MS,
  pausaMs = PAUSA_ENTRE_LLAMADAS_MS,
}) {
  let llamadas = 0;

  // Un intento. { ok, status, cuerpo } o { ok: false, status: null, motivo }.
  async function intentar(metodo, url) {
    let res;
    try {
      res = await fetchFn(url, {
        method: metodo,
        headers: { Accept: "application/json" },
        signal: AbortSignal.timeout(timeoutMs),
      });
    } catch (error) {
      // Solo el tipo: el mensaje de un error de fetch puede traer la URL.
      const timeout = error?.name === "TimeoutError" || error?.name === "AbortError";
      return { ok: false, status: null, motivo: timeout ? "timeout" : "red" };
    }
    if (!res.ok) {
      await res.text().catch(() => null);
      return { ok: false, status: res.status, motivo: res.status >= 500 ? "http_5xx" : "http_4xx" };
    }
    try {
      return { ok: true, status: res.status, cuerpo: await res.json() };
    } catch {
      return { ok: false, status: res.status, motivo: "no_json" };
    }
  }

  // Petición con reintentos y la pausa entre llamadas.
  async function pedir(metodo, ruta, params) {
    if (llamadas > 0) await sleep(pausaMs);
    llamadas += 1;
    const url = new URL(`${baseUrl}/${ruta}`);
    for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);

    let ultimo;
    for (let intento = 0; intento <= maxReintentos; intento += 1) {
      ultimo = await intentar(metodo, url);
      const reintentable = ultimo.status === null || ultimo.status >= 500;
      if (ultimo.ok || !reintentable || intento === maxReintentos) break;
      await sleep(backoffBaseMs * 2 ** intento);
    }
    return ultimo;
  }

  const fallo = (r) => ({ ok: false, motivo: r.motivo, status: r.status });
  const formaInvalida = (r) => ({ ok: false, motivo: "forma_invalida", status: r.status });

  // { ok: true, inscrito, inicio, fin } o { ok: false, motivo, status }.
  async function getAlumnoInscrito({ matricula, career }) {
    const r = await pedir("GET", "api/getAlumnoInscrito", { emplid: matricula, carrera: career });
    if (!r.ok) return fallo(r);
    const datos = leerInscripcion(r.cuerpo);
    return datos ? { ok: true, ...datos } : formaInvalida(r);
  }

  // { ok: true, semestres } o { ok: false, motivo, status }.
  async function getProgress({ matricula, career }) {
    const r = await pedir("POST", "api/getProgress", { id: matricula, career });
    if (!r.ok) return fallo(r);
    const semestres = leerProgreso(r.cuerpo);
    return semestres ? { ok: true, semestres } : formaInvalida(r);
  }

  // { ok: true, materias } o { ok: false, motivo, status }.
  async function getGrades({ matricula, career, semester }) {
    const r = await pedir("POST", "api/getGrades", { id: matricula, semester, career });
    if (!r.ok) return fallo(r);
    const materias = leerCalificaciones(r.cuerpo);
    return materias ? { ok: true, materias } : formaInvalida(r);
  }

  return { getAlumnoInscrito, getProgress, getGrades };
}

module.exports = {
  crearClienteItsonApi,
  leerBaseUrl,
  leerInscripcion,
  leerProgreso,
  leerCalificaciones,
  fechaDia,
  TIMEOUT_MS,
  MAX_REINTENTOS,
  PAUSA_ENTRE_LLAMADAS_MS,
};
