// Pruebas del punto de entrada del cron con extract/alertar/entregar simulados.
// Credenciales inventadas.
const { test, describe } = require("node:test");
const assert = require("node:assert/strict");

const { ejecutar } = require("../extraccion-cron");

const ENV = { Id_User: "00000000000", P_User: "pass-de-prueba" };
const CURSOS = [{ items: [{}, {}] }, { items: [{}] }];

function simular(t, resultado, env = ENV) {
  const lineas = [];
  const extract = t.mock.fn(async () => resultado);
  const alertar = t.mock.fn(async () => {});
  const entregar = t.mock.fn(async () => {});
  const log = (linea) => lineas.push(linea);
  const correr = () => ejecutar({ env, extract, alertar, entregar, log });
  return { correr, extract, alertar, entregar, lineas };
}

describe("cron de extracción", () => {
  test("éxito: entrega el resultado y sale con 0", async (t) => {
    const s = simular(t, { status: "ok", courses: CURSOS });

    assert.equal(await s.correr(), 0);
    assert.equal(s.entregar.mock.callCount(), 1);
    assert.equal(s.alertar.mock.callCount(), 0);
    assert.ok(s.lineas.some((l) => l.includes("2 curso(s), 3 ítem(s)")));
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

    const todo = s.lineas.join("\n") + JSON.stringify(s.alertar.mock.calls);
    assert.ok(!todo.includes(ENV.Id_User));
    assert.ok(!todo.includes(ENV.P_User));
  });
});
