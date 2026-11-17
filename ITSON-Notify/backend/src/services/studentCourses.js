// ITN-57 - Arma la vista de materias (/api/courses) y actividades o tareas por
// materia (/api/courses/:id/items) del alumno de la sesión.
//
// Fuentes:
//   - ivirtual: último snapshot de grade_snapshots con source = 'ivirtual' y sus
//     filas en snapshot_grades. La calificación final de la materia prefiere el ítem
//     con raw_payload.type === 'course' y usa grade_label null solo como respaldo.
//   - itson_api: último snapshot por semestre (period) con source = 'itson_api'.
//     Cada materia trae su calificación final en grade_text (código normalizado).
//   - classroom: tablas classroom_courses y classroom_coursework (migración 006).
const { normalizarCodigo } = require("./itsonGradeCodes");

const COURSE_SOURCES = ["ivirtual", "classroom", "itson_api"];
const ITEM_KINDS = {
  ivirtual: "ivirtual",
  classroom: "classroom",
};

const ORDEN_FUENTE = {
  ivirtual: 0,
  classroom: 1,
  itson_api: 2,
};

function toIso(value) {
  if (!value) return null;
  const ms = Date.parse(value);
  return Number.isNaN(ms) ? null : new Date(ms).toISOString();
}

function numeroONull(value) {
  if (value === null || value === undefined || value === "") return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

// En Moodle (iVirtual) el total del curso llega con itemtype 'course' y sin
// itemname (grade_label null). Para finalGrade se prefiere primero la fila con
// raw_payload.type === 'course' y se deja grade_label null (sin otro type) como
// respaldo por si un snapshot antiguo no guardó type.
function encontrarTotalCurso(filas) {
  return (
    filas.find((row) => row.raw_payload?.type === "course") ??
    filas.find(
      (row) =>
        (row.grade_label === null || row.grade_label === undefined) &&
        (!row.raw_payload?.type || row.raw_payload.type === "course"),
    ) ??
    null
  );
}

function esTotalCurso(row) {
  return row.raw_payload?.type === "course" || row.grade_label === null || row.grade_label === undefined;
}

function esResumen(row) {
  return esTotalCurso(row) || row.raw_payload?.type === "category";
}

// Calificación final para mostrar en /api/courses (texto o null). En iVirtual
// "-" significa sin calificación.
function notaFinalTexto(row) {
  if (!row) return null;
  if (row.grade_value !== null && row.grade_value !== undefined) {
    return String(row.grade_value);
  }
  if (typeof row.grade_text === "string") {
    const texto = row.grade_text.trim();
    if (texto !== "" && texto !== "-") return texto;
  }
  return null;
}

// Calificación de una actividad en /api/courses/:id/items: numérica cuando hay
// grade_value, texto si solo hay grade_text distinto de "-", o null si no está
// calificada.
function notaActividad(row) {
  const num = numeroONull(row.grade_value);
  if (num !== null) return num;
  if (typeof row.grade_text === "string") {
    const texto = row.grade_text.trim();
    if (texto !== "" && texto !== "-") return texto;
  }
  return null;
}

function compararCursos(a, b) {
  const fuente = (ORDEN_FUENTE[a.source] ?? 99) - (ORDEN_FUENTE[b.source] ?? 99);
  if (fuente !== 0) return fuente;
  // En itson_api los semestres más recientes ("05" > "04") van primero.
  const pA = a.period ?? "";
  const pB = b.period ?? "";
  if (pA !== pB) return pB.localeCompare(pA);
  const nombre = a.name.localeCompare(b.name, "es");
  if (nombre !== 0) return nombre;
  return a.id.localeCompare(b.id);
}

function compararFilasIvirtual(a, b) {
  const idA = String(a.external_item_id ?? "");
  const idB = String(b.external_item_id ?? "");
  const cmp = idA.localeCompare(idB, undefined, { numeric: true });
  if (cmp !== 0) return cmp;
  return String(a.id).localeCompare(String(b.id));
}

function compararItemsClassroom(a, b) {
  if (a.dueAt && !b.dueAt) return -1;
  if (!a.dueAt && b.dueAt) return 1;
  if (a.dueAt && b.dueAt) {
    const diff = Date.parse(a.dueAt) - Date.parse(b.dueAt);
    if (diff !== 0) return diff;
  }
  const nombre = (a.label ?? "").localeCompare(b.label ?? "", "es");
  if (nombre !== 0) return nombre;
  return a.id.localeCompare(b.id);
}

async function listStudentCourses(userId, repo) {
  const [snapshots, classroomCourses] = await Promise.all([
    repo.listLatestSnapshots(userId),
    repo.listClassroomCourses(userId),
  ]);

  const snapshotIds = snapshots.map((s) => s.id);
  const snapshotGrades = await repo.listSnapshotGrades(snapshotIds);
  const subjectIds = [...new Set(snapshotGrades.map((g) => g.subject_id).filter(Boolean))];
  const subjects = await repo.getSubjects(userId, subjectIds);
  const subjectsById = new Map(subjects.map((s) => [s.id, s]));

  // Agrupa filas por snapshot_id -> subject_id -> filas[].
  const porSnapshot = new Map();
  for (const row of snapshotGrades) {
    if (!subjectsById.has(row.subject_id)) continue;
    let porMateria = porSnapshot.get(row.snapshot_id);
    if (!porMateria) {
      porMateria = new Map();
      porSnapshot.set(row.snapshot_id, porMateria);
    }
    if (!porMateria.has(row.subject_id)) porMateria.set(row.subject_id, []);
    porMateria.get(row.subject_id).push(row);
  }

  const courses = [];

  for (const snapshot of snapshots) {
    const porMateria = porSnapshot.get(snapshot.id);
    if (!porMateria) continue;
    const updatedAt = toIso(snapshot.captured_at);

    for (const [subjectId, filas] of porMateria.entries()) {
      const subject = subjectsById.get(subjectId);
      if (!subject) continue;

      if (snapshot.source === "itson_api") {
        const unica = filas[0];
        courses.push({
          id: subject.id,
          name: subject.name,
          source: "itson_api",
          period: snapshot.period ?? null,
          finalGrade: normalizarCodigo(unica?.grade_text) ?? notaFinalTexto(unica),
          updatedAt,
        });
      } else {
        const totalRow = encontrarTotalCurso(filas);
        courses.push({
          id: subject.id,
          name: subject.name,
          source: "ivirtual",
          period: null,
          finalGrade: notaFinalTexto(totalRow),
          updatedAt,
        });
      }
    }
  }

  for (const row of classroomCourses) {
    courses.push({
      id: row.id,
      name: row.name,
      source: "classroom",
      period: row.section ?? null,
      finalGrade: null,
      updatedAt: toIso(row.last_seen_at ?? row.updated_at ?? row.created_at),
    });
  }

  courses.sort(compararCursos);
  return { courses };
}

// Devuelve { items } si el curso existe y es del alumno, o null si no existe / es
// de otro alumno.
async function listStudentCourseItems(userId, courseId, repo) {
  const subject = await repo.getSubject(userId, courseId);
  if (subject) {
    // Las materias de itson_api solo tienen calificación final en /api/courses.
    if (subject.period !== null && subject.period !== undefined) {
      return { items: [] };
    }
    const snapshot = await repo.getLatestIvirtualSnapshot(userId);
    if (!snapshot) return { items: [] };

    const filas = await repo.listSnapshotGrades([snapshot.id], { subjectId: courseId });
    const items = filas
      .filter((row) => !esResumen(row))
      .sort(compararFilasIvirtual)
      .map((row) => ({
        id: row.id,
        label: row.grade_label,
        grade: notaActividad(row),
        maxGrade: numeroONull(row.raw_payload?.max),
        dueAt: toIso(row.due_at),
        kind: ITEM_KINDS.ivirtual,
      }));
    return { items };
  }

  const classroomCourse = await repo.getClassroomCourse(userId, courseId);
  if (!classroomCourse) return null;

  const tareas = await repo.listClassroomCoursework(userId, courseId);
  const items = tareas
    .map((row) => ({
      id: row.id,
      label: row.title,
      grade: null,
      maxGrade: numeroONull(row.max_points),
      dueAt: toIso(row.due_at),
      kind: ITEM_KINDS.classroom,
    }))
    .sort(compararItemsClassroom);
  return { items };
}

module.exports = {
  listStudentCourses,
  listStudentCourseItems,
  encontrarTotalCurso,
  COURSE_SOURCES,
  ITEM_KINDS,
};
