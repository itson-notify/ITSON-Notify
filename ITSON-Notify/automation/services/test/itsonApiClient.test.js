// ITN-55 - Cliente de la API REST de ITSON con fetch simulado: nunca sale a la red.
// Datos inventados.
const { test, describe } = require("node:test");
const assert = require("node:assert/strict");

const {
  crearClienteItsonApi,
  leerBaseUrl,
  leerInscripcion,
  leerProgreso,
  leerCalificaciones,
  fechaDia,
  MAX_REINTENTOS,
} = require("../itsonApiClient");

const BASE = "https://api-prueba.example.test";
const MATRICULA = "00000123456";
const CARRERA = "INSOF";
const ALUMNO = { matricula: MATRICULA, career: CARRERA };

const json = (cuerpo, status = 200) => ({
  ok: status >= 200 && status < 300,
  status,
  json: async () => cuerpo,
  text: async () => JSON.stringify(cuerpo),
});

// fetch que responde con la lista `respuestas` en orden (una función lanza).
function fetchSimulado(respuestas) {
  const llamadas = [];
  const fetchFn = async (url, init) => {
    llamadas.push({ url: new URL(url), method: init.method, body: init.body });
    const r = respuestas[Math.min(llamadas.length - 1, respuestas.length - 1)];
    if (typeof r === "function") return r();
    return r;
  };
  return { fetchFn, llamadas };
}

function cliente(respuestas) {
  const f = fetchSimulado(respuestas);
  const pausas = [];
  const api = crearClienteItsonApi({ baseUrl: BASE, fetchFn: f.fetchFn, sleep: async (ms) => pausas.push(ms) });
  return { api, llamadas: f.llamadas, pausas };
}

const GRADES = {
  message: "OK",
  responseValue: [
    { subject: { name: "Materia A", semester: null, idCatalog: "4601", program: CARRERA }, gradeValue: "-", studying: true },
    { subject: { name: "Materia B", semester: null, idCatalog: 4602, program: CARRERA }, gradeValue: "A", studying: true },
  ],
};
const PROGRESS = { response: { progress: [{ semesterKey: "07", semester: "Séptimo", approvedSubjects: 2, totalSubjects: 5 }] } };
const INSCRITO = { inscrito: true, fechaInicioSemestre: "2026-08-10", fechaFinSemestre: "2026-12-12" };

const sinDatos = (resultado) => {
  const texto = JSON.stringify(resultado);
  for (const d of [MATRICULA, "123456", CARRERA, BASE, "api-prueba"]) assert.ok(!texto.includes(d), "apareció un dato sensible");
};

describe("método y parámetros por endpoint", () => {
  test("getGrades: POST con id, semester y career en la query, sin body", async () => {
    const { api, llamadas } = cliente([json(GRADES)]);
    const r = await api.getGrades({ ...ALUMNO, semester: "07" });
    assert.equal(r.ok, true);
    const [l] = llamadas;
    assert.equal(l.method, "POST");
    assert.equal(l.url.pathname, "/api/getGrades");
    assert.deepEqual(Object.fromEntries(l.url.searchParams), { id: MATRICULA, semester: "07", career: CARRERA });
    assert.equal(l.body, undefined);
    assert.deepEqual(r.materias, [
      { idCatalog: "4601", name: "Materia A", program: CARRERA, gradeValue: "-", studying: true },
      { idCatalog: "4602", name: "Materia B", program: CARRERA, gradeValue: "A", studying: true },
    ]);
  });

  test("getProgress: POST con id y career", async () => {
    const { api, llamadas } = cliente([json(PROGRESS)]);
    const r = await api.getProgress(ALUMNO);
    assert.equal(llamadas[0].method, "POST");
    assert.equal(llamadas[0].url.pathname, "/api/getProgress");
    assert.deepEqual(Object.fromEntries(llamadas[0].url.searchParams), { id: MATRICULA, career: CARRERA });
    assert.deepEqual(r, { ok: true, semestres: [{ semesterKey: "07", approvedSubjects: 2, totalSubjects: 5 }] });
  });

  test("getAlumnoInscrito: GET con emplid y carrera", async () => {
    const { api, llamadas } = cliente([json(INSCRITO)]);
    const r = await api.getAlumnoInscrito(ALUMNO);
    assert.equal(llamadas[0].method, "GET");
    assert.equal(llamadas[0].url.pathname, "/api/getAlumnoInscrito");
    assert.deepEqual(Object.fromEntries(llamadas[0].url.searchParams), { emplid: MATRICULA, carrera: CARRERA });
    assert.deepEqual(r, { ok: true, inscrito: true, inicio: "2026-08-10", fin: "2026-12-12" });
  });

  test("pausa entre llamadas, no antes de la primera", async () => {
    const { api, pausas } = cliente([json(INSCRITO), json(PROGRESS)]);
    await api.getAlumnoInscrito(ALUMNO);
    assert.deepEqual(pausas, []);
    await api.getProgress(ALUMNO);
    assert.deepEqual(pausas, [1000]);
  });
});

