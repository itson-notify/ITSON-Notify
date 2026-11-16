// ITN-27 - Guarda un resultado del worker en Supabase.
//
// Orden: app_users -> subjects -> grade_snapshots -> snapshot_grades. Cada paso
// es un upsert con la llave de conflicto de las migraciones, así que reenviar
// el mismo payload (mismo run_id) no duplica filas.
//
// supabase-js no tiene transacciones. Si falla snapshot_grades y ESTA llamada
// creó el snapshot, se borra (el cascade se lleva sus calificaciones) para no
// dejar un snapshot incompleto que el detector tomaría como "anterior". Si el
// snapshot ya existía (reenvío), no se toca: borrarlo destruiría una corrida
// que ya estaba completa. Limitación conocida en backend/README.md.
const { check, SnapshotOwnershipError } = require("../utils/errors");
const { FECHAS_TAREA } = require("../models/gradeSnapshotPayload");

// ITN-56 - Código de Postgres para una columna inexistente (013 sin aplicar).
const UNDEFINED_COLUMN = "42703";
const COLUMNAS_FECHA = FECHAS_TAREA.map((f) => f.column);
// PostgREST corta las respuestas en max-rows (1000 por defecto en Supabase).
const PAGE = 1000;

// Llaves de conflicto, exactamente las de las migraciones.
const ON_CONFLICT = {
  app_users: "email", // 001
  subjects: "user_id,external_subject_id,name,period", // 002, nulls not distinct
  grade_snapshots: "id", // run_id del worker
  snapshot_grades: "snapshot_id,subject_id,external_item_id", // 003, nulls not distinct
};

// Filas por petición a snapshot_grades.
const CHUNK = 500;

async function upsertUser(supabase, email) {
  const row = check(
    "app_users",
    await supabase.from("app_users").upsert({ email }, { onConflict: ON_CONFLICT.app_users }).select("id").single(),
  );
  return row.id;
}

async function findSnapshot(supabase, snapshotId) {
  return check(
    "grade_snapshots",
    await supabase.from("grade_snapshots").select("id,user_id").eq("id", snapshotId).maybeSingle(),
  );
}

// Devuelve Map(externalId del curso -> subjects.id).
// period: semestre consultado en itson_api (ITN-55); null en iVirtual, que no
// trae periodo.
async function upsertSubjects(supabase, userId, courses, period = null) {
  const rows = courses.map((c) => ({
    user_id: userId,
    external_subject_id: c.externalId,
    name: c.subject,
    period,
  }));
  const saved = check(
    "subjects",
    await supabase
      .from("subjects")
      .upsert(rows, { onConflict: ON_CONFLICT.subjects })
      .select("id,external_subject_id"),
  );
  const ids = new Map(saved.map((s) => [s.external_subject_id, s.id]));
  if (courses.some((c) => !ids.has(c.externalId))) {
    throw new Error("subjects no devolvió el id de todas las materias");
  }
  return ids;
}

// Solo itson_api escribe grade_snapshots.period (migración 012). iVirtual no manda la
// columna, así sigue funcionando en una base sin la 012.
const ITSON_API = "itson_api";

// Inserta el snapshot si no existe. ignoreDuplicates no sobrescribe
// captured_at de una corrida ya guardada; .select() devuelve la fila solo si
// esta llamada la insertó.
async function insertSnapshot(supabase, { id, userId, source, period = null, capturedAt }) {
  const rows = check(
    "grade_snapshots",
    await supabase
      .from("grade_snapshots")
      .upsert(
        {
          id,
          user_id: userId,
          source,
          ...(source === ITSON_API ? { period } : {}),
          captured_at: capturedAt,
          raw_payload: null,
        },
        { onConflict: ON_CONFLICT.grade_snapshots, ignoreDuplicates: true },
      )
      .select("id"),
  );
  return rows.length === 1;
}

// ITN-56 - Fechas de la tarea en las columnas de la 013. Una fecha que vino en
// el ítem (ISO o null) se guarda tal cual; una omitida es "desconocida" y se copia
// del snapshot anterior del mismo ítem (`previas`), o null si no había.
// Con `previas` = null (itson_api o 013 sin aplicar) no se escriben las columnas.
function fechaColumns(it, subjectId, previas) {
  if (!previas) return {};
  const previa = previas.get(`${subjectId}\u0000${it.externalItemId}`);
  return Object.fromEntries(
    FECHAS_TAREA.map(({ key, column }) => [column, it[key] !== undefined ? it[key] : previa?.[column] ?? null]),
  );
}

function gradeRows(snapshotId, courses, subjectIds, previas = null) {
  return courses.flatMap((c) =>
    c.items.map((it) => ({
      ...fechaColumns(it, subjectIds.get(c.externalId), previas),
      snapshot_id: snapshotId,
      subject_id: subjectIds.get(c.externalId),
      external_item_id: it.externalItemId,
      grade_label: it.label ?? null,
      grade_value: it.value ?? null,
      grade_text: it.text ?? null,
      partial_period: null,
      // Campos de la extracción que no tienen columna propia.
      raw_payload: {
        type: it.type ?? null,
        min: it.min ?? null,
        max: it.max ?? null,
        percentage: it.percentage ?? null,
        categoryId: it.categoryId ?? null,
        cmid: it.cmid ?? null,
        hidden: it.hidden ?? null,
      },
    })),
  );
}

