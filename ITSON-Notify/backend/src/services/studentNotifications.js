// ITN-53 - Convierte filas de notifications_log a la interfaz Notif del frontend.
// El texto del aviso ya está en payload.text (ver notificationService); el resto
// sale de grade_changes y subjects.
const { describirCodigo } = require("./itsonGradeCodes");
const { esGrupoTareaNueva } = require("./notificationService");
const { formatearFechaHermosillo, ZONA } = require("../utils/fechaHermosillo");
const { toClassroomDeliveryNotif, CLASSROOM_NOTIF_TYPE } = require("./classroomDeliveryService");

// notifications_log no tiene columna de tipo y registra cambios de calificación.
// Los avisos entregados de Classroom provienen de classroom_notification_deliveries
// (migración 019, ITN-50 / ITN-44) con categoría "tareas".
const NOTIFICATION_TYPE = "calificaciones";
const CLASSROOM_TYPE = CLASSROOM_NOTIF_TYPE;

const SIN_MATERIA = "Materia no disponible";
const SIN_VALOR = "Sin valor";

// Los avisos agrupados guardan todos sus cambios en payload.grade_change_ids; los
// individuales solo tienen grade_change_id.
function changeIdsOf(row) {
  const agrupados = row.payload?.grade_change_ids;
  if (Array.isArray(agrupados) && agrupados.length > 0) return agrupados;
  return row.grade_change_id ? [row.grade_change_id] : [];
}

// ITN-55 - Los avisos de la API REST de ITSON guardan source en el payload.
const ITSON_API = "itson_api";

function titleOf(changes, source) {
  if (source === ITSON_API) {
    const nota = changes.find((c) => c.field_name === "grade_text");
    return nota?.previous_value == null ? "Calificación final" : "Calificación final actualizada";
  }
  if (changes.length === 0) return "Cambio de calificación";
  // ITN-56 - Ítem nuevo sin nota ("-" de Moodle incluido): tarea nueva, igual que el aviso.
  if (esGrupoTareaNueva(changes)) return "Nueva tarea publicada";
  if (changes.every((c) => c.change_type === "created")) return "Nueva calificación disponible";
  if (changes.every((c) => c.change_type === "deleted")) return "Calificación eliminada";
  return "Calificación actualizada";
}

// ITN-56 - payload.due_at: lo guarda notifyGroupedChanges en los avisos de iVirtual
// cuando conoce la fecha (ISO o null). Si no viene (avisos viejos, itson_api o
// fecha desconocida), no se agrega la fila.
function rowsOf(subjectName, changes, source, payload = null) {
  const mostrar = (v) => (source === ITSON_API && v != null ? describirCodigo(v) : v);
  const rows = [];
  if (subjectName) rows.push({ label: "Materia", value: subjectName });
  // grade_value y grade_text describen la misma nota, igual que en buildGroupedMessage.
  const nota = changes.find((c) => c.field_name === "grade_value") ?? changes.find((c) => c.field_name === "grade_text");
  if (nota) {
    rows.push({ label: "Calificación", value: mostrar(nota.current_value) ?? SIN_VALOR });
    if (nota.previous_value != null) rows.push({ label: "Anterior", value: mostrar(nota.previous_value) });
  }
  if (source !== ITSON_API && payload && "due_at" in payload) {
    const fecha = formatearFechaHermosillo(payload.due_at);
    rows.push({ label: "Entrega", value: fecha ? `${fecha} (${ZONA})` : "Sin fecha de entrega" });
  }
  return rows;
}

function toNotif(row, changesById, subjectNames) {
  const changes = changeIdsOf(row).map((id) => changesById.get(id)).filter(Boolean);
  const subjectId = changes.find((c) => c.subject_id)?.subject_id;
  const subjectName = subjectId ? subjectNames.get(subjectId) : undefined;
  const source = row.payload?.source;
  return {
    id: row.id,
    type: NOTIFICATION_TYPE,
    title: titleOf(changes, source),
    subject: subjectName ?? SIN_MATERIA,
    // PostgREST devuelve +00:00: se normaliza a ISO con Z.
    time: new Date(row.created_at).toISOString(),
    unread: row.read_at == null,
    body: row.payload?.text ?? "Hubo un cambio en tus calificaciones.",
    rows: rowsOf(subjectName, changes, source, row.payload),
  };
}

// Lista las notificaciones del alumno, más recientes primero (calificaciones +
// tareas de Classroom entregadas en el ledger 019).
async function listStudentNotifications(userId, repo) {
  const filas = await repo.listNotifications(userId);
  const changeIds = [...new Set(filas.flatMap(changeIdsOf))];
  const changes = await repo.getGradeChanges(userId, changeIds);
  const subjectIds = [...new Set(changes.map((c) => c.subject_id).filter(Boolean))];
  const subjects = await repo.getSubjects(userId, subjectIds);

  const changesById = new Map(changes.map((c) => [c.id, c]));
  const subjectNames = new Map(subjects.map((s) => [s.id, s.name]));
  const gradeNotifs = filas.map((row) => toNotif(row, changesById, subjectNames));

  const classroomDeliveries =
    typeof repo.listClassroomDeliveredEvents === "function"
      ? await repo.listClassroomDeliveredEvents(userId)
      : [];
  const classroomNotifs = (classroomDeliveries ?? []).map((row) => toClassroomDeliveryNotif(row));

  if (classroomNotifs.length === 0) return gradeNotifs;

  return [...gradeNotifs, ...classroomNotifs]
    .sort((a, b) => Date.parse(b.time) - Date.parse(a.time) || String(b.id).localeCompare(String(a.id)))
    .slice(0, 100);
}

module.exports = { listStudentNotifications, toNotif, toClassroomDeliveryNotif, NOTIFICATION_TYPE, CLASSROOM_TYPE };
