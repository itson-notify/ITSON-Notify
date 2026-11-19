// ITN-60 - Cliente del calendario académico público de ITSON (portal institucional).
// API sin documentación oficial: su uso desde un servidor está pendiente de confirmar
// con IT (igual que ITN-34 e ITN-64). Detalle y decisión en backend/ITN-60.md.
//
//   GET {BASE}/CalendarBySite?numPage=100&siteId=3
//       -> [{ calendarId, title, dateStr, ispublished, startTimeStr, url, tokenEncriptor }]
//          Lista de próximos eventos, sin año ni hora utilizables.
//   GET {BASE}/GetEvent/{tokenEncriptor}
//       -> { calendarID, title, startTime, endTime, eventDescription (HTML),
//            categorys: [string], campus: [string], location, ... }
//          startTime/endTime vienen como "AAAA-MM-DDTHH:mm:ss" en hora local de
//          Hermosillo (UTC-7 todo el año, sin horario de verano).
//
// Solo GET, sin cookies ni datos de alumnos. Timeout de 15 s por llamada y
// reintentos solo ante red, timeout o 5xx (un 4xx no se reintenta). Un detalle que
// falla no tumba la corrida: se cuenta y se sigue con los demás.

const BASE_URL = "https://www.itson.mx/ApiPortalInstitucional/itson/CalendarPublic";
const SITE_ID = 3;
const NUM_PAGE = 100;
const TIMEOUT_MS = 15_000;
// Reintentos después del primer intento (3 intentos en total).
const MAX_REINTENTOS = 2;
const BACKOFF_BASE_MS = 1_000;
const PAUSA_ENTRE_DETALLES_MS = 250;
const MAX_EVENTOS = 200;

const DESFASE_HERMOSILLO = "-07:00";
const RE_FECHA_LOCAL = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(?::(\d{2})(?:\.\d+)?)?$/;
const RE_TOKEN = /^[A-Za-z0-9_-]{8,64}$/;
const MAX_TITULO = 300;
const MAX_DESCRIPCION = 4000;
const MAX_CATEGORIA = 100;

const esperar = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const esReintentable = (status) => status === null || status >= 500;

const ENTIDADES = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " " };

