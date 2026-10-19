// ITN-24 - Detección de cambios de calificaciones entre el snapshot actual y el
// anterior del mismo alumno. La persistencia va detrás de un repo inyectado
// (contrato en README.md) para conectarlo al backend de ITN-27 sin tocar esto.
const { diffSnapshots } = require("./gradeDiff");

// Prefijo de los ids sintéticos que la migración 003 asigna a filas viejas sin
// id de Moodle. Un snapshot con esos ítems no sirve como base de comparación:
// cada ítem real se vería como borrado + creado (ver 003_README.md).
const LEGACY_PREFIX = "legacy:";

const REPO_METHODS = [
  "getPreviousSnapshotItems",
  "getSnapshotItems",
  "insertGradeChanges",
];

function assertRepo(repo) {
  const faltan = REPO_METHODS.filter((m) => typeof repo?.[m] !== "function");
  if (faltan.length > 0) {
    throw new Error(`Repo incompleto, faltan: ${faltan.join(", ")}`);
  }
}

function toRow(change, { userId, previousSnapshotId, currentSnapshotId }) {
  return {
    user_id: userId,
    subject_id: change.subjectId,
    previous_snapshot_id: previousSnapshotId,
    current_snapshot_id: currentSnapshotId,
    external_item_id: change.externalItemId, // columna de la migración 003
    field_name: change.fieldName,
    previous_value: change.previousValue,
    current_value: change.currentValue,
    change_type: change.changeType,
  };
}

// Compara el snapshot currentSnapshotId contra el anterior del alumno y
// guarda los cambios en grade_changes.
//
// Devuelve:
//   { baseline: true,  reason, changes: [], inserted: [] }   sin comparación
//   { baseline: false, reason: null, changes, inserted }      con comparación
// `changes` son todos los cambios calculados; `inserted` son solo las filas
// que se insertaron en esta llamada. El servicio de notificación debe usar
// `inserted`: así una segunda corrida sobre el mismo par no notifica dos veces.
//
// Idempotencia: el diff es determinista y insertGradeChanges debe ignorar
// filas que ya existan con la misma llave (ver README.md), así que correr esto
// dos veces sobre el mismo par de snapshots no duplica cambios.
async function detectChanges({ userId, currentSnapshotId }, repo) {
  assertRepo(repo);
  if (!userId || !currentSnapshotId) {
    throw new Error("detectChanges requiere userId y currentSnapshotId");
  }

  const previous = await repo.getPreviousSnapshotItems(userId, currentSnapshotId);
  const currentItems = await repo.getSnapshotItems(currentSnapshotId);

  if (!previous) {
    return { baseline: true, reason: "primera_corrida", changes: [], inserted: [] };
  }
  if (previous.snapshotId === currentSnapshotId) {
    throw new Error("El snapshot anterior no puede ser el mismo que el actual");
  }
  if (previous.items.some((i) => String(i.externalItemId).startsWith(LEGACY_PREFIX))) {
    return { baseline: true, reason: "snapshot_legacy", changes: [], inserted: [] };
  }

  const { changes } = diffSnapshots(previous.items, currentItems);
  if (changes.length === 0) {
    return { baseline: false, reason: null, changes, inserted: [] };
  }

  const ctx = { userId, previousSnapshotId: previous.snapshotId, currentSnapshotId };
  const inserted = await repo.insertGradeChanges(changes.map((c) => toRow(c, ctx)));
  return { baseline: false, reason: null, changes, inserted: inserted ?? [] };
}

// Llave natural de una fila de grade_changes. El repo real debe tener un
// unique equivalente (ver README.md); el repo en memoria de las pruebas la usa.
function changeKey(row) {
  return [
    row.previous_snapshot_id,
    row.current_snapshot_id,
    row.subject_id,
    row.external_item_id,
    row.field_name,
  ].join("\u0000");
}

module.exports = { detectChanges, changeKey, REPO_METHODS, LEGACY_PREFIX };
