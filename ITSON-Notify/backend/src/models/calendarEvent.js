// ITN-60 - Validación del calendario académico:
//   - body de POST /internal/calendar-events (lo manda el worker);
//   - query de GET /api/calendar?from=&to= (lo manda el frontend).
// Contrato en backend/ITN-60.md.
//
// Hora de Hermosillo: Sonora está en UTC-7 todo el año (sin horario de verano), así
// que se usa un desfase fijo, igual que utils/fechaHermosillo.js.
const { z } = require("zod");

const DESFASE_MS = 7 * 60 * 60 * 1000;
const MAX_EVENTOS = 500;
// Rango máximo de GET /api/calendar: un año más un día (cubre años bisiestos).
const MAX_RANGO_DIAS = 366;
const RE_DIA = /^(\d{4})-(\d{2})-(\d{2})$/;

// Instante (ms o ISO) -> "AAAA-MM-DD" del día en Hermosillo.
function diaEnHermosillo(valor) {
  const ms = typeof valor === "number" ? valor : Date.parse(valor);
  if (Number.isNaN(ms)) return null;
  return new Date(ms - DESFASE_MS).toISOString().slice(0, 10);
}

// "AAAA-MM-DD" -> { inicio, fin } (ms) del día completo en Hermosillo, o null si la
// fecha no existe (por ejemplo 2026-02-30).
function limitesDelDia(dia) {
  const m = typeof dia === "string" ? RE_DIA.exec(dia) : null;
  if (!m) return null;
  const [anio, mes, d] = m.slice(1).map(Number);
  const utc = Date.UTC(anio, mes - 1, d);
  const f = new Date(utc);
  if (f.getUTCFullYear() !== anio || f.getUTCMonth() !== mes - 1 || f.getUTCDate() !== d) return null;
  const inicio = utc + DESFASE_MS;
  return { inicio, fin: inicio + 24 * 60 * 60 * 1000 - 1 };
}

// ---------------------------------------------------------------------------
// POST /internal/calendar-events

const evento = z.object({
  externalId: z.string().regex(/^[0-9]{1,12}$/),
  title: z.string().trim().min(1).max(300),
  description: z.string().max(4000).nullish().transform((v) => (v === undefined || v === "" ? null : v)),
  startsAt: z.iso.datetime({ offset: true }),
  endsAt: z.iso.datetime({ offset: true }),
  allDay: z.boolean(),
  category: z.string().trim().min(1).max(100).nullish().transform((v) => v ?? null),
}).strict();

const payload = z.object({
  events: z.array(evento).min(1).max(MAX_EVENTOS),
}).strict();

// Fila de calendar_events lista para guardar. Los eventos de todo el día se fijan de
// 00:00:00 a 23:59:59 (hora de Hermosillo) de su día de inicio y de fin, aunque el
// worker mande otra hora: así nunca se corren de día.
function aFila(e) {
  let inicio = Date.parse(e.startsAt);
  let fin = Date.parse(e.endsAt);
  if (e.allDay) {
    inicio = limitesDelDia(diaEnHermosillo(inicio)).inicio;
    fin = limitesDelDia(diaEnHermosillo(fin)).fin - 999;
  }
  return {
    external_id: e.externalId,
    title: e.title,
    description: e.description,
    starts_at: new Date(inicio).toISOString(),
    ends_at: new Date(fin).toISOString(),
    all_day: e.allDay,
    category: e.category,
  };
}

// { success: true, data: filas[] } o { success: false, issues } (solo ruta y código,
// sin valores).
function parseCalendarEventsPayload(body) {
  const parsed = payload.safeParse(body);
  if (!parsed.success) {
    return {
      success: false,
      issues: parsed.error.issues.map((i) => ({ path: i.path.join("."), code: i.code })),
    };
  }
  const issues = [];
  const vistos = new Set();
  parsed.data.events.forEach((e, i) => {
    if (vistos.has(e.externalId)) issues.push({ path: `events.${i}.externalId`, code: "duplicado" });
    vistos.add(e.externalId);
    if (Date.parse(e.endsAt) < Date.parse(e.startsAt)) issues.push({ path: `events.${i}.endsAt`, code: "antes_del_inicio" });
  });
  if (issues.length > 0) return { success: false, issues };
  return { success: true, data: parsed.data.events.map(aFila) };
}

// ---------------------------------------------------------------------------
// GET /api/calendar?from=AAAA-MM-DD&to=AAAA-MM-DD

const MENSAJES = {
  fechas_requeridas: "Faltan los parámetros from y to (AAAA-MM-DD).",
  fecha_invalida: "from y to deben ser fechas reales con formato AAAA-MM-DD.",
  rango_invertido: "from debe ser menor o igual que to.",
  rango_demasiado_amplio: `El rango no puede pasar de ${MAX_RANGO_DIAS} días.`,
};

const error = (codigo) => ({ success: false, error: codigo, message: MENSAJES[codigo] });

// Ambos días inclusive, en hora de Hermosillo. { success: true, desde, hasta } con
// los instantes ISO del inicio de `from` y del final de `to`, o { success: false,
// error, message }.
function parseCalendarRange(query) {
  const { from, to } = query ?? {};
  if (from === undefined || to === undefined || from === "" || to === "") return error("fechas_requeridas");
  if (typeof from !== "string" || typeof to !== "string") return error("fecha_invalida");
  const desde = limitesDelDia(from);
  const hasta = limitesDelDia(to);
  if (!desde || !hasta) return error("fecha_invalida");
  if (desde.inicio > hasta.inicio) return error("rango_invertido");
  const dias = Math.round((hasta.inicio - desde.inicio) / (24 * 60 * 60 * 1000)) + 1;
  if (dias > MAX_RANGO_DIAS) return error("rango_demasiado_amplio");
  return {
    success: true,
    desde: new Date(desde.inicio).toISOString(),
    hasta: new Date(hasta.fin).toISOString(),
  };
}

module.exports = {
  parseCalendarEventsPayload,
  parseCalendarRange,
  diaEnHermosillo,
  limitesDelDia,
  MAX_EVENTOS,
  MAX_RANGO_DIAS,
};
