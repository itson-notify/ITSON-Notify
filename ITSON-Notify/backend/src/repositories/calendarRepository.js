// ITN-60 - Lecturas y escrituras de calendar_events (migración 015). El calendario es
// público y no tiene datos de alumnos.
const { check } = require("../utils/errors");
const { diaEnHermosillo } = require("../models/calendarEvent");

const IDS_PER_QUERY = 100;
const MAX_FILAS = 1000;
const COLS = "id,external_id,title,description,starts_at,ends_at,all_day,category,updated_at";

// Códigos cuando la migración 015 aún no está aplicada (Postgres y PostgREST).
const TABLA_FALTANTE = new Set(["42P01", "PGRST205"]);
const esTablaFaltante = (error) => TABLA_FALTANTE.has(error?.code);

const mismoInstante = (a, b) => Date.parse(a) === Date.parse(b);
const nulo = (v) => (v === undefined ? null : v);

function cambio(actual, nueva) {
  return (
    actual.title !== nueva.title ||
    nulo(actual.description) !== nueva.description ||
    !mismoInstante(actual.starts_at, nueva.starts_at) ||
    !mismoInstante(actual.ends_at, nueva.ends_at) ||
    actual.all_day !== nueva.all_day ||
    nulo(actual.category) !== nueva.category
  );
}

const toIso = (v) => (v ? new Date(Date.parse(v)).toISOString() : null);

// Fila -> evento de GET /api/calendar. startsAt/endsAt/updatedAt en ISO UTC, igual que
// dueAt en /api/courses/:id/items; startDate/endDate son los días en Hermosillo para
// pintar eventos de todo el día sin correrlos.
function toApiEvent(row) {
  return {
    id: row.id,
    title: row.title,
    description: nulo(row.description),
    startsAt: toIso(row.starts_at),
    endsAt: toIso(row.ends_at),
    startDate: diaEnHermosillo(row.starts_at),
    endDate: diaEnHermosillo(row.ends_at),
    allDay: row.all_day === true,
    category: nulo(row.category),
    updatedAt: toIso(row.updated_at),
  };
}

function createCalendarRepository(supabase) {
  // Guarda el lote en UN solo upsert por external_id (todo o nada). Solo reescribe
  // las filas nuevas o que cambiaron, así updated_at dice cuándo cambió el evento.
  // Devuelve { inserted, updated, unchanged }.
  async function upsertEvents(filas, nowIso) {
    const ids = filas.map((f) => f.external_id);
    const actuales = new Map();
    for (let i = 0; i < ids.length; i += IDS_PER_QUERY) {
      const trozo = ids.slice(i, i + IDS_PER_QUERY);
      const data = check(
        "calendar_events",
        await supabase.from("calendar_events").select(COLS).in("external_id", trozo),
      );
      for (const row of data ?? []) actuales.set(row.external_id, row);
    }

    let inserted = 0;
    let updated = 0;
    const porEscribir = [];
    for (const fila of filas) {
      const actual = actuales.get(fila.external_id);
      if (!actual) inserted += 1;
      else if (cambio(actual, fila)) updated += 1;
      else continue;
      porEscribir.push({ ...fila, updated_at: nowIso });
    }

    if (porEscribir.length > 0) {
      check(
        "calendar_events",
        await supabase.from("calendar_events").upsert(porEscribir, { onConflict: "external_id" }),
      );
    }
    return { inserted, updated, unchanged: filas.length - inserted - updated };
  }

  // Eventos que intersectan [desde, hasta] (instantes ISO), ordenados por inicio.
  async function listBetween(desde, hasta) {
    const { data, error } = await supabase
      .from("calendar_events")
      .select(COLS)
      .lte("starts_at", hasta)
      .gte("ends_at", desde)
      .order("starts_at", { ascending: true })
      .order("external_id", { ascending: true })
      .limit(MAX_FILAS);
    check("calendar_events", { data, error });
    return (data ?? []).map(toApiEvent);
  }

  return { upsertEvents, listBetween };
}

module.exports = { createCalendarRepository, toApiEvent, esTablaFaltante };
