// ITN-58d - Materias fuera del plan de estudios: `scope` de cada materia de
// /api/courses ("actual" | "anterior"). Funciones puras: reciben `now` y los datos ya
// leídos, sin tocar la base.
//
// Regla (la primera que aplica decide):
//   1. La materia tiene alguna fuente que no es Classroom (iVirtual o API de ITSON,
//      sola o unificada) -> "actual", aunque su curso de Classroom esté archivado.
//   2. Solo Classroom y course_state distinto de ACTIVE (ARCHIVED, PROVISIONED,
//      DECLINED, SUSPENDED...) -> "anterior".
//   3. Solo Classroom y ACTIVE: se toma su actividad más reciente (máximo de
//      source_updated_at, o source_created_at, de sus tareas); sin tareas, el
//      first_seen_at del curso. Si cae antes del inicio del semestre actual ->
//      "anterior"; si no -> "actual".
// Si una materia junta varios cursos de Classroom, basta con que uno sea actual.
//
// Semestre actual: el period de la API de ITSON es el número de semestre del alumno
// ("05"), sin fechas, así que no sirve para fechar la actividad de Classroom. La
// ventana es por calendario en hora de Hermosillo (UTC-7 todo el año, sin horario de
// verano): empieza el 1 de enero o el 1 de agosto más reciente a `now`.
//
// Casos sin datos (se prefiere no esconder nada): course_state null cuenta como
// ACTIVE; sin actividad ni first_seen_at, o si no se pudo leer la actividad de las
// tareas (actividad desconocida), la materia queda "actual".

const SCOPES = { actual: "actual", anterior: "anterior" };
const DESFASE_HERMOSILLO_MS = 7 * 60 * 60 * 1000;
const AGOSTO = 7; // getUTCMonth: 0 = enero

function ms(value) {
  if (value === null || value === undefined || value === "") return null;
  const n = typeof value === "number" ? value : Date.parse(value);
  return Number.isFinite(n) ? n : null;
}

// Inicio del semestre actual como instante (ms UTC): 00:00 hora de Hermosillo del 1
// de enero o del 1 de agosto más reciente a `now`.
function inicioSemestre(now) {
  const local = new Date(ms(now) - DESFASE_HERMOSILLO_MS);
  const anio = local.getUTCFullYear();
  const mes = local.getUTCMonth() >= AGOSTO ? AGOSTO : 0;
  return Date.UTC(anio, mes, 1) + DESFASE_HERMOSILLO_MS;
}

// Map course_id -> ms de la tarea más reciente (source_updated_at, si no
// source_created_at). Las tareas sin ninguna de las dos fechas no cuentan.
function actividadPorCurso(tareas) {
  const porCurso = new Map();
  for (const t of tareas ?? []) {
    const fecha = ms(t.source_updated_at) ?? ms(t.source_created_at);
    if (fecha === null || !t.course_id) continue;
    const previa = porCurso.get(t.course_id);
    if (previa === undefined || fecha > previa) porCurso.set(t.course_id, fecha);
  }
  return porCurso;
}

// Scope de un curso de Classroom suelto. `actividad`: ms de su tarea más reciente,
// null si no tiene tareas con fecha, o undefined si la actividad es desconocida.
function scopeCursoClassroom(curso, actividad, inicio) {
  const estado = typeof curso?.course_state === "string" ? curso.course_state.trim().toUpperCase() : "";
  if (estado !== "" && estado !== "ACTIVE") return SCOPES.anterior;
  if (actividad === undefined) return SCOPES.actual;
  const referencia = actividad ?? ms(curso?.first_seen_at);
  if (referencia === null) return SCOPES.actual;
  return referencia < inicio ? SCOPES.anterior : SCOPES.actual;
}

// Scope de una materia unificada (con sources[]).
//   classroomPorId: Map id de classroom_courses -> fila (course_state, first_seen_at).
//   actividad: Map de actividadPorCurso, o null si no se pudo leer.
function scopeDeMateria(materia, { classroomPorId, actividad, inicio }) {
  const fuentes = materia.sources?.length ? materia.sources : [{ source: materia.source, id: materia.id }];
  if (fuentes.some((f) => f.source !== "classroom")) return SCOPES.actual;
  const algunaActual = fuentes.some((f) => {
    const curso = classroomPorId.get(f.id);
    // Sin la fila no hay con qué decidir: no se esconde.
    if (!curso) return true;
    const act = actividad ? actividad.get(f.id) ?? null : undefined;
    return scopeCursoClassroom(curso, act, inicio) === SCOPES.actual;
  });
  return algunaActual ? SCOPES.actual : SCOPES.anterior;
}

// Agrega `scope` a cada materia sin tocar sus demás campos ni el orden.
function asignarScopes(materias, { classroomCourses = [], tareas = null, now }) {
  const contexto = {
    classroomPorId: new Map(classroomCourses.map((c) => [c.id, c])),
    actividad: tareas === null ? null : actividadPorCurso(tareas),
    inicio: inicioSemestre(now),
  };
  return materias.map((m) => ({ ...m, scope: scopeDeMateria(m, contexto) }));
}

module.exports = {
  SCOPES,
  inicioSemestre,
  actividadPorCurso,
  scopeCursoClassroom,
  scopeDeMateria,
  asignarScopes,
};
