// Pruebas del punto de entrada del cron con extract/alertar/entregar simulados.
// Credenciales inventadas.
const { test, describe } = require("node:test");
const assert = require("node:assert/strict");

const { ejecutar, arrancar } = require("../extraccion-cron");
const { entregarResultados } = require("../entrega-backend");
const { notificarFalloCritico } = require("../../monitors/alertas");
const { sendTeamAlert, validarMensaje } = require("../../monitors/telegram");

const ENV = {
  Id_User: "00000000000",
  P_User: "pass-de-prueba",
  BACKEND_URL: "http://backend.test",
  INTERNAL_API_KEY: "llave-de-prueba-".padEnd(40, "x"),
  ALUMNO_EMAIL: "alumno@example.test",
};
const CURSOS = [{ items: [{}, {}] }, { items: [{}] }];

function simular(t, resultado, env = ENV, envio = { ok: true }) {
  const lineas = [];
  const errores = [];
  const extract = t.mock.fn(async () => resultado);
  const alertar = t.mock.fn(async () => {});
  const entregar = t.mock.fn(async () => envio);
  const log = (linea) => lineas.push(linea);
  const logError = (linea) => errores.push(linea);
  const correr = (extra = {}) =>
    ejecutar({ env, extract, alertar, entregar, log, logError, ...extra });
  return { correr, extract, alertar, entregar, lineas, errores };
}

