// ITN-55 - Fase de la API REST de ITSON del cron, con la API, el backend y las alertas
// simulados. Datos inventados.
const { test, describe } = require("node:test");
const assert = require("node:assert/strict");

const { ejecutarItsonApi, semestresPendientes, normalizarMaterias, hoyEnHermosillo } = require("../itson-api-fase");
const { arrancar } = require("../extraccion-cron");
const { armarPayload, entregarResultados } = require("../entrega-backend");
const { crearClientePerfilesItson } = require("../perfiles-itson-backend");
const { notificarFalloCritico } = require("../../monitors/alertas");
const { crearClienteItsonApi } = require("../../services/itsonApiClient");

const BASE = "https://api-prueba.example.test";
const ENV = {
  BACKEND_URL: "http://backend.test",
  INTERNAL_API_KEY: "llave-de-prueba-".padEnd(40, "x"),
  ITSON_API_BASE_URL: BASE,
};
const HOY = "2026-11-13";
const CARRERA = "INSOF";
const matricula = (n) => `00000${String(100000 + n)}`;
const correo = (n) => `alumno.prueba${100000 + n}@potros.itson.edu.mx`;
const perfil = (n, career = CARRERA) => ({ email: correo(n), matricula: matricula(n), career });

const INSCRITO = { ok: true, inscrito: true, inicio: "2026-08-10", fin: "2026-12-12" };
const PROGRESO = {
  ok: true,
  semestres: [
    { semesterKey: "0", approvedSubjects: 0, totalSubjects: 3 },
    { semesterKey: "06", approvedSubjects: 6, totalSubjects: 6 },
    { semesterKey: "07", approvedSubjects: 1, totalSubjects: 5 },
    { semesterKey: "08", approvedSubjects: 0, totalSubjects: 5 },
  ],
};
const materia = (id, gradeValue = "-", program = CARRERA) => ({
  idCatalog: id, name: `Materia ${id}`, program, gradeValue, studying: true,
});
const GRADES = { ok: true, materias: [materia("4601", "-"), materia("4602", "9"), materia("4603", "A")] };

// `alumnos`: [{ n, career? , inscripcion?, progreso?, grades? ({ semestre: resultado }), lanza? }]
function simular(t, { alumnos = [{ n: 1 }], env = ENV, perfiles, envio = { ok: true } } = {}) {
  const lineas = [];
  const errores = [];
  const llamadas = [];
  const porMatricula = new Map(alumnos.map((a) => [matricula(a.n), a]));
  const api = {
    async getAlumnoInscrito({ matricula: m }) {
      llamadas.push(["inscrito", m]);
      return porMatricula.get(m).inscripcion ?? INSCRITO;
    },
    async getProgress({ matricula: m }) {
      llamadas.push(["progress", m]);
      const a = porMatricula.get(m);
      if (a.lanza) throw new TypeError(`fallo con ${m} ${a.email}`);
      return a.progreso ?? PROGRESO;
    },
    async getGrades({ matricula: m, semester }) {
      llamadas.push(["grades", m, semester]);
      return porMatricula.get(m).grades?.[semester] ?? GRADES;
    },
  };
  const alertar = t.mock.fn(async () => {});
  const entregar = t.mock.fn(async () => (typeof envio === "function" ? envio() : envio));
  const pausa = t.mock.fn(async () => {});
  const correr = () =>
    ejecutarItsonApi({
      env,
      crearClienteApi: () => api,
      crearClientePerfiles: () => ({
        listarActivos: async () =>
          perfiles ?? { ok: true, alumnos: alumnos.map((a) => perfil(a.n, a.career)), descartados: 0 },
      }),
      entregar,
      alertar,
      pausa,
      hoy: () => HOY,
      log: (l) => lineas.push(l),
      logError: (l) => errores.push(l),
    });
  return { correr, lineas, errores, llamadas, alertar, entregar, pausa };
}

const sinDatosPersonales = (texto, ns = [1, 2, 3]) => {
  for (const n of ns) {
    for (const d of [matricula(n), String(100000 + n), correo(n)]) assert.ok(!texto.includes(d), "apareció un dato del alumno");
  }
  assert.ok(!texto.includes(BASE) && !texto.includes("api-prueba"), "apareció la URL de la API");
};

