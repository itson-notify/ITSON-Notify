// ITN-58b - Pruebas del emparejamiento de materias entre fuentes. Nombres inventados.
const { test, describe } = require("node:test");
const assert = require("node:assert/strict");

const {
  SIMILARITY_THRESHOLD,
  normalizeCourseName,
  courseSimilarity,
  matchCourses,
} = require("../../src/services/courseMatcher");

const grupos = (entradas) => matchCourses(entradas).groups;

describe("ITN-58b - normalización y similitud", () => {
  test("el umbral exportado es alto (0.8)", () => {
    assert.equal(SIMILARITY_THRESHOLD, 0.8);
  });

  test("ignora acentos, mayúsculas, signos, relleno y sufijos de grupo o periodo", () => {
    assert.deepEqual(normalizeCourseName("INGENIERÍA de Software - Grupo 02 (2026-2)"), {
      words: ["ingenieria", "software"],
      numbers: [],
    });
    assert.deepEqual(normalizeCourseName("ingenieria del software, sec. A"), normalizeCourseName("Ingeniería de Software"));
    assert.deepEqual(normalizeCourseName("Cálculo II ago-dic 2026"), { words: ["calculo"], numbers: [2] });
    assert.equal(courseSimilarity("Ingeniería de Software", "INGENIERIA DE SOFTWARE gpo 3"), 1);
  });

  test("los números y numerales romanos deben coincidir exactamente", () => {
    assert.equal(courseSimilarity("Cálculo I", "Cálculo II"), 0);
    assert.equal(courseSimilarity("Programación 1", "Programación 2"), 0);
    assert.equal(courseSimilarity("Programación", "Programación 2"), 0);
    assert.equal(courseSimilarity("Cálculo I", "calculo 1"), 1);
  });

  test("nombres distintos quedan por debajo del umbral", () => {
    assert.ok(courseSimilarity("Ingeniería de Software", "Arquitectura de Software") < SIMILARITY_THRESHOLD);
    assert.ok(courseSimilarity("Bases de Datos", "Redes de Computadoras") < SIMILARITY_THRESHOLD);
    assert.equal(courseSimilarity("", "Bases de Datos"), 0);
  });
});

describe("ITN-58b - matchCourses", () => {
  test("une la misma materia escrita con acentos y mayúsculas distintas en tres fuentes", () => {
    const { groups, ambiguous } = matchCourses([
      { key: "iv1", source: "ivirtual", name: "Ingeniería de Software" },
      { key: "cr1", source: "classroom", name: "INGENIERIA DE SOFTWARE - Grupo 02" },
      { key: "it1", source: "itson_api", name: "ingenieria de software" },
    ]);
    assert.deepEqual(groups, [["iv1", "cr1", "it1"]]);
    assert.deepEqual(ambiguous, []);
  });

  test("no une Cálculo I con Cálculo II ni Programación 1 con Programación 2", () => {
    assert.deepEqual(
      grupos([
        { key: "iv1", source: "ivirtual", name: "Cálculo I" },
        { key: "it2", source: "itson_api", name: "Cálculo II" },
        { key: "iv2", source: "ivirtual", name: "Programación 1" },
        { key: "cr2", source: "classroom", name: "Programación 2" },
      ]),
      [["iv1"], ["it2"], ["iv2"], ["cr2"]],
    );
  });

  test("no une nombres muy distintos", () => {
    assert.deepEqual(
      grupos([
        { key: "iv1", source: "ivirtual", name: "Ingeniería de Software" },
        { key: "cr1", source: "classroom", name: "Arquitectura de Software" },
      ]),
      [["iv1"], ["cr1"]],
    );
  });

  test("con dos candidatas gana la de mayor similitud", () => {
    // "Programación Orientada a Objetos Avanzada" (4 palabras) frente a una candidata
    // exacta (1.0) y otra con una palabra de más (0.8): gana la exacta.
    const { groups, ambiguous } = matchCourses([
      { key: "iv1", source: "ivirtual", name: "Programación Orientada Objetos Avanzada" },
      { key: "cr1", source: "classroom", name: "Programación Orientada Objetos Avanzada Taller" },
      { key: "cr2", source: "classroom", name: "programacion orientada a objetos avanzada" },
    ]);
    assert.deepEqual(groups, [["iv1", "cr2"], ["cr1"]]);
    assert.deepEqual(ambiguous, []);
  });

  test("si dos candidatas empatan no se une ninguna y se reporta la ambigüedad", () => {
    const { groups, ambiguous } = matchCourses([
      { key: "iv1", source: "ivirtual", name: "Bases de Datos" },
      { key: "it-03", source: "itson_api", name: "Bases de Datos" },
      { key: "it-05", source: "itson_api", name: "BASES DE DATOS" },
      { key: "cr1", source: "classroom", name: "Bases de Datos grupo 1" },
    ]);
    // La pareja con Classroom no tiene empate y sí se une.
    assert.deepEqual(groups, [["iv1", "cr1"], ["it-03"], ["it-05"]]);
    assert.deepEqual(ambiguous.sort(), ["cr1", "it-03", "it-05", "iv1"].sort());
  });

  test("nunca une dos materias de la misma fuente", () => {
    assert.deepEqual(
      grupos([
        { key: "iv1", source: "ivirtual", name: "Ética Profesional" },
        { key: "iv2", source: "ivirtual", name: "Etica profesional" },
      ]),
      [["iv1"], ["iv2"]],
    );
  });

  test("la cadena entre fuentes no mete dos materias de la misma fuente en un grupo", () => {
    const { groups } = matchCourses([
      { key: "iv1", source: "ivirtual", name: "Redes de Computadoras" },
      { key: "cr1", source: "classroom", name: "Redes de Computadoras" },
      { key: "it1", source: "itson_api", name: "Redes Computadoras" },
      { key: "it2", source: "itson_api", name: "Redes de Computadora Lab" },
    ]);
    for (const g of groups) {
      const fuentes = g.map((k) => k.slice(0, 2));
      assert.equal(new Set(fuentes).size, fuentes.length);
    }
    assert.deepEqual(groups[0], ["iv1", "cr1", "it1"]);
  });

  test("no cambia sus entradas", () => {
    const entradas = [{ key: "a", source: "ivirtual", name: "Física" }];
    const copia = structuredClone(entradas);
    matchCourses(entradas);
    assert.deepEqual(entradas, copia);
  });
});
