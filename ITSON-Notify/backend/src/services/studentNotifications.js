// ITN-53 - Convierte filas de notifications_log a la interfaz Notif del frontend.
// El texto del aviso ya está en payload.text (ver notificationService); el resto
// sale de grade_changes y subjects.
const { describirCodigo } = require("./itsonGradeCodes");
const { esGrupoTareaNueva } = require("./notificationService");
const { formatearFechaHermosillo, ZONA } = require("../utils/fechaHermosillo");

// notifications_log no tiene columna de tipo. Los avisos de iVirtual e itson_api
// son "calificaciones" (incluidas las tareas nuevas de iVirtual, como hasta hoy);
// los de Classroom (payload.source = "classroom", ITN-50) son "tareas". Cupos y
// trámites llegarán cuando exista un detector que los escriba.
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

// ITN-50 - Avisos de tareas nuevas de Classroom (classroomDispatch). No tienen
// grade_changes: todo lo que se muestra viene del payload que guardó el despacho.
const CLASSROOM = "classroom";
const CLASSROOM_TYPE = "tareas";
const texto = (v) => (typeof v === "string" && v.trim() !== "" ? v : undefined);

function toClassroomNotif(row) {
  const p = row.payload;
  const materia = texto(p.course_name);
  const rows = [];
  if (materia) rows.push({ label: "Materia", value: materia });
  if (texto(p.task_title)) rows.push({ label: "Tarea", value: p.task_title });
  if ("due_at" in p) {
    const fecha = formatearFechaHermosillo(p.due_at);
    rows.push({ label: "Entrega", value: fecha ? `${fecha} (${ZONA})` : "Sin fecha de entrega" });
  }
  return {
    id: row.id,
    type: CLASSROOM_TYPE,
    title: "Nueva tarea publicada",
    subject: materia ?? SIN_MATERIA,
    time: new Date(row.created_at).toISOString(),
    unread: row.read_at == null,
    body: texto(p.text) ?? "Hay una tarea nueva en Google Classroom.",
    rows,
  };
}

function toNotif(row, changesById, subjectNames) {
  if (row.payload?.source === CLASSROOM) return toClassroomNotif(row);
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

module.exports = { listStudentNotifications, toNotif, NOTIFICATION_TYPE, CLASSROOM_TYPE };