describe("flujo por alumno", () => {
  test("consulta 07 y 08 (no 0 ni 06 completo) y envía snapshots itson_api normalizados", async (t) => {
    const s = simular(t);
    assert.equal(await s.correr(), 0);

    assert.deepEqual(s.llamadas.map((l) => l.slice(0, 1).concat(l.slice(2))), [
      ["inscrito"], ["progress"], ["grades", "07"], ["grades", "08"],
    ]);
    assert.equal(s.entregar.mock.callCount(), 2);
    const [resultado, opciones] = s.entregar.mock.calls[0].arguments;
    assert.equal(opciones.source, "itson_api");
    assert.equal(opciones.period, "07");
    assert.equal(opciones.email, correo(1));
    assert.deepEqual(resultado.courses[0], {
      externalId: "4601",
      subject: "Materia 4601",
      items: [{ externalItemId: "4601", label: "Calificación final", value: null, text: null }],
    });
    assert.deepEqual(resultado.courses.map((c) => c.items[0].text), [null, "9", "A"]);
    assert.equal(s.entregar.mock.calls[1].arguments[1].period, "08");
    assert.equal(s.alertar.mock.callCount(), 0);
    sinDatosPersonales([...s.lineas, ...s.errores].join("\n"));
  });

  test("máximo 3 semestres, en orden", () => {
    const semestres = ["05", "03", "0", "04", "02", "01"].map((k) => ({ semesterKey: k, approvedSubjects: 0, totalSubjects: 4 }));
    assert.deepEqual(semestresPendientes(semestres), ["01", "02", "03"]);
  });

  test("no inscrito u hoy fuera de fechas: se omite sin consultar más", async (t) => {
    const s = simular(t, {
      alumnos: [
        { n: 1, inscripcion: { ok: true, inscrito: false, inicio: null, fin: null } },
        { n: 2, inscripcion: { ok: true, inscrito: true, inicio: "2027-01-10", fin: "2027-05-30" } },
        { n: 3, inscripcion: { ok: true, inscrito: true, inicio: "2026-08-10", fin: HOY } }, // último día: sí
      ],
    });
    assert.equal(await s.correr(), 0);
    assert.deepEqual(s.llamadas.filter((l) => l[0] === "progress").map((l) => l[1]), [matricula(3)]);
    assert.match(s.lineas.at(-1), /no_inscritos=2/);
  });

  test("si getAlumnoInscrito falla, sigue con el alumno y lo cuenta", async (t) => {
    const s = simular(t, { alumnos: [{ n: 1, inscripcion: { ok: false, motivo: "http_5xx", status: 503 } }] });
    assert.equal(await s.correr(), 1);
    assert.equal(s.entregar.mock.callCount(), 2);
    assert.match(s.errores.at(-1), /inscripcion_fallida=1/);
    assert.equal(s.alertar.mock.calls[0].arguments[0].conteos.inscripcion_fallida, 1);
  });

  test("program distinto de la carrera guardada: descarta esa respuesta como forma_invalida", async (t) => {
    const s = simular(t, {
      alumnos: [{ n: 1, grades: { "07": { ok: true, materias: [materia("4601"), materia("4602", "8", "LCE")] } } }],
    });
    assert.equal(await s.correr(), 1);
    assert.deepEqual(s.entregar.mock.calls.map((c) => c.arguments[1].period), ["08"]);
    assert.match(s.errores.at(-1), /forma_invalida=1/);
    sinDatosPersonales(s.errores.join("\n"));
    assert.ok(!s.errores.join("\n").includes("LCE"));
  });

  test("semestre con 0 materias: no envía", async (t) => {
    const s = simular(t, { alumnos: [{ n: 1, grades: { "07": { ok: true, materias: [] } } }] });
    assert.equal(await s.correr(), 0);
    assert.deepEqual(s.entregar.mock.calls.map((c) => c.arguments[1].period), ["08"]);
    assert.match(s.lineas.at(-1), /sin_materias=1/);
  });

  test("sin semestres pendientes: no consulta getGrades", async (t) => {
    const s = simular(t, { alumnos: [{ n: 1, progreso: { ok: true, semestres: [{ semesterKey: "0", approvedSubjects: 0, totalSubjects: 2 }] } }] });
    assert.equal(await s.correr(), 0);
    assert.equal(s.llamadas.filter((l) => l[0] === "grades").length, 0);
  });
});

