// ITN-55 - Fase de la API REST de ITSON del cron, con la API, el backend y las alertas
// simulados. Datos inventados.
const { test, describe } = require("node:test");
const assert = require("node:assert/strict");

const { ejecutarItsonApi, semestresPendientes, normalizarMaterias, hoyEnHermosillo, sumarDias } = require("../itson-api-fase");
const { arrancar } = require("../extraccion-cron");
const { armarPayload, entregarResultados } = require("../entrega-backend");
const { crearClientePerfilesItson } = require("../perfiles-itson-backend");
const { notificarFalloCritico } = require("../../monitors/alertas");
const { crearClienteItsonApi } = require("../../services/itsonApiClient");

const BASE = "https://webapi.itson.edu.mx";
const ENV = {
  BACKEND_URL: "http://backend.test",
  INTERNAL_API_KEY: "llave-de-prueba-".padEnd(40, "x"),
  ITSON_PROFILES_API_KEY: "llave-perfiles-prueba-".padEnd(40, "p"),
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
  let configPerfiles = null;
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
      crearClientePerfiles: ({ config }) => {
        configPerfiles = config;
        return {
          listarActivos: async () =>
            perfiles ?? { ok: true, alumnos: alumnos.map((a) => perfil(a.n, a.career)), descartados: 0 },
        };
      },
      entregar,
      alertar,
      pausa,
      hoy: () => HOY,
      log: (l) => lineas.push(l),
      logError: (l) => errores.push(l),
    });
  return { correr, lineas, errores, llamadas, alertar, entregar, pausa, getConfigPerfiles: () => configPerfiles };
}

const sinDatosPersonales = (texto, ns = [1, 2, 3]) => {
  for (const n of ns) {
    for (const d of [matricula(n), String(100000 + n), correo(n)]) assert.ok(!texto.includes(d), "apareció un dato del alumno");
  }
  for (const secreto of [ENV.INTERNAL_API_KEY, ENV.ITSON_PROFILES_API_KEY, BASE, "webapi.itson"]) {
    assert.ok(!texto.includes(secreto), `apareció un valor secreto: ${secreto}`);
  }
};