describe("reintentos y errores", () => {
  test(`5xx se reintenta ${MAX_REINTENTOS} veces y luego http_5xx`, async () => {
    const { api, llamadas } = cliente([json(null, 503)]);
    const r = await api.getProgress(ALUMNO);
    assert.deepEqual(r, { ok: false, motivo: "http_5xx", status: 503 });
    assert.equal(llamadas.length, MAX_REINTENTOS + 1);
  });

  test("5xx y luego 200: se recupera", async () => {
    const { api, llamadas } = cliente([json(null, 502), json(PROGRESS)]);
    assert.equal((await api.getProgress(ALUMNO)).ok, true);
    assert.equal(llamadas.length, 2);
  });

  test("4xx no se reintenta", async () => {
    for (const status of [400, 404, 405]) {
      const { api, llamadas } = cliente([json(null, status)]);
      assert.deepEqual(await api.getGrades({ ...ALUMNO, semester: "07" }), { ok: false, motivo: "http_4xx", status });
      assert.equal(llamadas.length, 1);
    }
  });

  test("timeout y red se reintentan; el resultado no cita la URL ni la matrícula", async () => {
    const timeout = () => {
      const e = new Error(`timeout en ${BASE}/api/getProgress?id=${MATRICULA}`);
      e.name = "TimeoutError";
      throw e;
    };
    const red = () => {
      throw new TypeError(`fetch failed ${BASE}/api/getProgress?id=${MATRICULA}&career=${CARRERA}`);
    };
    for (const [falla, motivo] of [[timeout, "timeout"], [red, "red"]]) {
      const { api, llamadas } = cliente([falla]);
      const r = await api.getProgress(ALUMNO);
      assert.deepEqual(r, { ok: false, motivo, status: null });
      assert.equal(llamadas.length, MAX_REINTENTOS + 1);
      sinDatos(r);
    }
  });

  test("cuerpo que no es JSON: no_json", async () => {
    const { api } = cliente([{ ok: true, status: 200, json: async () => { throw new SyntaxError(MATRICULA); } }]);
    assert.deepEqual(await api.getProgress(ALUMNO), { ok: false, motivo: "no_json", status: 200 });
  });

  test("forma inesperada: forma_invalida sin citar datos", async () => {
    const { api } = cliente([json({ responseValue: { otra: MATRICULA } })]);
    const r = await api.getGrades({ ...ALUMNO, semester: "07" });
    assert.deepEqual(r, { ok: false, motivo: "forma_invalida", status: 200 });
    sinDatos(r);
  });
});