describe("aislamiento y alertas", () => {
  test("una excepción con un alumno no detiene a los demás", async (t) => {
    const s = simular(t, { alumnos: [{ n: 1 }, { n: 2, lanza: true }, { n: 3 }] });
    assert.equal(await s.correr(), 1);
    assert.equal(s.entregar.mock.callCount(), 4); // alumnos 1 y 3, dos semestres cada uno
    assert.match(s.errores.join("\n"), /Excepción con alumno 2\/3: TypeError/);
    sinDatosPersonales([...s.lineas, ...s.errores].join("\n"));
    assert.equal(s.pausa.mock.callCount(), 2);
  });

  test("varias fallas de API: una sola alerta, solo con conteos", async (t) => {
    const falla = { ok: false, motivo: "timeout", status: null };
    const s = simular(t, { alumnos: [{ n: 1, progreso: falla }, { n: 2, grades: { "07": falla, "08": falla } }, { n: 3 }] });
    assert.equal(await s.correr(), 1);
    assert.equal(s.alertar.mock.callCount(), 1);
    const [evento] = s.alertar.mock.calls[0].arguments;
    assert.equal(evento.tipo, "api_itson_con_fallas");
    assert.equal(evento.fuente, "itson-api");
    assert.deepEqual(evento.conteos, {
      cuentas: 3, fallidas: 3, fallas_api: 3, forma_invalida: 0, inscripcion_fallida: 0, entregas_fallidas: 0,
    });
    // Solo el evento: el segundo argumento lleva el env para que alertas.js encuentre Telegram.
    sinDatosPersonales(JSON.stringify(s.alertar.mock.calls.map((c) => c.arguments[0])));
  });

  test("una entrega fallida cuenta en entregas_fallidas", async (t) => {
    const s = simular(t, { envio: { ok: false, status: 500 } });
    assert.equal(await s.correr(), 1);
    assert.equal(s.alertar.mock.calls[0].arguments[0].conteos.entregas_fallidas, 2);
  });
});

describe("configuración y backend", () => {
  test("sin ITSON_API_BASE_URL la fase queda deshabilitada (0) sin consultar nada", async (t) => {
    const s = simular(t, { env: { ...ENV, ITSON_API_BASE_URL: "" } });
    assert.equal(await s.correr(), 0);
    assert.equal(s.llamadas.length, 0);
    assert.equal(s.alertar.mock.callCount(), 0);
  });

  test("RPA_PAUSADO=true: 0 sin consultar", async (t) => {
    const s = simular(t, { env: { ...ENV, RPA_PAUSADO: "true" } });
    assert.equal(await s.correr(), 0);
    assert.equal(s.llamadas.length, 0);
  });

  test("URL inválida: 1 y alerta de configuración, sin citar la URL", async (t) => {
    const s = simular(t, { env: { ...ENV, ITSON_API_BASE_URL: "http://api-prueba.example.test" } });
    assert.equal(await s.correr(), 1);
    assert.equal(s.alertar.mock.calls[0].arguments[0].tipo, "configuracion");
    sinDatosPersonales(s.errores.join("\n"));
  });

  test("el backend no entrega la lista de perfiles: 1 y alerta de backend", async (t) => {
    const s = simular(t, { perfiles: { ok: false, status: 401 } });
    assert.equal(await s.correr(), 1);
    assert.equal(s.alertar.mock.calls[0].arguments[0].tipo, "backend");
    assert.equal(s.llamadas.length, 0);
  });

  test("sin perfiles: 0", async (t) => {
    const s = simular(t, { perfiles: { ok: true, alumnos: [], descartados: 0 } });
    assert.equal(await s.correr(), 0);
  });
});

describe("dos fases independientes en arrancar", () => {
  test("la fase de la API corre aunque iVirtual lance, y el código combina las dos", async (t) => {
    const alertar = t.mock.fn(async () => {});
    const api = t.mock.fn(async () => 0);
    const codigo = await arrancar({
      correr: async () => {
        throw new TypeError("x");
      },
      correrApi: api,
      alertar,
      logError: () => {},
    });
    assert.equal(codigo, 1);
    assert.equal(api.mock.callCount(), 1);
    assert.equal(alertar.mock.calls[0].arguments[0].fuente, "worker-rpa");
  });

  test("una excepción en la fase de la API no cambia el resultado de iVirtual y alerta con su fuente", async (t) => {
    const alertar = t.mock.fn(async () => {});
    const ivirtual = t.mock.fn(async () => 0);
    const codigo = await arrancar({
      correr: ivirtual,
      correrApi: async () => {
        throw new RangeError("y");
      },
      alertar,
      logError: () => {},
    });
    assert.equal(codigo, 1);
    assert.equal(ivirtual.mock.callCount(), 1);
    assert.equal(alertar.mock.calls[0].arguments[0].fuente, "itson-api");
  });

  test("sin cuentas de iVirtual, la fase de la API corre igual", async (t) => {
    const api = t.mock.fn(async () => 0);
    assert.equal(await arrancar({ correr: async () => 0, correrApi: api, alertar: async () => {}, logError: () => {} }), 0);
    assert.equal(api.mock.callCount(), 1);
  });

  test("las dos en 0: 0; cualquiera en 1: 1", async () => {
    const base = { alertar: async () => {}, logError: () => {} };
    assert.equal(await arrancar({ ...base, correr: async () => 0, correrApi: async () => 0 }), 0);
    assert.equal(await arrancar({ ...base, correr: async () => 1, correrApi: async () => 0 }), 1);
    assert.equal(await arrancar({ ...base, correr: async () => 0, correrApi: async () => 1 }), 1);
  });
});