describe("cron de extracción", () => {
  test("éxito: entrega el resultado y sale con 0", async (t) => {
    const s = simular(t, { status: "ok", courses: CURSOS });

    assert.equal(await s.correr(), 0);
    assert.equal(s.entregar.mock.callCount(), 1);
    assert.equal(s.alertar.mock.callCount(), 0);
    assert.ok(s.lineas.some((l) => l.includes("2 curso(s), 3 ítem(s)")));
    const [, opciones] = s.entregar.mock.calls[0].arguments;
    assert.equal(opciones.config.endpoint, "http://backend.test/internal/grade-snapshots");
    assert.ok(!Number.isNaN(Date.parse(opciones.capturedAt)));
  });

  test("entrega fallida tras los reintentos: sale con 1", async (t) => {
    const s = simular(t, { status: "ok", courses: CURSOS }, ENV, { ok: false, status: 503 });

    assert.equal(await s.correr(), 1);
    assert.equal(s.entregar.mock.callCount(), 1);
  });

  test("sin variables del backend sale con 1 sin consultar ni imprimir valores", async (t) => {
    const { BACKEND_URL, ALUMNO_EMAIL, ...resto } = ENV;
    const s = simular(t, { status: "ok", courses: CURSOS }, resto);

    assert.equal(await s.correr(), 1);
    assert.equal(s.extract.mock.callCount(), 0);
    const todo = s.errores.join("\n");
    assert.match(todo, /BACKEND_URL, ALUMNO_EMAIL/);
    assert.ok(!todo.includes(ENV.INTERNAL_API_KEY));
  });

  test("cambio de contraseña: alerta una vez y sale con 2", async (t) => {
    const s = simular(t, { status: "cambio_password", courses: [] });

    assert.equal(await s.correr(), 2);
    assert.equal(s.extract.mock.callCount(), 1, "no reintenta");
    assert.equal(s.alertar.mock.callCount(), 1);
    const [evento] = s.alertar.mock.calls[0].arguments;
    assert.equal(evento.tipo, "cambio_password");
    assert.equal(s.entregar.mock.callCount(), 0);
  });

  test("credenciales incorrectas: alerta y sale con 1", async (t) => {
    const s = simular(t, { status: "credenciales", courses: [] });

    assert.equal(await s.correr(), 1);
    assert.equal(s.alertar.mock.callCount(), 1);
    assert.equal(s.alertar.mock.calls[0].arguments[0].tipo, "credenciales");
  });

  test("falla pasajera: alerta con tipo error y errorcode, y sale con 1", async (t) => {
    const s = simular(t, {
      status: "error",
      courses: [],
      error: "core_course: Token inválido",
      errorcode: "invalidtoken",
    });

    assert.equal(await s.correr(), 1);
    assert.equal(s.alertar.mock.callCount(), 1);
    const [evento] = s.alertar.mock.calls[0].arguments;
    assert.equal(evento.tipo, "error");
    assert.equal(evento.errorcode, "invalidtoken");
    assert.ok(!("error" in evento), "el texto libre no viaja en el evento");
  });

  test("falla pasajera sin errorcode: alerta y sale con 1", async (t) => {
    const s = simular(t, { status: "error", courses: [], error: "HTTP 503", errorcode: null });

    assert.equal(await s.correr(), 1);
    assert.equal(s.alertar.mock.callCount(), 1);
    assert.equal(s.alertar.mock.calls[0].arguments[0].errorcode, null);
  });

  test("RPA_PAUSADO=true no consulta iVirtual ni alerta", async (t) => {
    const s = simular(t, { status: "ok", courses: [] }, { ...ENV, RPA_PAUSADO: "true" });

    assert.equal(await s.correr(), 0);
    assert.equal(s.extract.mock.callCount(), 0);
    assert.equal(s.alertar.mock.callCount(), 0);
  });

  test("sin credenciales alerta configuración y sale con 1 sin consultar", async (t) => {
    const s = simular(t, { status: "ok", courses: [] }, {});

    assert.equal(await s.correr(), 1);
    assert.equal(s.extract.mock.callCount(), 0);
    assert.equal(s.alertar.mock.callCount(), 1);
    assert.equal(s.alertar.mock.calls[0].arguments[0].tipo, "configuracion");
  });

  test("variable de entrega inválida: alerta configuración sin valores", async (t) => {
    const s = simular(t, { status: "ok", courses: [] }, { ...ENV, INTERNAL_API_KEY: "corta" });

    assert.equal(await s.correr(), 1);
    assert.equal(s.extract.mock.callCount(), 0);
    assert.equal(s.alertar.mock.callCount(), 1);
    assert.deepEqual(Object.keys(s.alertar.mock.calls[0].arguments[0]).sort(), [
      "fecha",
      "fuente",
      "tipo",
    ]);
  });

  test("pasa el env de la corrida a la alerta", async (t) => {
    const s = simular(t, { status: "credenciales", courses: [] });

    await s.correr();

    assert.equal(s.alertar.mock.calls[0].arguments[1].env, ENV);
  });

  test("entrega fallida: no genera una segunda alerta", async (t) => {
    const s = simular(t, { status: "ok", courses: CURSOS }, ENV, { ok: false, status: 503 });

    assert.equal(await s.correr(), 1);
    assert.equal(s.alertar.mock.callCount(), 0);
  });

  const SALIDAS_CON_ALERTA = [
    ["cambio_password", { status: "cambio_password", courses: [] }, ENV, 2],
    ["credenciales", { status: "credenciales", courses: [] }, ENV, 1],
    ["error", { status: "error", courses: [], error: "HTTP 503" }, ENV, 1],
    ["configuración", { status: "ok", courses: [] }, {}, 1],
  ];
  for (const [nombre, resultado, env, codigo] of SALIDAS_CON_ALERTA) {
    test(`${nombre}: espera a la alerta antes de terminar`, async (t) => {
      const s = simular(t, resultado, env);
      let termino = false;
      const alertar = async () => {
        await new Promise((resolve) => setImmediate(resolve));
        termino = true;
      };

      assert.equal(await s.correr({ alertar }), codigo);
      assert.ok(termino);
    });
  }

  test("alerta rechazada o sin Telegram: conserva el código de salida", async (t) => {
    const s = simular(t, { status: "cambio_password", courses: [] });

    assert.equal(await s.correr({ alertar: notificarFalloCritico }), 2);
  });

  test("los logs no incluyen usuario ni contraseña", async (t) => {
    const s = simular(t, { status: "cambio_password", courses: [] });
    await s.correr();

    // Solo el evento: las opciones llevan el env, que se usa pero no se imprime.
    const eventos = s.alertar.mock.calls.map((c) => c.arguments[0]);
    const todo = [...s.lineas, ...s.errores].join("\n") + JSON.stringify(eventos);
    assert.ok(!todo.includes(ENV.Id_User));
    assert.ok(!todo.includes(ENV.P_User));
  });
});