describe("flujo por alumno", () => {
  test("consulta 07 y 08 (no 0 ni 06 completo), lee perfiles con ITSON_PROFILES_API_KEY y entrega snapshots con INTERNAL_API_KEY", async (t) => {
    const s = simular(t);
    assert.equal(await s.correr(), 0);

    assert.equal(s.getConfigPerfiles().apiKey, ENV.ITSON_PROFILES_API_KEY);
    assert.deepEqual(s.llamadas.map((l) => l.slice(0, 1).concat(l.slice(2))), [
      ["inscrito"], ["progress"], ["grades", "07"], ["grades", "08"],
    ]);
    assert.equal(s.entregar.mock.callCount(), 2);
    const [resultado, opciones] = s.entregar.mock.calls[0].arguments;
    assert.equal(opciones.config.apiKey, ENV.INTERNAL_API_KEY);
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

  test("ventana por defecto: 7 días antes del inicio a 45 después del fin, inclusive", async (t) => {
    // HOY = 2026-11-13.
    const ins = (inicio, fin, inscrito = true) => ({ ok: true, inscrito, inicio, fin });
    const s = simular(t, {
      alumnos: [
        { n: 1, inscripcion: ins("2026-11-20", "2027-05-30") }, // 7 días antes del inicio: sí
        { n: 2, inscripcion: ins("2026-11-21", "2027-05-30") }, // 8 días antes: no
        { n: 3, inscripcion: ins("2026-01-10", "2026-09-29") }, // 45 días después del fin: sí
        { n: 4, inscripcion: ins("2026-01-10", "2026-09-28") }, // 46 días después: no
        { n: 5, inscripcion: ins("2026-08-10", "2026-12-12", false) }, // inscrito false dentro: sí
        { n: 6, inscripcion: { ok: true, inscrito: true, inicio: null, fin: "2026-12-12" } }, // ilegible: sí
      ],
    });
    assert.equal(await s.correr(), 0);
    assert.deepEqual(
      s.llamadas.filter((l) => l[0] === "progress").map((l) => l[1]),
      [matricula(1), matricula(3), matricula(5), matricula(6)],
    );
    assert.match(s.lineas.at(-1), /fuera_de_ventana=2 fechas_ilegibles=1/);
    assert.equal(s.alertar.mock.callCount(), 0); // fechas ilegibles no es una falla
  });

  test("ventana configurable con ITSON_API_VENTANA_ANTES_DIAS y ITSON_API_VENTANA_DESPUES_DIAS", async (t) => {
    const ins = (inicio, fin) => ({ ok: true, inscrito: true, inicio, fin });
    const s = simular(t, {
      env: { ...ENV, ITSON_API_VENTANA_ANTES_DIAS: "0", ITSON_API_VENTANA_DESPUES_DIAS: "60" },
      alumnos: [
        { n: 1, inscripcion: ins("2026-11-14", "2027-05-30") }, // empieza mañana: con 0 días antes, no
        { n: 2, inscripcion: ins("2026-01-10", "2026-09-14") }, // 60 días después del fin: sí
      ],
    });
    assert.equal(await s.correr(), 0);
    assert.deepEqual(s.llamadas.filter((l) => l[0] === "progress").map((l) => l[1]), [matricula(2)]);
  });

  test("ventana inválida: 1 y alerta de configuración que nombra la variable sin su valor", async (t) => {
    for (const valor of ["-1", "abc", "400"]) {
      const s = simular(t, { env: { ...ENV, ITSON_API_VENTANA_DESPUES_DIAS: valor } });
      assert.equal(await s.correr(), 1);
      assert.equal(s.alertar.mock.calls[0].arguments[0].tipo, "configuracion");
      assert.match(s.errores[0], /ITSON_API_VENTANA_DESPUES_DIAS debe ser un entero/);
      assert.ok(!s.errores[0].includes(valor));
      assert.equal(s.llamadas.length, 0);
    }
  });

  test("sumarDias cruza meses y años", () => {
    assert.equal(sumarDias("2026-12-12", 45), "2027-01-26");
    assert.equal(sumarDias("2026-03-01", -7), "2026-02-22");
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

  test("ITSON_PROFILES_API_KEY ausente, corta o igual a INTERNAL_API_KEY: 1, alerta de configuración y no consulta ni imprime el valor", async (t) => {
    for (const [valor, esperado] of [
      ["", /Falta ITSON_PROFILES_API_KEY/],
      ["   ", /Falta ITSON_PROFILES_API_KEY/],
      ["llave-corta-secreta", /ITSON_PROFILES_API_KEY debe tener al menos 32/],
      [ENV.INTERNAL_API_KEY, /ITSON_PROFILES_API_KEY debe ser distinta de INTERNAL_API_KEY/],
    ]) {
      const s = simular(t, { env: { ...ENV, ITSON_PROFILES_API_KEY: valor } });
      assert.equal(await s.correr(), 1);
      assert.equal(s.llamadas.length, 0);
      assert.equal(s.getConfigPerfiles(), null);
      assert.equal(s.alertar.mock.callCount(), 1);
      assert.equal(s.alertar.mock.calls[0].arguments[0].tipo, "configuracion");
      assert.match(s.errores[0], esperado);
      const texto = [...s.lineas, ...s.errores].join("\n") + JSON.stringify(s.alertar.mock.calls[0].arguments[0]);
      assert.ok(!texto.includes("llave-corta-secreta"));
      sinDatosPersonales(texto);
    }
  });

  test("URL inválida: 1 y alerta de configuración, sin citar la URL", async (t) => {
    const s = simular(t, { env: { ...ENV, ITSON_API_BASE_URL: "http://webapi.itson.edu.mx" } });
    assert.equal(await s.correr(), 1);
    assert.equal(s.alertar.mock.calls[0].arguments[0].tipo, "configuracion");
    sinDatosPersonales(s.errores.join("\n"));
  });

  test("host no autorizado, credenciales, puerto o punto final: 1, alerta de configuración y ninguna llamada", async (t) => {
    const casos = [
      "https://otro-host.example.test",
      "https://usuario-x:clave-secreta@webapi.itson.edu.mx",
      "https://webapi.itson.edu.mx:8443",
      "https://webapi.itson.edu.mx.",
    ];
    for (const valor of casos) {
      const s = simular(t, { env: { ...ENV, ITSON_API_BASE_URL: valor } });
      assert.equal(await s.correr(), 1);
      assert.equal(s.llamadas.length, 0);
      assert.equal(s.alertar.mock.callCount(), 1);
      assert.equal(s.alertar.mock.calls[0].arguments[0].tipo, "configuracion");
      const texto = [...s.lineas, ...s.errores].join("\n") + JSON.stringify(s.alertar.mock.calls[0].arguments[0]);
      for (const parte of ["otro-host", "usuario-x", "clave-secreta", "8443", "webapi"]) assert.ok(!texto.includes(parte), "se citó la URL");
      sinDatosPersonales(texto);
    }
  });

  test("mayúsculas en el host se aceptan", async (t) => {
    const s = simular(t, { env: { ...ENV, ITSON_API_BASE_URL: "https://WEBAPI.ITSON.EDU.MX" } });
    assert.equal(await s.correr(), 0);
    assert.ok(s.llamadas.length > 0);
  });

  test("una redirección en una llamada cuenta como falla de la API y alerta", async (t) => {
    const s = simular(t, { alumnos: [{ n: 1, progreso: { ok: false, motivo: "redireccion", status: 302 } }] });
    assert.equal(await s.correr(), 1);
    assert.match(s.errores.join("\n"), /getProgress fallida \(alumno 1\/1\): motivo=redireccion status=302/);
    assert.equal(s.alertar.mock.calls[0].arguments[0].conteos.fallas_api, 1);
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

  test("las dos en 0: 0; cualquiera en 1: 1", async (t) => {
    const base = { alertar: async () => {}, logError: () => {} };
    assert.equal(await arrancar({ ...base, correr: async () => 0, correrApi: async () => 0 }), 0);
    assert.equal(await arrancar({ ...base, correr: async () => 1, correrApi: async () => 0 }), 1);
    assert.equal(await arrancar({ ...base, correr: async () => 0, correrApi: async () => 1 }), 1);
  });
});

describe("piezas reales con fetch simulado", () => {
  // Cliente real de la API con fetch simulado; getProgress y getGrades responden bien.
  async function correrConInscripcion(t, cuerpoInscrito) {
    const salidas = [];
    const errores = [];
    const alertar = t.mock.fn(async () => {});
    const entregar = t.mock.fn(async () => ({ ok: true }));
    const respuestaApi = (url) => {
      const u = new URL(url);
      if (u.pathname.endsWith("getAlumnoInscrito")) return cuerpoInscrito;
      if (u.pathname.endsWith("getProgress")) return { response: { progress: [{ semesterKey: "07", approvedSubjects: 0, totalSubjects: 2 }] } };
      return { message: "OK", responseValue: [{ subject: { name: "Materia X", semester: null, idCatalog: "4601", program: CARRERA }, gradeValue: "-", studying: true }] };
    };
    const fetchApi = async (url) => ({ ok: true, status: 200, json: async () => respuestaApi(url), text: async () => "" });
    const codigo = await ejecutarItsonApi({
      env: ENV,
      crearClienteApi: ({ baseUrl }) => crearClienteItsonApi({ baseUrl, fetchFn: fetchApi, sleep: async () => {} }),
      crearClientePerfiles: () => ({ listarActivos: async () => ({ ok: true, alumnos: [perfil(1)], descartados: 0 }) }),
      entregar,
      alertar,
      pausa: async () => {},
      hoy: () => HOY,
      log: (l) => salidas.push(l),
      logError: (l) => errores.push(l),
    });
    return { codigo, salidas, errores, alertar, entregar };
  }

  test("getAlumnoInscrito con la forma real (arreglo de un objeto): sin inscripcion_fallida, 0 y sin alerta", async (t) => {
    const r = await correrConInscripcion(t, [
      { inscrito: true, fechaInicioSemestre: "2026-08-10T00:00:00", fechaFinSemestre: "2026-12-12T00:00:00" },
    ]);
    assert.equal(r.codigo, 0);
    assert.equal(r.alertar.mock.callCount(), 0);
    assert.deepEqual(r.errores, []);
    assert.equal(r.entregar.mock.callCount(), 1);
    assert.match(r.salidas.at(-1), /fuera_de_ventana=0 fechas_ilegibles=0 .*inscripcion_fallida=0 /);
  });

  test("getAlumnoInscrito vacío: fechas_ilegibles registrado con info, consulta igual, 0 y sin alerta", async (t) => {
    const r = await correrConInscripcion(t, { message: "Sin datos", responseValue: null });
    assert.equal(r.codigo, 0);
    assert.equal(r.alertar.mock.callCount(), 0);
    assert.deepEqual(r.errores, []);
    assert.equal(r.entregar.mock.callCount(), 1);
    assert.ok(r.salidas.some((l) => /Fechas del semestre ilegibles \(alumno 1\/1\)/.test(l)));
    assert.match(r.salidas.at(-1), /fechas_ilegibles=1 .*inscripcion_fallida=0 /);
  });

  test("getAlumnoInscrito con dos objetos: forma_invalida cuenta en inscripcion_fallida y alerta", async (t) => {
    const uno = { inscrito: true, fechaInicioSemestre: "2026-08-10T00:00:00", fechaFinSemestre: "2026-12-12T00:00:00" };
    const r = await correrConInscripcion(t, [uno, uno]);
    assert.equal(r.codigo, 1);
    assert.equal(r.alertar.mock.callCount(), 1);
    assert.equal(r.alertar.mock.calls[0].arguments[0].conteos.inscripcion_fallida, 1);
    assert.ok(r.errores.some((l) => /getAlumnoInscrito fallida \(alumno 1\/1\): motivo=forma_invalida/.test(l)));
  });

  test("de punta a punta: ninguna línea ni alerta contiene matrícula, carrera, correo, llaves ni URL", async () => {
    const salidas = [];
    const alertas = [];
    const cuerpos = [];
    const headersBackend = [];
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
      headersBackend.push({ url, apiKey: init.headers["x-api-key"] });
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
    assert.deepEqual(headersBackend, [
      { url: "http://backend.test/internal/itson-profiles/active", apiKey: ENV.ITSON_PROFILES_API_KEY },
    ]);
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

  test("normalizarMaterias: gradeValue 'A' llega literal al payload (significado sin confirmar)", () => {
    const [curso] = normalizarMaterias([materia("4601", " A ")], CARRERA);
    assert.deepEqual(curso.items[0], { externalItemId: "4601", label: "Calificación final", value: null, text: "A" });
  });

  test("normalizarMaterias: idCatalog repetido descarta la respuesta", () => {
    assert.equal(normalizarMaterias([materia("1"), materia("1")], CARRERA), null);
  });

  test("hoyEnHermosillo usa la fecha local (UTC-7)", () => {
    assert.equal(hoyEnHermosillo(new Date("2026-11-14T05:00:00Z")), "2026-11-13");
  });
});
