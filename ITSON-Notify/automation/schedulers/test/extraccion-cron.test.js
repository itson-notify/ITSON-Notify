// Pruebas del punto de entrada del cron con extract/alertar/entregar simulados.
// Credenciales inventadas.
const { test, describe } = require("node:test");
const assert = require("node:assert/strict");

const { ejecutar } = require("../extraccion-cron");
const { entregarResultados } = require("../entrega-backend");
const { notificarFalloCritico } = require("../../monitors/alertas");
const { sendTeamAlert } = require("../../monitors/telegram");

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

  test("falla pasajera: sale con 1 sin alertar", async (t) => {
    const s = simular(t, { status: "error", courses: [], error: "HTTP 503" });

    assert.equal(await s.correr(), 1);
    assert.equal(s.alertar.mock.callCount(), 0);
  });

  test("RPA_PAUSADO=true no consulta iVirtual", async (t) => {
    const s = simular(t, { status: "ok", courses: [] }, { ...ENV, RPA_PAUSADO: "true" });

    assert.equal(await s.correr(), 0);
    assert.equal(s.extract.mock.callCount(), 0);
  });

  test("sin credenciales sale con 1 sin consultar", async (t) => {
    const s = simular(t, { status: "ok", courses: [] }, {});

    assert.equal(await s.correr(), 1);
    assert.equal(s.extract.mock.callCount(), 0);
  });

  test("los logs no incluyen usuario ni contraseña", async (t) => {
    const s = simular(t, { status: "cambio_password", courses: [] });
    await s.correr();

    const todo = [...s.lineas, ...s.errores].join("\n") + JSON.stringify(s.alertar.mock.calls);
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

    await ejecutar({ env: {} });
    assert.equal(stdout.mock.callCount(), 1);
    assert.equal(stderr.mock.callCount(), 1);
  });
});