// Railway marca como error todo lo que sale por stderr.
describe("canales de log del cron", () => {
  const RESPUESTA_OK = {
    ok: true,
    status: 200,
    json: async () => ({ baseline: false, changes_detected: 0 }),
  };

  function entregaReal(respuesta) {
    return (result, opciones) =>
      entregarResultados(result, {
        ...opciones,
        fetchFn: async () => respuesta,
        // Telegram sin configurar: no sale a la red y deja su falla en opciones.log.
        alertarEquipo: (texto, { log }) => sendTeamAlert(texto, { env: {}, log }),
        sleep: async () => {},
        maxReintentos: 0,
      });
  }

  test("éxito completo: todo por stdout, nada por stderr", async (t) => {
    const s = simular(t, { status: "ok", courses: CURSOS });

    assert.equal(await s.correr({ entregar: entregaReal(RESPUESTA_OK) }), 0);

    assert.deepEqual(s.errores, []);
    assert.match(s.lineas[0], /^Consultando iVirtual/);
    assert.match(s.lineas[1], /^Extracción correcta: 2 curso\(s\), 3 ítem\(s\)\.$/);
    assert.match(s.lineas[2], /^Entrega al backend correcta: run_id=/);
  });

  test("extracción sin cursos: el aviso va por stdout", async (t) => {
    const s = simular(t, { status: "ok", courses: [] });

    assert.equal(await s.correr({ entregar: entregaReal(RESPUESTA_OK) }), 0);

    assert.deepEqual(s.errores, []);
    assert.ok(s.lineas.includes("Extracción sin cursos: no se envía al backend."));
  });

  test("RPA_PAUSADO: el aviso va por stdout", async (t) => {
    const s = simular(t, { status: "ok", courses: [] }, { ...ENV, RPA_PAUSADO: "true" });

    await s.correr();

    assert.deepEqual(s.errores, []);
    assert.equal(s.lineas.length, 1);
    assert.match(s.lineas[0], /^RPA pausado/);
  });

  test("configuración incompleta: las fallas van por stderr", async (t) => {
    const sinCredenciales = simular(t, { status: "ok", courses: [] }, {});
    await sinCredenciales.correr();
    assert.deepEqual(sinCredenciales.lineas, []);
    assert.match(sinCredenciales.errores[0], /^Faltan Id_User o P_User/);

    const { BACKEND_URL, ...sinBackend } = ENV;
    const s = simular(t, { status: "ok", courses: [] }, sinBackend);
    await s.correr();
    assert.deepEqual(s.lineas, []);
    assert.match(s.errores[0], /BACKEND_URL/);
  });

  test("fallo crítico: Extracción detenida y ALERTA_RPA van por stderr", async (t) => {
    const s = simular(t, { status: "credenciales", courses: [] });

    assert.equal(await s.correr({ alertar: notificarFalloCritico }), 1);

    assert.deepEqual(s.lineas, ["Consultando iVirtual (API de Moodle)..."]);
    assert.match(s.errores[0], /^Extracción detenida: credenciales\./);
    assert.match(s.errores[1], /^ALERTA_RPA /);
  });

  test("falla pasajera: Extracción fallida va por stderr", async (t) => {
    const s = simular(t, { status: "error", courses: [], error: "HTTP 503" });

    await s.correr();

    assert.deepEqual(s.errores, ["Extracción fallida: HTTP 503"]);
  });

  test("entrega fallida: la falla y el aviso de Telegram van por stderr", async (t) => {
    const s = simular(t, { status: "ok", courses: CURSOS });
    const respuesta = { ok: false, status: 500, json: async () => ({}) };

    assert.equal(await s.correr({ entregar: entregaReal(respuesta) }), 1);

    assert.ok(s.lineas.every((l) => !l.includes("fallida") && !l.includes("Telegram")));
    assert.match(s.errores[0], /^Entrega al backend fallida: run_id=.* status=500 intento=1$/);
    assert.match(s.errores[1], /^Alerta de Telegram no enviada/);
  });

  test("por defecto log es console.log y logError es console.error", async (t) => {
    const stdout = t.mock.method(console, "log", () => {});
    const stderr = t.mock.method(console, "error", () => {});

    await ejecutar({ env: { RPA_PAUSADO: "true" } });
    assert.equal(stdout.mock.callCount(), 1);
    assert.equal(stderr.mock.callCount(), 0);

    // env vacío: la alerta real tampoco encuentra Telegram y no sale a la red.
    await ejecutar({ env: {} });
    assert.equal(stdout.mock.callCount(), 1);
    assert.match(stderr.mock.calls[0].arguments[0], /^Faltan Id_User o P_User/);
    assert.match(stderr.mock.calls[1].arguments[0], /^ALERTA_RPA /);
    assert.match(stderr.mock.calls[2].arguments[0], /^Alerta de Telegram no enviada/);
  });
});

