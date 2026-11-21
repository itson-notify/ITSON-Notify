// ITN-58d - Reglas puras de `scope` (materias fuera del plan de estudios). Datos
// inventados; `now` fijo.
const { test, describe } = require("node:test");
const assert = require("node:assert/strict");

const {
  inicioSemestre, actividadPorCurso, scopeCursoClassroom, scopeDeMateria, asignarScopes,
} = require("../../src/services/courseScope");

// 20 de noviembre de 2026, 12:00 hora de Hermosillo.
const NOW = Date.parse("2026-11-20T19:00:00Z");
// 1 de agosto de 2026, 00:00 hora de Hermosillo.
const INICIO_AGO_2026 = Date.parse("2026-08-01T07:00:00Z");

const classroom = (id, extra = {}) => ({ id, course_state: "ACTIVE", first_seen_at: "2026-08-20T18:00:00Z", ...extra });
const soloClassroom = (id) => ({ id, name: `Curso ${id}`, source: "classroom", sources: [{ source: "classroom", id }] });
const tarea = (courseId, updated, created = null) => ({ course_id: courseId, source_updated_at: updated, source_created_at: created });

describe("ITN-58d - inicioSemestre (hora de Hermosillo)", () => {
  test("en noviembre empieza el 1 de agosto del mismo año", () => {
    assert.equal(inicioSemestre(NOW), INICIO_AGO_2026);
  });

  test("f) frontera del 1 de agosto: 00:00 de Hermosillo ya es el semestre nuevo; 23:59 del 31 de julio no", () => {
    assert.equal(inicioSemestre(Date.parse("2026-08-01T07:00:00Z")), INICIO_AGO_2026);
    assert.equal(inicioSemestre(Date.parse("2026-08-01T06:59:59Z")), Date.parse("2026-01-01T07:00:00Z"));
  });

  test("f) frontera del 1 de enero: 00:00 de Hermosillo ya es el semestre nuevo; en UTC ya es 1 de enero pero en Hermosillo no", () => {
    assert.equal(inicioSemestre(Date.parse("2027-01-01T07:00:00Z")), Date.parse("2027-01-01T07:00:00Z"));
    assert.equal(inicioSemestre(Date.parse("2027-01-01T03:00:00Z")), INICIO_AGO_2026);
  });

  test("acepta ISO o ms", () => {
    assert.equal(inicioSemestre("2026-11-20T19:00:00Z"), INICIO_AGO_2026);
  });
});

describe("ITN-58d - actividadPorCurso", () => {
  test("toma el máximo de source_updated_at y usa source_created_at como respaldo", () => {
    const act = actividadPorCurso([
      tarea("c1", "2026-09-01T00:00:00Z"),
      tarea("c1", null, "2026-10-05T00:00:00Z"),
      tarea("c1", "2026-08-10T00:00:00Z", "2026-11-01T00:00:00Z"),
      tarea("c2", null, null),
    ]);
    assert.equal(act.get("c1"), Date.parse("2026-10-05T00:00:00Z"));
    assert.equal(act.has("c2"), false);
  });
});