describe("lectura de respuestas", () => {
  test("leerInscripcion: ISO sin zona en hora de Hermosillo, booleanos en texto y dd/mm/aaaa", () => {
    assert.deepEqual(
      leerInscripcion({ inscrito: true, fechaInicioSemestre: "2026-08-10T00:00:00", fechaFinSemestre: "2026-12-12T23:59:59" }),
      { inscrito: true, inicio: "2026-08-10", fin: "2026-12-12" },
    );
    assert.deepEqual(leerInscripcion({ responseValue: { inscrito: "S", fechaInicioSemestre: "10/8/2026", fechaFinSemestre: "12/12/2026" } }), {
      inscrito: true, inicio: "2026-08-10", fin: "2026-12-12",
    });
  });

  test("leerInscripcion: lo ilegible queda en null en lugar de invalidar la respuesta", () => {
    assert.deepEqual(leerInscripcion({ inscrito: false }), { inscrito: false, inicio: null, fin: null });
    assert.deepEqual(leerInscripcion({ inscrito: "tal vez", fechaInicioSemestre: "pronto" }), { inscrito: null, inicio: null, fin: null });
    assert.equal(leerInscripcion("no es objeto"), null);
  });

  test("leerInscripcion: arreglo de exactamente un objeto, solo o envuelto (forma real)", () => {
    const uno = { inscrito: true, fechaInicioSemestre: "2026-08-10T00:00:00", fechaFinSemestre: "2026-12-12T00:00:00" };
    const esperado = { inscrito: true, inicio: "2026-08-10", fin: "2026-12-12" };
    assert.deepEqual(leerInscripcion([uno]), esperado);
    assert.deepEqual(leerInscripcion({ responseValue: [uno] }), esperado);
    assert.deepEqual(leerInscripcion({ response: [uno] }), esperado);
  });

  test("leerInscripcion: arreglo con 0 o 2 elementos, o elemento que no es objeto, es forma_invalida", () => {
    const uno = { inscrito: true, fechaInicioSemestre: "2026-08-10T00:00:00", fechaFinSemestre: "2026-12-12T00:00:00" };
    assert.equal(leerInscripcion([uno, { ...uno, inscrito: false }]), null);
    assert.equal(leerInscripcion({ responseValue: [uno, uno] }), null);
    assert.equal(leerInscripcion([]), null);
    assert.equal(leerInscripcion([true]), null);
    assert.equal(leerInscripcion({ responseValue: [[uno]] }), null);
  });

  test("leerInscripcion: respuesta vacía es válida sin datos y el booleano directo es inscrito", () => {
    const sinDatos = { inscrito: null, inicio: null, fin: null };
    for (const vacio of [null, [], {}]) {
      assert.deepEqual(leerInscripcion({ responseValue: vacio }), sinDatos);
      assert.deepEqual(leerInscripcion({ message: "Sin datos", response: vacio }), sinDatos);
    }
    assert.deepEqual(leerInscripcion({ responseValue: false }), { inscrito: false, inicio: null, fin: null });
    assert.deepEqual(leerInscripcion({ response: true }), { inscrito: true, inicio: null, fin: null });
  });

  test("getAlumnoInscrito con la forma real: ok con fechas; con dos objetos: forma_invalida", async () => {
    const uno = { inscrito: true, fechaInicioSemestre: "2026-08-10T00:00:00", fechaFinSemestre: "2026-12-12T00:00:00" };
    assert.deepEqual(await cliente([json([uno])]).api.getAlumnoInscrito(ALUMNO), {
      ok: true, inscrito: true, inicio: "2026-08-10", fin: "2026-12-12",
    });
    assert.deepEqual(await cliente([json([uno, uno])]).api.getAlumnoInscrito(ALUMNO), {
      ok: false, motivo: "forma_invalida", status: 200,
    });
    assert.deepEqual(await cliente([json([])]).api.getAlumnoInscrito(ALUMNO), {
      ok: false, motivo: "forma_invalida", status: 200,
    });
    assert.deepEqual(await cliente([json({ responseValue: null })]).api.getAlumnoInscrito(ALUMNO), {
      ok: true, inscrito: null, inicio: null, fin: null,
    });
  });

  test("fechaDia: con zona se convierte a Hermosillo (UTC-7)", () => {
    assert.equal(fechaDia("2026-12-13T03:00:00Z"), "2026-12-12");
    assert.equal(fechaDia("2026-12-13T03:00:00"), "2026-12-13"); // sin zona: ya es Hermosillo
    assert.equal(fechaDia("2026-12-13"), "2026-12-13");
    assert.equal(fechaDia("13 dic"), null);
  });

  test("leerProgreso acepta números en texto y rechaza faltantes", () => {
    assert.deepEqual(leerProgreso({ response: { progress: [{ semesterKey: "01", approvedSubjects: "6", totalSubjects: "6" }] } }), [
      { semesterKey: "01", approvedSubjects: 6, totalSubjects: 6 },
    ]);
    assert.equal(leerProgreso({ response: { progress: [{ semesterKey: "01" }] } }), null);
    assert.equal(leerProgreso({ response: {} }), null);
  });

  test("leerCalificaciones rechaza materias sin idCatalog o con gradeValue no textual", () => {
    assert.deepEqual(leerCalificaciones({ responseValue: [] }), []);
    assert.equal(leerCalificaciones({ responseValue: [{ subject: { name: "X", program: CARRERA }, gradeValue: "-" }] }), null);
    assert.equal(leerCalificaciones({ responseValue: [{ subject: { name: "X", idCatalog: "1", program: CARRERA }, gradeValue: 9 }] }), null);
  });
});

describe("ITSON_API_BASE_URL", () => {
  test("valida sin citar el valor", () => {
    assert.deepEqual(leerBaseUrl({ ITSON_API_BASE_URL: `${BASE}/` }), { ok: true, baseUrl: BASE });
    for (const valor of [undefined, "", "no es url", "http://api-prueba.example.test", `${BASE}?id=${MATRICULA}`]) {
      const r = leerBaseUrl({ ITSON_API_BASE_URL: valor });
      assert.equal(r.ok, false);
      assert.ok(!r.error.includes("api-prueba") && !r.error.includes(MATRICULA));
    }
  });
});