describe("excepción no controlada al arrancar", () => {
  function simularArranque(t, error) {
    const errores = [];
    const alertar = t.mock.fn(async () => {});
    const correr = async () => {
      throw error;
    };
    const arrancarCron = () => arrancar({ correr, alertar, logError: (l) => errores.push(l) });
    return { arrancarCron, alertar, errores };
  }

  test("alerta solo con el nombre del error y sale con 1", async (t) => {
    const s = simularArranque(t, new TypeError("mensaje-libre-fuga"));

    assert.equal(await s.arrancarCron(), 1);
    assert.equal(s.alertar.mock.callCount(), 1);
    const [evento] = s.alertar.mock.calls[0].arguments;
    assert.equal(evento.tipo, "excepcion");
    assert.equal(evento.nombre_error, "TypeError");
    assert.deepEqual(s.errores, ["Error durante la extracción programada: TypeError"]);
    assert.ok(!JSON.stringify(s.alertar.mock.calls[0].arguments[0]).includes("mensaje-libre-fuga"));
  });

  for (const lanzado of [null, undefined, "cadena", { name: "usuario-fuga" }]) {
    test(`lanzar ${JSON.stringify(lanzado)}: usa un nombre genérico`, async (t) => {
      const s = simularArranque(t, lanzado);

      assert.equal(await s.arrancarCron(), 1);
      assert.equal(s.alertar.mock.calls[0].arguments[0].nombre_error, "Error");
      assert.ok(!s.errores.join("\n").includes("usuario-fuga"));
    });
  }

  test("espera a la alerta antes de terminar", async (t) => {
    let termino = false;
    const codigo = await arrancar({
      correr: async () => {
        throw new Error("x");
      },
      alertar: async () => {
        await new Promise((resolve) => setImmediate(resolve));
        termino = true;
      },
      logError: () => {},
    });

    assert.equal(codigo, 1);
    assert.ok(termino);
  });

  test("corrida sin excepción: devuelve su código y no alerta", async (t) => {
    const alertar = t.mock.fn(async () => {});

    assert.equal(await arrancar({ correr: async () => 2, alertar, logError: () => {} }), 2);
    assert.equal(alertar.mock.callCount(), 0);
  });
});

