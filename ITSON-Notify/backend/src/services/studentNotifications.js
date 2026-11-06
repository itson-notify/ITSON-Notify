// ITN-53 - Convierte filas de notifications_log a la interfaz Notif del frontend.
// El texto del aviso ya está en payload.text (ver notificationService); el resto
// sale de grade_changes y subjects.

// notifications_log no tiene columna de tipo y hoy solo registra cambios de
// calificación. Tareas, cupos y trámites llegarán cuando exista un detector que
// los escriba.
const NOTIFICATION_TYPE = "calificaciones";

const SIN_MATERIA = "Materia no disponible";
const SIN_VALOR = "Sin valor";

// Los avisos agrupados guardan todos sus cambios en payload.grade_change_ids; los
// individuales solo tienen grade_change_id.
function changeIdsOf(row) {
  const agrupados = row.payload?.grade_change_ids;
  if (Array.isArray(agrupados) && agrupados.length > 0) return agrupados;
  return row.grade_change_id ? [row.grade_change_id] : [];
}

function titleOf(changes) {
  if (changes.length === 0) return "Cambio de calificación";
  if (changes.every((c) => c.change_type === "created")) return "Nueva calificación disponible";
  if (changes.every((c) => c.change_type === "deleted")) return "Calificación eliminada";
  return "Calificación actualizada";
}

function rowsOf(subjectName, changes) {
  const rows = [];
  if (subjectName) rows.push({ label: "Materia", value: subjectName });
  // grade_value y grade_text describen la misma nota, igual que en buildGroupedMessage.
  const nota = changes.find((c) => c.field_name === "grade_value") ?? changes.find((c) => c.field_name === "grade_text");
  if (nota) {
    rows.push({ label: "Calificación", value: nota.current_value ?? SIN_VALOR });
    if (nota.previous_value != null) rows.push({ label: "Anterior", value: nota.previous_value });
  }
  return rows;
}

function toNotif(row, changesById, subjectNames) {
  const changes = changeIdsOf(row).map((id) => changesById.get(id)).filter(Boolean);
  const subjectId = changes.find((c) => c.subject_id)?.subject_id;
  const subjectName = subjectId ? subjectNames.get(subjectId) : undefined;
  return {
    id: row.id,
    type: NOTIFICATION_TYPE,
    title: titleOf(changes),
    subject: subjectName ?? SIN_MATERIA,
    // PostgREST devuelve +00:00: se normaliza a ISO con Z.
    time: new Date(row.created_at).toISOString(),
    unread: row.read_at == null,
    body: row.payload?.text ?? "Hubo un cambio en tus calificaciones.",
    rows: rowsOf(subjectName, changes),
  };
}

// Lista las notificaciones del alumno, más recientes primero.
async function listStudentNotifications(userId, repo) {
  const filas = await repo.listNotifications(userId);
  const changeIds = [...new Set(filas.flatMap(changeIdsOf))];
  const changes = await repo.getGradeChanges(userId, changeIds);
  const subjectIds = [...new Set(changes.map((c) => c.subject_id).filter(Boolean))];
  const subjects = await repo.getSubjects(userId, subjectIds);

  const changesById = new Map(changes.map((c) => [c.id, c]));
  const subjectNames = new Map(subjects.map((s) => [s.id, s.name]));
  return filas.map((row) => toNotif(row, changesById, subjectNames));
}

module.exports = { listStudentNotifications, toNotif, NOTIFICATION_TYPE };