describe("ITN-58d - scope de cada materia", () => {
  const ctx = (cursos, tareas = []) => ({
    classroomPorId: new Map(cursos.map((c) => [c.id, c])),
    actividad: tareas === null ? null : actividadPorCurso(tareas),
    inicio: inicioSemestre(NOW),
  });

  test("a) solo Classroom y ARCHIVED -> anterior, aunque tenga actividad reciente", () => {
    const c = classroom("c1", { course_state: "ARCHIVED" });
    assert.equal(scopeDeMateria(soloClassroom("c1"), ctx([c], [tarea("c1", "2026-11-10T00:00:00Z")])), "anterior");
  });

  test("a) otros estados distintos de ACTIVE (en minúsculas o PROVISIONED) también son anterior", () => {
    assert.equal(scopeCursoClassroom(classroom("x", { course_state: "provisioned" }), null, INICIO_AGO_2026), "anterior");
    assert.equal(scopeCursoClassroom(classroom("x", { course_state: "DECLINED" }), null, INICIO_AGO_2026), "anterior");
  });

  test("b) ACTIVE con última actividad en 2023 -> anterior", () => {
    const c = classroom("c1", { first_seen_at: "2023-02-01T00:00:00Z" });
    const tareas = [tarea("c1", "2023-05-10T00:00:00Z"), tarea("c1", null, "2023-03-01T00:00:00Z")];
    assert.equal(scopeDeMateria(soloClassroom("c1"), ctx([c], tareas)), "anterior");
  });

  test("b) la actividad manda sobre first_seen_at: visto este semestre pero con tareas de 2023 -> anterior", () => {
    const c = classroom("c1", { first_seen_at: "2026-09-01T00:00:00Z" });
    assert.equal(scopeDeMateria(soloClassroom("c1"), ctx([c], [tarea("c1", "2023-05-10T00:00:00Z")])), "anterior");
  });

  test("c) ACTIVE con actividad dentro del semestre y sin coincidencia en ITSON -> actual", () => {
    const c = classroom("c1", { first_seen_at: "2024-01-15T00:00:00Z" });
    assert.equal(scopeDeMateria(soloClassroom("c1"), ctx([c], [tarea("c1", "2026-11-12T00:00:00Z")])), "actual");
  });

  test("d) unificada con ITSON del semestre actual y Classroom ARCHIVED -> actual", () => {
    const materia = {
      id: "c1", name: "Ingeniería de Software", source: "classroom",
      sources: [{ source: "classroom", id: "c1" }, { source: "itson_api", id: "s1", period: "05" }],
    };
    assert.equal(scopeDeMateria(materia, ctx([classroom("c1", { course_state: "ARCHIVED" })])), "actual");
  });

  test("d) unificada con iVirtual y Classroom ARCHIVED -> actual", () => {
    const materia = { id: "v1", name: "Redes", source: "ivirtual", sources: [{ source: "ivirtual", id: "v1" }, { source: "classroom", id: "c1" }] };
    assert.equal(scopeDeMateria(materia, ctx([classroom("c1", { course_state: "ARCHIVED" })])), "actual");
  });

  test("materias sin Classroom (iVirtual o ITSON, sin sources[]) -> actual", () => {
    assert.equal(scopeDeMateria({ id: "v1", source: "ivirtual" }, ctx([])), "actual");
    assert.equal(scopeDeMateria({ id: "s1", source: "itson_api", sources: [{ source: "itson_api", id: "s1" }] }, ctx([])), "actual");
  });

  test("e) ACTIVE sin tareas, visto por primera vez antes del inicio del semestre -> anterior", () => {
    const c = classroom("c1", { first_seen_at: "2026-07-31T23:00:00Z" });
    assert.equal(scopeDeMateria(soloClassroom("c1"), ctx([c], [])), "anterior");
  });

  test("e) ACTIVE sin tareas, visto por primera vez este semestre -> actual", () => {
    const c = classroom("c1", { first_seen_at: "2026-08-05T00:00:00Z" });
    assert.equal(scopeDeMateria(soloClassroom("c1"), ctx([c], [])), "actual");
  });

  test("f) actividad justo en el inicio del semestre es actual; un milisegundo antes, anterior", () => {
    assert.equal(scopeCursoClassroom(classroom("c1"), INICIO_AGO_2026, INICIO_AGO_2026), "actual");
    assert.equal(scopeCursoClassroom(classroom("c1"), INICIO_AGO_2026 - 1, INICIO_AGO_2026), "anterior");
    // 31 de julio 23:59 en Hermosillo (ya 1 de agosto en UTC) sigue siendo el semestre anterior.
    assert.equal(scopeCursoClassroom(classroom("c1"), Date.parse("2026-08-01T06:59:00Z"), INICIO_AGO_2026), "anterior");
  });

  test("f) frontera del 1 de enero en Hermosillo con now en enero", () => {
    const inicio = inicioSemestre(Date.parse("2027-01-10T19:00:00Z"));
    assert.equal(scopeCursoClassroom(classroom("c1"), Date.parse("2027-01-01T07:00:00Z"), inicio), "actual");
    assert.equal(scopeCursoClassroom(classroom("c1"), Date.parse("2027-01-01T06:59:59Z"), inicio), "anterior");
  });

  test("sin datos no se esconde: course_state null cuenta como ACTIVE; sin fechas, o actividad desconocida, es actual", () => {
    assert.equal(scopeCursoClassroom(classroom("c1", { course_state: null, first_seen_at: "2026-09-01T00:00:00Z" }), null, INICIO_AGO_2026), "actual");
    assert.equal(scopeCursoClassroom(classroom("c1", { course_state: null, first_seen_at: "2023-09-01T00:00:00Z" }), null, INICIO_AGO_2026), "anterior");
    assert.equal(scopeCursoClassroom(classroom("c1", { first_seen_at: null }), null, INICIO_AGO_2026), "actual");
    const viejo = classroom("c1", { first_seen_at: "2023-01-01T00:00:00Z" });
    assert.equal(scopeDeMateria(soloClassroom("c1"), ctx([viejo], null)), "actual");
    // Una materia cuya fila de Classroom no se encontró queda actual.
    assert.equal(scopeDeMateria(soloClassroom("nada"), ctx([])), "actual");
  });

  test("una materia con dos cursos de Classroom es actual si alguno lo es", () => {
    const materia = { id: "c1", source: "classroom", sources: [{ source: "classroom", id: "c1" }, { source: "classroom", id: "c2" }] };
    const cursos = [classroom("c1", { course_state: "ARCHIVED" }), classroom("c2")];
    assert.equal(scopeDeMateria(materia, ctx(cursos, [tarea("c2", "2026-11-01T00:00:00Z")])), "actual");
    assert.equal(scopeDeMateria(materia, ctx(cursos, [tarea("c2", "2025-11-01T00:00:00Z")])), "anterior");
  });
});