// Recorre las rutas con alerta usando el armado real de alertas.js y
// sendTeamAlert con fetch simulado: compara contra lo que iría a Telegram y a
// los logs. Los valores son reconocibles para que una fuga salte a la vista.
describe("privacidad de mensajes y logs (ITN-39)", () => {
  const SECRETOS = {
    Id_User: "MATRICULA-RECONOCIBLE",
    P_User: "PASSWORD-RECONOCIBLE",
    INTERNAL_API_KEY: "LLAVE-INTERNA-RECONOCIBLE-".padEnd(40, "z"),
    ALUMNO_EMAIL: "correo.reconocible@example.test",
    TELEGRAM_BOT_TOKEN: "123456789:TOKENRECONOCIBLETOKENRECONOCIBLE12",
  };
  const ENV_COMPLETO = {
    ...SECRETOS,
    BACKEND_URL: "http://backend.test",
    TELEGRAM_CHAT_ID: "-100123",
  };
  const TODOS = Object.values(SECRETOS).join(" | ");

  function instrumentar() {
    const salidas = [];
    const textos = [];
    const log = (linea) => salidas.push(linea);
    // Telegram contesta 500 para pasar también por el log de falla de telegram.js.
    const fetchFn = async (_url, opciones) => {
      textos.push(JSON.parse(opciones.body).text);
      return { ok: false, status: 500, json: async () => ({ description: "Internal" }) };
    };
    const enviar = (texto, opciones) => sendTeamAlert(texto, { ...opciones, fetchFn });
    const alertar = (evento, opciones) => notificarFalloCritico(evento, { ...opciones, enviar });
    const revisar = (minimoTextos = 1) => {
      assert.ok(textos.length >= minimoTextos, "se esperaba un mensaje a Telegram");
      const todo = [...salidas, ...textos].join("\n");
      for (const [nombre, valor] of Object.entries(SECRETOS)) {
        assert.ok(!todo.includes(valor), `se filtró el valor de ${nombre}`);
      }
      for (const texto of textos) assert.equal(validarMensaje(texto), null);
    };
    return { log, alertar, enviar, fetchFn, salidas, textos, revisar };
  }

  const correrCon = (m, env, resultado, extra = {}) =>
    ejecutar({
      env,
      extract: async () => resultado,
      alertar: m.alertar,
      log: m.log,
      logError: m.log,
      ...extra,
    });

  for (const status of ["cambio_password", "credenciales"]) {
    test(`fallo crítico ${status}`, async () => {
      const m = instrumentar();
      await correrCon(m, ENV_COMPLETO, { status, courses: [], usuario: TODOS, error: TODOS });
      m.revisar();
    });
  }

  test("falla pasajera con los valores en el texto del error", async () => {
    const m = instrumentar();

    assert.equal(
      await correrCon(m, ENV_COMPLETO, {
        status: "error",
        courses: [],
        error: `HTTP 503 ${TODOS}`,
        errorcode: "invalidtoken",
      }),
      1,
    );

    m.revisar();
    assert.ok(m.salidas.some((l) => l.startsWith("Extracción fallida: HTTP 503")));
    assert.ok(m.textos[0].includes("invalidtoken"));
  });

  test("errorcode con un valor secreto: no se manda", async () => {
    const m = instrumentar();
    await correrCon(m, ENV_COMPLETO, {
      status: "error",
      courses: [],
      error: "x",
      errorcode: SECRETOS.P_User,
    });
    m.revisar();
  });

  test("configuración incompleta", async () => {
    const m = instrumentar();
    const { ALUMNO_EMAIL, ...sinCorreo } = ENV_COMPLETO;
    await correrCon(m, sinCorreo, { status: "ok", courses: [] });
    m.revisar();
  });

  test("configuración inválida", async () => {
    const m = instrumentar();
    await correrCon(m, { ...ENV_COMPLETO, ALUMNO_EMAIL: "no-es-correo" }, { status: "ok", courses: [] });
    assert.ok(!m.textos.join("\n").includes("no-es-correo"));
    m.revisar();
  });

  test("excepción no controlada con los valores en el mensaje", async () => {
    const m = instrumentar();
    const correr = async () => {
      throw new RangeError(TODOS);
    };

    // arrancar usa process.env en producción; aquí se fija el env de la prueba.
    const alertar = (evento, opciones) => m.alertar(evento, { ...opciones, env: ENV_COMPLETO });

    assert.equal(await arrancar({ correr, alertar, logError: m.log }), 1);

    m.revisar();
    assert.ok(m.textos[0].includes("RangeError"));
  });

  test("entrega fallida: una sola alerta y sin valores", async () => {
    const m = instrumentar();
    const respuesta = { ok: false, status: 500, json: async () => ({}) };
    const entregar = (result, opciones) =>
      entregarResultados(result, {
        ...opciones,
        fetchFn: async () => respuesta,
        alertarEquipo: (texto, { log }) => m.enviar(texto, { env: ENV_COMPLETO, log }),
        sleep: async () => {},
        maxReintentos: 0,
      });

    assert.equal(
      await correrCon(m, ENV_COMPLETO, { status: "ok", courses: CURSOS }, { entregar }),
      1,
    );

    m.revisar();
    assert.equal(m.textos.length, 1);
    assert.ok(m.salidas.every((l) => !l.startsWith("ALERTA_RPA")));
  });
});