// HTML del portal -> texto plano. Párrafos y saltos se vuelven saltos de línea.
function htmlATexto(html) {
  if (typeof html !== "string") return null;
  const texto = html
    .replace(/<\s*(script|style)[^>]*>[\s\S]*?<\s*\/\s*\1\s*>/gi, "")
    .replace(/<\s*br\s*\/?\s*>/gi, "\n")
    .replace(/<\s*\/\s*(p|div|li|h[1-6])\s*>/gi, "\n")
    .replace(/<[^>]*>/g, "")
    .replace(/&(#\d{1,6}|#x[0-9a-f]{1,6}|[a-z]+);/gi, (entidad, cuerpo) => {
      const c = cuerpo.toLowerCase();
      if (c.startsWith("#x")) return String.fromCodePoint(parseInt(c.slice(2), 16));
      if (c.startsWith("#")) return String.fromCodePoint(Number(c.slice(1)));
      return ENTIDADES[c] ?? entidad;
    })
    .replace(/ /g, " ")
    .replace(/[ \t]+/g, " ")
    .replace(/ *\n */g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
  if (texto === "") return null;
  return texto.length > MAX_DESCRIPCION ? `${texto.slice(0, MAX_DESCRIPCION - 1)}…` : texto;
}

// "AAAA-MM-DDTHH:mm[:ss]" en hora de Hermosillo -> { fecha, hora, minuto, segundo }
// o null si no es una fecha real.
function leerFechaLocal(valor) {
  if (typeof valor !== "string") return null;
  const m = RE_FECHA_LOCAL.exec(valor.trim());
  if (!m) return null;
  const [anio, mes, dia, hora, minuto] = m.slice(1, 6).map(Number);
  const segundo = m[6] === undefined ? 0 : Number(m[6]);
  const d = new Date(Date.UTC(anio, mes - 1, dia, hora, minuto, segundo));
  if (d.getUTCFullYear() !== anio || d.getUTCMonth() !== mes - 1 || d.getUTCDate() !== dia) return null;
  if (hora > 23 || minuto > 59 || segundo > 59) return null;
  return { fecha: `${m[1]}-${m[2]}-${m[3]}`, hora, minuto, segundo };
}

const dosDigitos = (n) => String(n).padStart(2, "0");
const isoHermosillo = (fecha, h, m, s) => `${fecha}T${dosDigitos(h)}:${dosDigitos(m)}:${dosDigitos(s)}${DESFASE_HERMOSILLO}`;

// Detalle del portal -> evento del contrato de POST /internal/calendar-events, o null
// si la forma no es la esperada.
//
// Todo el día: el portal no tiene un campo para eso. Las fechas del calendario
// académico (Registro Escolar) terminan a las 23:59, así que un evento cuyo fin cae a
// las 23:59 se toma como de días completos, del día de inicio al día de fin. Se guarda
// de 00:00:00 a 23:59:59 hora de Hermosillo para que nunca se corra de día.
function normalizarEvento(detalle) {
  if (!detalle || typeof detalle !== "object") return null;
  const id = detalle.calendarID;
  if (!Number.isSafeInteger(id) || id <= 0) return null;
  const titulo = typeof detalle.title === "string" ? detalle.title.replace(/\s+/g, " ").trim() : "";
  if (titulo === "") return null;

  const inicio = leerFechaLocal(detalle.startTime);
  const fin = leerFechaLocal(detalle.endTime ?? detalle.startTime);
  if (!inicio || !fin) return null;

  const allDay = fin.hora === 23 && fin.minuto === 59;
  const startsAt = allDay
    ? isoHermosillo(inicio.fecha, 0, 0, 0)
    : isoHermosillo(inicio.fecha, inicio.hora, inicio.minuto, inicio.segundo);
  const endsAt = allDay
    ? isoHermosillo(fin.fecha, 23, 59, 59)
    : isoHermosillo(fin.fecha, fin.hora, fin.minuto, fin.segundo);
  if (Date.parse(endsAt) < Date.parse(startsAt)) return null;

  const categorias = Array.isArray(detalle.categorys) ? detalle.categorys : [];
  const primera = categorias.find((c) => typeof c === "string" && c.trim() !== "");
  const category = primera ? primera.trim().slice(0, MAX_CATEGORIA) : null;

  return {
    externalId: String(id),
    title: titulo.length > MAX_TITULO ? `${titulo.slice(0, MAX_TITULO - 1)}…` : titulo,
    description: htmlATexto(detalle.eventDescription),
    startsAt,
    endsAt,
    allDay,
    category,
  };
}

function crearClienteCalendario({
  baseUrl = BASE_URL,
  siteId = SITE_ID,
  numPage = NUM_PAGE,
  fetchFn = globalThis.fetch,
  sleep = esperar,
  timeoutMs = TIMEOUT_MS,
  maxReintentos = MAX_REINTENTOS,
  backoffBaseMs = BACKOFF_BASE_MS,
  pausaMs = PAUSA_ENTRE_DETALLES_MS,
} = {}) {
  // GET con timeout y reintentos. { ok: true, datos } o { ok: false, motivo, status, intentos }.
  async function obtenerJson(url) {
    let ultimo;
    let intentos = 0;
    for (let intento = 0; intento <= maxReintentos; intento += 1) {
      intentos += 1;
      try {
        const res = await fetchFn(url, {
          method: "GET",
          headers: { Accept: "application/json" },
          redirect: "error",
          signal: AbortSignal.timeout(timeoutMs),
        });
        if (res.ok) {
          const datos = await res.json().catch(() => undefined);
          if (datos === undefined) return { ok: false, motivo: "forma_invalida", status: res.status, intentos };
          return { ok: true, datos };
        }
        ultimo = { ok: false, motivo: "http", status: res.status };
      } catch (error) {
        const nombre = error?.name === "TimeoutError" || error?.name === "AbortError" ? "timeout" : "red";
        ultimo = { ok: false, motivo: nombre, status: null };
      }
      if (!esReintentable(ultimo.status) || intento === maxReintentos) break;
      await sleep(backoffBaseMs * 2 ** intento);
    }
    return { ...ultimo, intentos };
  }

  // { ok: true, eventos, descartados, fallidos } o { ok: false, motivo, status }
  // si no se pudo leer la lista. `fallidos` son detalles que no se pudieron leer.
  async function obtenerEventos() {
    const lista = await obtenerJson(`${baseUrl}/CalendarBySite?numPage=${numPage}&siteId=${siteId}`);
    if (!lista.ok) return { ok: false, motivo: lista.motivo, status: lista.status };
    if (!Array.isArray(lista.datos)) return { ok: false, motivo: "forma_invalida", status: null };

    const eventos = [];
    const vistos = new Set();
    let descartados = 0;
    let fallidos = 0;
    let consultados = 0;

    for (const entrada of lista.datos.slice(0, MAX_EVENTOS)) {
      if (entrada?.ispublished === false) continue;
      const token = entrada?.tokenEncriptor;
      if (typeof token !== "string" || !RE_TOKEN.test(token) || !Number.isSafeInteger(entrada?.calendarId)) {
        descartados += 1;
        continue;
      }
      if (vistos.has(entrada.calendarId)) continue;
      vistos.add(entrada.calendarId);

      if (consultados > 0) await sleep(pausaMs);
      consultados += 1;
      const detalle = await obtenerJson(`${baseUrl}/GetEvent/${encodeURIComponent(token)}`);
      if (!detalle.ok) {
        fallidos += 1;
        continue;
      }
      const evento = normalizarEvento(detalle.datos);
      // El detalle debe ser del mismo evento de la lista.
      if (!evento || evento.externalId !== String(entrada.calendarId)) {
        descartados += 1;
        continue;
      }
      eventos.push(evento);
    }
    return { ok: true, eventos, descartados, fallidos };
  }

  return { obtenerEventos, obtenerJson };
}

module.exports = {
  crearClienteCalendario,
  normalizarEvento,
  htmlATexto,
  leerFechaLocal,
  BASE_URL,
  SITE_ID,
  NUM_PAGE,
  TIMEOUT_MS,
  MAX_REINTENTOS,
};