describe("piezas reales con fetch simulado", () => {
  test("de punta a punta: ninguna línea ni alerta contiene matrícula, carrera, correo ni URL", async () => {
    const salidas = [];
    const alertas = [];
    const cuerpos = [];
    const respuestaApi = (url) => {
      const u = new URL(url);
      // Las respuestas repiten la matrícula para probar que no se filtra.
      if (u.pathname.endsWith("getAlumnoInscrito")) return { inscrito: true, fechaInicioSemestre: "2026-08-10", fechaFinSemestre: "2026-12-12", emplid: matricula(1) };
      if (u.pathname.endsWith("getProgress")) return { response: { progress: [{ semesterKey: "07", approvedSubjects: 0, totalSubjects: 2 }] } };
      return { message: "OK", responseValue: [{ subject: { name: "Materia X", semester: null, idCatalog: "4601", program: CARRERA }, gradeValue: "-", studying: true }] };
    };
    const fetchApi = async (url) => {
      if (String(url).includes("getProgress")) throw new TypeError(`fetch failed ${url}`);
      return { ok: true, status: 200, json: async () => respuestaApi(url), text: async () => "" };
    };
    const fetchBackend = async (url, init) => {
      if (String(url).endsWith("/internal/itson-profiles/active")) {
        return { ok: true, status: 200, json: async () => ({ students: [perfil(1)] }) };
      }
      cuerpos.push(JSON.parse(init.body));
      return { ok: true, status: 200, json: async () => ({ baseline: true, changes_detected: 0 }) };
    };

    const codigo = await ejecutarItsonApi({
      env: ENV,
      crearClienteApi: ({ baseUrl }) => crearClienteItsonApi({ baseUrl, fetchFn: fetchApi, sleep: async () => {} }),
      crearClientePerfiles: ({ config }) => crearClientePerfilesItson({ config, fetchFn: fetchBackend, sleep: async () => {} }),
      entregar: (r, o) => entregarResultados(r, { ...o, fetchFn: fetchBackend, sleep: async () => {} }),
      alertar: async (evento, opciones) => {
        alertas.push(evento);
        return notificarFalloCritico(evento, { ...opciones, env: {} });
      },
      pausa: async () => {},
      hoy: () => HOY,
      log: (l) => salidas.push(l),
      logError: (l) => salidas.push(l),
    });

    assert.equal(codigo, 1); // getProgress falló por red
    assert.equal(cuerpos.length, 0);
    const texto = salidas.join("\n") + JSON.stringify(alertas);
    sinDatosPersonales(texto, [1]);
    assert.ok(!texto.includes(CARRERA));
    assert.match(texto, /getProgress fallida \(alumno 1\/1\): motivo=red/);
  });

  test("armarPayload: itson_api lleva period; iVirtual no cambia", () => {
    const base = { runId: "r", capturedAt: "c", email: "e", courses: [] };
    assert.deepEqual(armarPayload(base), { run_id: "r", captured_at: "c", source: "ivirtual", user: { email: "e" }, courses: [] });
    assert.deepEqual(armarPayload({ ...base, source: "itson_api", period: "07" }), {
      run_id: "r", captured_at: "c", source: "itson_api", period: "07", user: { email: "e" }, courses: [],
    });
  });

  test("normalizarMaterias: idCatalog repetido descarta la respuesta", () => {
    assert.equal(normalizarMaterias([materia("1"), materia("1")], CARRERA), null);
  });

  test("hoyEnHermosillo usa la fecha local (UTC-7)", () => {
    assert.equal(hoyEnHermosillo(new Date("2026-11-14T05:00:00Z")), "2026-11-13");
  });
});