// ITN-56 - Fechas del snapshot anterior de iVirtual del mismo alumno, para copiar
// las que lleguen omitidas. El anterior es el de captured_at más reciente menor al
// actual (como en el detector, sin el desempate por id). Devuelve
//   { previas: Map(subjectId\0externalItemId -> { due_at, opens_at, closes_at }) }
//   { previas: null } si la 013 no está aplicada (42703).
async function leerFechasPrevias(supabase, { userId, snapshotId, capturedAt }) {
  const anterior = check(
    "grade_snapshots",
    await supabase
      .from("grade_snapshots")
      .select("id")
      .eq("user_id", userId)
      .eq("source", "ivirtual")
      .neq("id", snapshotId)
      .lt("captured_at", capturedAt)
      .order("captured_at", { ascending: false })
      .limit(1),
  )[0];

  const previas = new Map();
  // Sin snapshot anterior igual se prueba la columna, para saber si existe.
  const ids = anterior ? [anterior.id] : [snapshotId];
  for (let from = 0; ; from += PAGE) {
    const res = await supabase
      .from("snapshot_grades")
      .select(`id,subject_id,external_item_id,${COLUMNAS_FECHA.join(",")}`)
      .in("snapshot_id", ids)
      .order("id", { ascending: true })
      .range(from, from + PAGE - 1);
    if (res.error?.code === UNDEFINED_COLUMN) return { previas: null };
    const rows = check("snapshot_grades", res);
    if (anterior) {
      for (const r of rows) previas.set(`${r.subject_id}\u0000${r.external_item_id}`, r);
    }
    if (rows.length < PAGE) return { previas };
  }
}

const sinFechas = (row) => Object.fromEntries(Object.entries(row).filter(([k]) => !COLUMNAS_FECHA.includes(k)));

// Devuelve true si escribió las fechas, false si la 013 no está aplicada (42703)
// y se reintentó sin las columnas de fecha.
async function upsertSnapshotGrades(supabase, rows) {
  let conFechas = rows.some((r) => COLUMNAS_FECHA.some((c) => c in r));
  for (let i = 0; i < rows.length; i += CHUNK) {
    const chunk = rows.slice(i, i + CHUNK);
    const enviar = (filas) =>
      supabase.from("snapshot_grades").upsert(filas, { onConflict: ON_CONFLICT.snapshot_grades });
    let res = await enviar(conFechas ? chunk : chunk.map(sinFechas));
    if (conFechas && res.error?.code === UNDEFINED_COLUMN) {
      conFechas = false;
      res = await enviar(chunk.map(sinFechas));
    }
    check("snapshot_grades", res);
  }
  return conFechas;
}

// Borrado compensatorio. Si también falla, se reporta en el error original
// (error.compensation) para que el log lo muestre; no se lanza otro error.
async function deleteSnapshot(supabase, snapshotId) {
  try {
    const { error } = await supabase.from("grade_snapshots").delete().eq("id", snapshotId);
    return error ? "fallida" : "borrado";
  } catch {
    return "fallida";
  }
}

// payload: el body ya validado (gradeSnapshotPayload.js).
// Devuelve { snapshotId, userId, created, courses, items }.
async function saveSnapshot(supabase, payload) {
  const snapshotId = payload.run_id;
  const userId = await upsertUser(supabase, payload.user.email);

  // Antes del primer upsert de snapshot: ¿ya existía este run_id y de quién es?
  const existente = await findSnapshot(supabase, snapshotId);
  if (existente && existente.user_id !== userId) {
    throw new SnapshotOwnershipError(snapshotId);
  }

  const period = payload.period ?? null;
  const subjectIds = await upsertSubjects(supabase, userId, payload.courses, period);

  const created = await insertSnapshot(supabase, {
    id: snapshotId,
    userId,
    source: payload.source,
    period,
    capturedAt: payload.captured_at,
  });
  if (!created && !existente) {
    // Otra petición insertó el mismo run_id entre la consulta y el upsert.
    const actual = await findSnapshot(supabase, snapshotId);
    if (!actual || actual.user_id !== userId) throw new SnapshotOwnershipError(snapshotId);
  }

  // ITN-56 - Fechas de las tareas, solo iVirtual. fechas: "ok", "sin_migracion"
  // (la 013 no está aplicada: el snapshot se guarda sin fechas) o "no_aplica".
  let fechas = "no_aplica";
  let rows;
  try {
    let previas = null;
    if (payload.source !== ITSON_API) {
      ({ previas } = await leerFechasPrevias(supabase, {
        userId,
        snapshotId,
        capturedAt: payload.captured_at,
      }));
      fechas = previas ? "ok" : "sin_migracion";
    }
    rows = gradeRows(snapshotId, payload.courses, subjectIds, previas);
    const escritas = await upsertSnapshotGrades(supabase, rows);
    if (fechas === "ok" && !escritas) fechas = "sin_migracion";
  } catch (error) {
    // Solo se borra lo que esta llamada creó.
    error.compensation = created ? await deleteSnapshot(supabase, snapshotId) : "omitida";
    throw error;
  }

  return { snapshotId, userId, created, courses: payload.courses.length, items: rows.length, fechas };
}

module.exports = { saveSnapshot, upsertUser, gradeRows, ON_CONFLICT };
