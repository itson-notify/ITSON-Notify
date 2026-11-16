const { callWs } = require("./client");

// Extrae los grade items de todos los cursos del alumno dueño del token.
// Flujo: site_info (userid) -> cursos inscritos -> grade items por curso.
// Los cursos se piden uno por uno para no saturar iVirtual. Si falla un curso,
// falla toda la extracción: un resultado parcial haría que el detector de
// cambios viera como "borradas" las calificaciones del curso faltante.

function toNumberOrNull(value) {
  if (value === null || value === undefined || value === "") return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

// Ítems ocultos: se omiten solo si están ocultos Y no tienen calificación.
// Un ítem oculto sin valor no tiene nada que notificar y normalmente tampoco
// aparece en la vista del alumno. Si ya tiene valor se conserva, porque un
// cambio de calificación sí es relevante aunque Moodle lo marque como oculto
// (p. ej. el maestro lo ocultó mientras califica al resto del grupo).
//
// ITN-56 - Excepción: una tarea recién publicada puede llegar con la nota oculta
// (gradeishidden) y sin valor. Si mod_assign_get_assignments la devuelve (o sea,
// la tarea es visible para el alumno), se conserva para no perder el aviso de
// tarea nueva. `visibles` es el Set de cmid de esas tareas; sin él (la llamada de
// tareas falló) se aplica la regla de antes.
function shouldKeep(item, visibles = null) {
  if (!(item.hidden === true && item.value === null)) return true;
  return Boolean(visibles && item.cmid !== null && visibles.has(String(item.cmid)));
}

// ITN-56 - Moodle manda las fechas como timestamp Unix en segundos, con 0 cuando
// la tarea no tiene esa fecha. Se devuelven en ISO 8601 (UTC) o null.
function unixToIso(value) {
  const n = toNumberOrNull(value);
  if (n === null || n <= 0) return null;
  const fecha = new Date(n * 1000);
  return Number.isNaN(fecha.getTime()) ? null : fecha.toISOString();
}

// Respuesta de mod_assign_get_assignments -> Map(courseid -> Map(cmid -> fechas)).
// Solo los cursos que vienen en la respuesta tienen fechas "conocidas": si Moodle
// omite un curso (p. ej. con un warning de permisos), sus ítems quedan sin los
// campos de fecha y el backend conserva las que ya tenía.
function mapAssignments(response) {
  const porCurso = new Map();
  for (const curso of response?.courses ?? []) {
    const tareas = new Map();
    for (const tarea of curso.assignments ?? []) {
      if (tarea.cmid === null || tarea.cmid === undefined) continue;
      tareas.set(String(tarea.cmid), {
        dueAt: unixToIso(tarea.duedate),
        opensAt: unixToIso(tarea.allowsubmissionsfromdate),
        closesAt: unixToIso(tarea.cutoffdate),
      });
    }
    porCurso.set(String(curso.id), tareas);
  }
  return porCurso;
}

const SIN_FECHAS = { dueAt: null, opensAt: null, closesAt: null };

function mapItem(raw) {
  return {
    externalItemId: String(raw.id),
    label: raw.itemname ?? null,
    type: raw.itemtype ?? null, // 'mod', 'manual', 'category' o 'course' (total)
    value: toNumberOrNull(raw.graderaw),
    text: raw.gradeformatted ?? null,
    min: toNumberOrNull(raw.grademin),
    max: toNumberOrNull(raw.grademax),
    percentage: raw.percentageformatted ?? null,
    categoryId: raw.categoryid ?? null,
    cmid: raw.cmid ?? null,
    hidden: Boolean(raw.gradeishidden),
  };
}

// `tareas` (ITN-56): Map(cmid -> fechas) del curso, o null si no se conocen. Con
// fechas conocidas cada ítem lleva dueAt, opensAt y closesAt (null si no es una
// tarea o no tiene esa fecha); sin ellas los campos se omiten ("desconocida").
function mapCourse(course, gradeItemsResponse, tareas = null) {
  const usergrades = gradeItemsResponse?.usergrades ?? [];
  const rawItems = usergrades.flatMap((ug) => ug.gradeitems ?? []);
  const visibles = tareas ? new Set(tareas.keys()) : null;
  const items = rawItems
    .map(mapItem)
    .filter((item) => shouldKeep(item, visibles))
    .map((item) =>
      tareas ? { ...item, ...(tareas.get(String(item.cmid)) ?? SIN_FECHAS) } : item,
    );
  return {
    externalId: String(course.id),
    subject: course.fullname,
    items,
  };
}

// ITN-56 - Fechas de las tareas de todos los cursos en una sola llamada. Si falla,
// no se cae la extracción: las notas ya se leyeron y son lo importante. Devuelve
// { porCurso, errorcode }; porCurso es null cuando no hay fechas.
async function fetchAssignments(token, courseIds, opts) {
  if (courseIds.length === 0) return { porCurso: new Map(), errorcode: null };
  try {
    const response = await callWs(
      token,
      "mod_assign_get_assignments",
      { courseids: courseIds },
      opts,
    );
    return { porCurso: mapAssignments(response), errorcode: null };
  } catch (error) {
    return { porCurso: null, errorcode: error?.errorcode ?? (error?.status ? `http_${error.status}` : "sin_codigo") };
  }
}

// Devuelve { courses, fechas }. fechas es "ok" si se leyeron las fechas de las
// tareas o "no_disponibles" si mod_assign_get_assignments falló (con su
// errorcode en fechasErrorcode); en ese caso los ítems van sin campos de fecha.
async function fetchGradesDetalle(token, opts) {
  const siteInfo = await callWs(token, "core_webservice_get_site_info", {}, opts);
  const userid = siteInfo.userid;

  const courses = await callWs(
    token,
    "core_enrol_get_users_courses",
    { userid },
    opts,
  );

  const gradeItemsPorCurso = [];
  for (const course of courses ?? []) {
    const gradeItems = await callWs(
      token,
      "gradereport_user_get_grade_items",
      { courseid: course.id, userid },
      opts,
    );
    gradeItemsPorCurso.push([course, gradeItems]);
  }

  // Después de las notas: si las notas fallan, la extracción falla como antes y
  // no se gasta la llamada de tareas.
  const { porCurso, errorcode } = await fetchAssignments(
    token,
    (courses ?? []).map((c) => c.id),
    opts,
  );

  const result = gradeItemsPorCurso.map(([course, gradeItems]) =>
    mapCourse(course, gradeItems, porCurso ? porCurso.get(String(course.id)) ?? null : null),
  );
  return porCurso
    ? { courses: result, fechas: "ok" }
    : { courses: result, fechas: "no_disponibles", fechasErrorcode: errorcode };
}

async function fetchGrades(token, opts) {
  return (await fetchGradesDetalle(token, opts)).courses;
}

module.exports = {
  fetchGrades,
  fetchGradesDetalle,
  fetchAssignments,
  mapAssignments,
  mapCourse,
  mapItem,
  shouldKeep,
  unixToIso,
};
