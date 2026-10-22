// ITN-27 - Repo real de gradeChangeService.detectChanges (ITN-24) sobre
// Supabase. Contrato en backend/src/services/README.md.
const { check } = require("../utils/errors");

// Llave natural de grade_changes: constraint grade_changes_natural_key
// (migración 004, unique nulls not distinct).
const GRADE_CHANGES_ON_CONFLICT =
  "previous_snapshot_id,current_snapshot_id,subject_id,external_item_id,field_name";

// PostgREST corta las respuestas en max-rows (1000 por defecto en Supabase).
const PAGE = 1000;

const toItem = (row) => ({
  subjectId: row.subject_id,
  externalItemId: row.external_item_id,
  label: row.grade_label,
  value: row.grade_value,
  text: row.grade_text,
});

function createGradeChangeRepository(supabase) {
  async function getSnapshotItems(snapshotId) {
    const items = [];
    for (let from = 0; ; from += PAGE) {
      const rows = check(
        "snapshot_grades",
        await supabase
          .from("snapshot_grades")
          .select("id,subject_id,external_item_id,grade_label,grade_value,grade_text")
          .eq("snapshot_id", snapshotId)
          .order("id", { ascending: true })
          .range(from, from + PAGE - 1),
      );
      items.push(...rows.map(toItem));
      if (rows.length < PAGE) return items;
    }
  }

  // Snapshot inmediatamente anterior del mismo user_id y la misma source:
  // el de captured_at más reciente menor al actual; con el mismo captured_at,
  // el de id menor. Nunca el mismo snapshot. null si no hay.
  async function getPreviousSnapshotItems(userId, currentSnapshotId) {
    const current = check(
      "grade_snapshots",
      await supabase
        .from("grade_snapshots")
        .select("id,user_id,source,captured_at")
        .eq("id", currentSnapshotId)
        .maybeSingle(),
    );
    if (!current || current.user_id !== userId) {
      throw new Error("El snapshot actual no existe o no pertenece al usuario");
    }

    const base = () =>
      supabase
        .from("grade_snapshots")
        .select("id")
        .eq("user_id", userId)
        .eq("source", current.source)
        .neq("id", currentSnapshotId);

    // Empate de captured_at: cualquiera con id menor es posterior a todos los
    // de captured_at menor, así que se busca primero aquí.
    let previous = check(
      "grade_snapshots",
      await base()
        .eq("captured_at", current.captured_at)
        .lt("id", currentSnapshotId)
        .order("id", { ascending: false })
        .limit(1),
    )[0];

    if (!previous) {
      previous = check(
        "grade_snapshots",
        await base()
          .lt("captured_at", current.captured_at)
          .order("captured_at", { ascending: false })
          .order("id", { ascending: false })
          .limit(1),
      )[0];
    }

    if (!previous) return null;
    return { snapshotId: previous.id, items: await getSnapshotItems(previous.id) };
  }

  // Inserta ignorando duplicados de la llave natural. Con ignoreDuplicates,
  // .select() devuelve solo las filas que realmente se insertaron.
  async function insertGradeChanges(rows) {
    if (rows.length === 0) return [];
    return check(
      "grade_changes",
      await supabase
        .from("grade_changes")
        .upsert(rows, { onConflict: GRADE_CHANGES_ON_CONFLICT, ignoreDuplicates: true })
        .select(),
    );
  }

  return { getPreviousSnapshotItems, getSnapshotItems, insertGradeChanges };
}

module.exports = { createGradeChangeRepository, GRADE_CHANGES_ON_CONFLICT };
