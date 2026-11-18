// ITN-60 - Fase del calendario del cron con el portal, el backend y las alertas
// simulados. Datos inventados; sin red.
const { test, describe } = require("node:test");
const assert = require("node:assert/strict");

const { ejecutarCalendario, entregarCalendario, leerHoras, RUTA } = require("../calendario-fase");
const { arrancar } = require("../extraccion-cron");

const ENV = { BACKEND_URL: "http://backend.test", INTERNAL_API_KEY: "llave-de-prueba-".padEnd(40, "x") };
const EVENTO = {
  externalId: "137", title: "Evento de prueba", description: null,
  startsAt: "2026-12-05T00:00:00-07:00", endsAt: "2026-12-05T23:59:59-07:00", allDay: true, category: null,
};

function correr(t, { lectura = { ok: true, eventos: [EVENTO], descartados: 0, fallidos: 0 }, envio, env = ENV, hora = 7, forzar } = {}) {
  const logs = [];
  const errores = [];
  const obtenerEventos = t.mock.fn(async () => {
    if (lectura instanceof Error) throw lectura;
    return lectura;
  });
  const entregar = t.mock.fn(async () => envio ?? { ok: true, resultado: { inserted: 1, updated: 0, unchanged: 0 } });
  const promesa = ejecutarCalendario({
    env,
    forzar,
    hora: () => hora,
    crearCliente: () => ({ obtenerEventos }),
    entregar,
    log: (l) => logs.push(l),
    logError: (l) => errores.push(l),
  });
  return { promesa, logs, errores, obtenerEventos, entregar };
}

describe("ITN-60 - fase del calendario", () => {
  test("lee y entrega; siempre sale con 0", async (t) => {
    const s = correr(t);
    assert.equal(await s.promesa, 0);
    assert.equal(s.entregar.mock.callCount(), 1);
    assert.deepEqual(s.entregar.mock.calls[0].arguments[0], [EVENTO]);
    assert.match(s.logs.at(-1), /leidos=1 nuevos=1 actualizados=0 sin_cambios=0/);
    assert.deepEqual(s.errores, []);
  });

  for (const [nombre, opciones] of [
    ["portal caído (timeout)", { lectura: { ok: false, motivo: "timeout", status: null } }],
    ["portal con 5xx", { lectura: { ok: false, motivo: "http", status: 503 } }],
    ["portal con 4xx", { lectura: { ok: false, motivo: "http", status: 404 } }],
    ["backend falla", { envio: { ok: false, status: 500 } }],
    ["excepción inesperada", { lectura: new TypeError("mensaje con https://secreto") }],
    ["configuración incompleta", { env: { BACKEND_URL: "http://backend.test" } }],
  ]) {
    test(`${nombre}: se registra en el log y sale con 0`, async (t) => {
      const s = correr(t, opciones);
      assert.equal(await s.promesa, 0);
      assert.equal(s.errores.length, 1);
      assert.ok(!s.errores[0].includes("secreto"));
      assert.ok(!s.errores[0].includes(ENV.INTERNAL_API_KEY));
    });
  }

  test("fuera de las horas programadas no consulta el portal", async (t) => {
    const s = correr(t, { hora: 9 });
    assert.equal(await s.promesa, 0);
    assert.equal(s.obtenerEventos.mock.callCount(), 0);
  });

  test("forzar (npm run sync:calendar) corre a cualquier hora", async (t) => {
    const s = correr(t, { hora: 9, forzar: true });
    assert.equal(await s.promesa, 0);
    assert.equal(s.obtenerEventos.mock.callCount(), 1);
  });

  test("RPA_PAUSADO no consulta nada", async (t) => {
    const s = correr(t, { env: { ...ENV, RPA_PAUSADO: "true" } });
    assert.equal(await s.promesa, 0);
    assert.equal(s.obtenerEventos.mock.callCount(), 0);
  });

  test("sin eventos válidos no envía", async (t) => {
    const s = correr(t, { lectura: { ok: true, eventos: [], descartados: 2, fallidos: 1 } });
    assert.equal(await s.promesa, 0);
    assert.equal(s.entregar.mock.callCount(), 0);
  });

  test("leerHoras", () => {
    assert.deepEqual(leerHoras(undefined), [7, 13, 19]);
    assert.equal(leerHoras("*"), null);
    assert.deepEqual(leerHoras("6, 18"), [6, 18]);
    assert.equal(leerHoras("25"), undefined);
    assert.equal(leerHoras("siete"), undefined);
  });
});

describe("ITN-60 - entrega al backend", () => {
  const respuesta = (status, cuerpo = {}) => ({ ok: status < 300, status, json: async () => cuerpo });
  const config = { backendUrl: ENV.BACKEND_URL, apiKey: ENV.INTERNAL_API_KEY };

  test("POST con x-api-key y el lote completo", async (t) => {
    const fetchFn = t.mock.fn(async () => respuesta(200, { inserted: 1 }));
    const r = await entregarCalendario([EVENTO], { config, fetchFn, sleep: async () => {} });
    assert.deepEqual(r, { ok: true, resultado: { inserted: 1 } });
    const [url, opciones] = fetchFn.mock.calls[0].arguments;
    assert.equal(url, `${ENV.BACKEND_URL}${RUTA}`);
    assert.equal(opciones.method, "POST");
    assert.equal(opciones.headers["x-api-key"], ENV.INTERNAL_API_KEY);
    assert.deepEqual(JSON.parse(opciones.body), { events: [EVENTO] });
  });

  test("reintenta 5xx y red; no reintenta 4xx", async (t) => {
    const cola = [respuesta(502), Object.assign(new TypeError("x"), {}), respuesta(200, {})];
    const fetchFn = t.mock.fn(async () => {
      const r = cola.shift();
      if (r instanceof Error) throw r;
      return r;
    });
    assert.equal((await entregarCalendario([EVENTO], { config, fetchFn, sleep: async () => {} })).ok, true);
    assert.equal(fetchFn.mock.callCount(), 3);

    const f400 = t.mock.fn(async () => respuesta(400));
    assert.deepEqual(await entregarCalendario([EVENTO], { config, fetchFn: f400, sleep: async () => {} }), { ok: false, status: 400 });
    assert.equal(f400.mock.callCount(), 1);
  });
});

describe("ITN-60 - el calendario no cambia el código de salida ni alerta", () => {
  test("una excepción en la fase del calendario no alerta y no cambia el 0", async (t) => {
    const alertar = t.mock.fn(async () => {});
    const errores = [];
    const codigo = await arrancar({
      correr: async () => 0,
      correrApi: async () => 0,
      correrCalendario: async () => {
        throw new RangeError("mensaje-libre");
      },
      alertar,
      logError: (l) => errores.push(l),
    });
    assert.equal(codigo, 0);
    assert.equal(alertar.mock.callCount(), 0);
    assert.deepEqual(errores, ["Error en la fase del calendario: RangeError. Se sigue."]);
  });

  test("corre después de las otras dos y aunque una salga con 1", async (t) => {
    const orden = [];
    const codigo = await arrancar({
      correr: async () => { orden.push("ivirtual"); return 1; },
      correrApi: async () => { orden.push("api"); return 0; },
      correrCalendario: async () => { orden.push("calendario"); return 0; },
      alertar: async () => {},
      logError: () => {},
    });
    assert.equal(codigo, 1);
    assert.deepEqual(orden, ["ivirtual", "api", "calendario"]);
  });
});
