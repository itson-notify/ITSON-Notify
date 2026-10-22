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
async function upsertSubjects(supabase, userId, courses) {
  const rows = courses.map((c) => ({
    user_id: userId,
    external_subject_id: c.externalId,
    name: c.subject,
    period: null, // la extracción de iVirtual no trae periodo
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

// Inserta el snapshot si no existe. ignoreDuplicates no sobrescribe
// captured_at de una corrida ya guardada; .select() devuelve la fila solo si
// esta llamada la insertó.
async function insertSnapshot(supabase, { id, userId, source, capturedAt }) {
  const rows = check(
    "grade_snapshots",
    await supabase
      .from("grade_snapshots")
      .upsert(
        { id, user_id: userId, source, captured_at: capturedAt, raw_payload: null },
        { onConflict: ON_CONFLICT.grade_snapshots, ignoreDuplicates: true },
      )
      .select("id"),
  );
  return rows.length === 1;
}

function gradeRows(snapshotId, courses, subjectIds) {
  return courses.flatMap((c) =>
    c.items.map((it) => ({
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

async function upsertSnapshotGrades(supabase, rows) {
  for (let i = 0; i < rows.length; i += CHUNK) {
    check(
      "snapshot_grades",
      await supabase
        .from("snapshot_grades")
        .upsert(rows.slice(i, i + CHUNK), { onConflict: ON_CONFLICT.snapshot_grades }),
    );
  }
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

  const subjectIds = await upsertSubjects(supabase, userId, payload.courses);

  const created = await insertSnapshot(supabase, {
    id: snapshotId,
    userId,
    source: payload.source,
    capturedAt: payload.captured_at,
  });
  if (!created && !existente) {
    // Otra petición insertó el mismo run_id entre la consulta y el upsert.
    const actual = await findSnapshot(supabase, snapshotId);
    if (!actual || actual.user_id !== userId) throw new SnapshotOwnershipError(snapshotId);
  }

  const rows = gradeRows(snapshotId, payload.courses, subjectIds);
  try {
    await upsertSnapshotGrades(supabase, rows);
  } catch (error) {
    // Solo se borra lo que esta llamada creó.
    error.compensation = created ? await deleteSnapshot(supabase, snapshotId) : "omitida";
    throw error;
  }

  return { snapshotId, userId, created, courses: payload.courses.length, items: rows.length };
}

module.exports = { saveSnapshot, ON_CONFLICT };
