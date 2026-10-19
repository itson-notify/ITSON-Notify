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
function shouldKeep(item) {
  return !(item.hidden === true && item.value === null);
}

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

function mapCourse(course, gradeItemsResponse) {
  const usergrades = gradeItemsResponse?.usergrades ?? [];
  const rawItems = usergrades.flatMap((ug) => ug.gradeitems ?? []);
  return {
    externalId: String(course.id),
    subject: course.fullname,
    items: rawItems.map(mapItem).filter(shouldKeep),
  };
}

async function fetchGrades(token, opts) {
  const siteInfo = await callWs(token, "core_webservice_get_site_info", {}, opts);
  const userid = siteInfo.userid;

  const courses = await callWs(
    token,
    "core_enrol_get_users_courses",
    { userid },
    opts,
  );

  const result = [];
  for (const course of courses ?? []) {
    const gradeItems = await callWs(
      token,
      "gradereport_user_get_grade_items",
      { courseid: course.id, userid },
      opts,
    );
    result.push(mapCourse(course, gradeItems));
  }
  return result;
}

module.exports = { fetchGrades, mapCourse, mapItem, shouldKeep };