describe("ITN-58d - asignarScopes", () => {
  test("agrega scope sin cambiar los demás campos ni el orden", () => {
    const materias = [soloClassroom("c2"), { id: "v1", name: "Redes", source: "ivirtual", sources: [{ source: "ivirtual", id: "v1" }] }];
    const copia = structuredClone(materias);
    const salida = asignarScopes(materias, {
      classroomCourses: [classroom("c2", { course_state: "ARCHIVED" })], tareas: [], now: NOW,
    });
    assert.deepEqual(salida.map(({ scope, ...resto }) => resto), copia);
    assert.deepEqual(salida.map((m) => m.scope), ["anterior", "actual"]);
    assert.deepEqual(materias, copia, "no muta la entrada");
  });

  test("cuenta de pruebas descrita: 13 ARCHIVED, 6 ACTIVE (uno de 2023, 4 coinciden con ITSON) -> 5 actual y 14 anterior", () => {
    const cursos = [];
    const tareas = [];
    const materias = [];
    for (let i = 0; i < 13; i++) {
      cursos.push(classroom(`arch-${i}`, { course_state: "ARCHIVED", first_seen_at: "2026-08-15T00:00:00Z" }));
      tareas.push(tarea(`arch-${i}`, "2025-04-01T00:00:00Z"));
      materias.push(soloClassroom(`arch-${i}`));
    }
    cursos.push(classroom("viejo", { first_seen_at: "2026-08-15T00:00:00Z" }));
    tareas.push(tarea("viejo", "2023-10-01T00:00:00Z"));
    materias.push(soloClassroom("viejo"));
    for (let i = 0; i < 4; i++) {
      cursos.push(classroom(`itson-${i}`));
      tareas.push(tarea(`itson-${i}`, "2026-11-10T00:00:00Z"));
      materias.push({ id: `itson-${i}`, source: "classroom", sources: [{ source: "classroom", id: `itson-${i}` }, { source: "itson_api", id: `s-${i}` }] });
    }
    cursos.push(classroom("sin-match"));
    tareas.push(tarea("sin-match", "2026-11-12T00:00:00Z"));
    materias.push(soloClassroom("sin-match"));

    const salida = asignarScopes(materias, { classroomCourses: cursos, tareas, now: NOW });
    assert.equal(salida.length, 19);
    assert.equal(salida.filter((m) => m.scope === "actual").length, 5);
    assert.equal(salida.filter((m) => m.scope === "anterior").length, 14);
    assert.equal(salida.find((m) => m.id === "viejo").scope, "anterior");
    assert.equal(salida.find((m) => m.id === "sin-match").scope, "actual");
  });
});
