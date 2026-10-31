// Pruebas de la entrega al backend con fetch simulado. Datos inventados.
const { test, describe } = require("node:test");
const assert = require("node:assert/strict");

const { entregarResultados, leerConfigEntrega } = require("../entrega-backend");

const API_KEY = "llave-de-prueba-".padEnd(40, "x");
const EMAIL = "alumno@example.test";
const ENV = {
  BACKEND_URL: "http://backend.test/",
  INTERNAL_API_KEY: API_KEY,
  ALUMNO_EMAIL: EMAIL,
};
const CONFIG = leerConfigEntrega(ENV).config;
const RUN_ID = "2f0c3a8e-6d1b-4c55-9b0e-0d8d6a1f7c42";
const CAPTURED_AT = "2026-10-30T21:00:00.000Z";
const RESULTADO = {
  status: "ok",
  courses: [
    {
      externalId: "501",
      subject: "Materia de prueba A",
      items: [{ externalItemId: "9001", label: "Tarea 1", value: 85.5, text: "85.50" }],
    },
  ],
};
const RESPUESTA_200 = {
  snapshot_id: RUN_ID,
  snapshot_created: true,
  courses: 1,
  items: 1,
  baseline: false,
  reason: null,
  changes_detected: 2,
  changes_inserted: 2,
};

const respuesta = (status, body = {}) => ({
  ok: status >= 200 && status < 300,
  status,
  json: async () => body,
});

// fetchFn recibe una lista de respuestas (o funciones) que devuelve en orden.
function simular(t, pasos, extra = {}) {
  const lineas = [];
  let i = 0;
  const fetchFn = t.mock.fn(async (url, init) => {
    const paso = pasos[Math.min(i++, pasos.length - 1)];
    return typeof paso === "function" ? paso(url, init) : paso;
  });
  const alertarEquipo = t.mock.fn(async () => ({ ok: true }));
  const sleep = t.mock.fn(async () => {});
  const correr = (resultado = RESULTADO) =>
    entregarResultados(resultado, {
      config: CONFIG,
      capturedAt: CAPTURED_AT,
      log: (l) => lineas.push(l),
      fetchFn,
      alertarEquipo,
      randomUUID: () => RUN_ID,
      sleep,
      ...extra,
    });
  return { correr, fetchFn, alertarEquipo, sleep, lineas };
}

const bodyEnviado = (s, n = 0) => JSON.parse(s.fetchFn.mock.calls[n].arguments[1].body);

function sinDatosSensibles(s) {
  const todo = s.lineas.join("\n") + JSON.stringify(s.alertarEquipo.mock.calls);
  for (const prohibido of [API_KEY, EMAIL, "Materia de prueba A", "85.5", "backend.test"]) {
    assert.ok(!todo.includes(prohibido), `no debe aparecer: ${prohibido}`);
  }
}

describe("leerConfigEntrega", () => {
  test("arma el endpoint sin doble diagonal", () => {
    assert.equal(CONFIG.endpoint, "http://backend.test/internal/grade-snapshots");
  });

  test("variables faltantes: las nombra sin imprimir valores", () => {
    const r = leerConfigEntrega({ INTERNAL_API_KEY: API_KEY, ALUMNO_EMAIL: "  " });
    assert.equal(r.ok, false);
    assert.equal(r.error, "Faltan variables del servicio: BACKEND_URL, ALUMNO_EMAIL.");
    assert.ok(!r.error.includes(API_KEY));
  });

  test("valores inválidos no se repiten en el error", () => {
    for (const [env, esperado] of [
      [{ ...ENV, BACKEND_URL: "no-es-url" }, /BACKEND_URL/],
      [{ ...ENV, BACKEND_URL: "ftp://backend.test" }, /BACKEND_URL/],
      [{ ...ENV, INTERNAL_API_KEY: "corta" }, /INTERNAL_API_KEY/],
      [{ ...ENV, ALUMNO_EMAIL: "sin-arroba" }, /ALUMNO_EMAIL/],
    ]) {
      const r = leerConfigEntrega(env);
      assert.equal(r.ok, false);
      assert.match(r.error, esperado);
      assert.ok(!/no-es-url|ftp:|corta|sin-arroba/.test(r.error));
    }
  });
});

describe("entregarResultados", () => {
  test("éxito: manda el contrato con x-api-key y loguea solo conteos", async (t) => {
    const s = simular(t, [respuesta(200, RESPUESTA_200)]);

    const r = await s.correr();

    assert.equal(r.ok, true);
    assert.equal(s.fetchFn.mock.callCount(), 1);
    const [url, init] = s.fetchFn.mock.calls[0].arguments;
    assert.equal(url, "http://backend.test/internal/grade-snapshots");
    assert.equal(init.method, "POST");
    assert.equal(init.headers["x-api-key"], API_KEY);
    assert.equal(init.headers["Content-Type"], "application/json");
    assert.ok(init.signal instanceof AbortSignal);
    assert.deepEqual(bodyEnviado(s), {
      run_id: RUN_ID,
      captured_at: CAPTURED_AT,
      source: "ivirtual",
      user: { email: EMAIL },
      courses: RESULTADO.courses,
    });
    assert.ok(s.lineas.some((l) => l.includes(`run_id=${RUN_ID}`) && l.includes("changes_detected=2")));
    assert.ok(s.lineas.some((l) => l.includes("baseline=false")));
    assert.equal(s.alertarEquipo.mock.callCount(), 0);
    sinDatosSensibles(s);
  });

  test("5xx: reintenta con backoff exponencial y luego tiene éxito", async (t) => {
    const s = simular(t, [respuesta(503), respuesta(500), respuesta(200, RESPUESTA_200)]);

    const r = await s.correr();

    assert.equal(r.ok, true);
    assert.equal(s.fetchFn.mock.callCount(), 3);
    assert.deepEqual(
      s.sleep.mock.calls.map((c) => c.arguments[0]),
      [1000, 2000],
    );
    assert.equal(s.alertarEquipo.mock.callCount(), 0);
  });

  test("reintentos reutilizan el mismo run_id y el mismo body", async (t) => {
    let uuids = 0;
    const s = simular(t, [respuesta(502), respuesta(200, RESPUESTA_200)], {
      randomUUID: () => `${RUN_ID.slice(0, -1)}${uuids++}`,
    });

    await s.correr();

    assert.equal(uuids, 1, "un solo UUID por corrida");
    const cuerpos = s.fetchFn.mock.calls.map((c) => c.arguments[1].body);
    assert.equal(cuerpos[0], cuerpos[1]);
    assert.equal(JSON.parse(cuerpos[0]).run_id, `${RUN_ID.slice(0, -1)}0`);
  });

  test("401: no reintenta, alerta y devuelve fallo", async (t) => {
    const s = simular(t, [respuesta(401, { error: "no_autorizado" })]);

    const r = await s.correr();

    assert.deepEqual(r, { ok: false, runId: RUN_ID, status: 401, intentos: 1 });
    assert.equal(s.fetchFn.mock.callCount(), 1);
    assert.equal(s.sleep.mock.callCount(), 0);
    assert.equal(s.alertarEquipo.mock.callCount(), 1);
    assert.match(s.alertarEquipo.mock.calls[0].arguments[0], /status 401/);
    assert.ok(s.lineas.some((l) => l.includes("status=401 intento=1")));
    sinDatosSensibles(s);
  });

  test("400 y 409 tampoco se reintentan", async (t) => {
    for (const status of [400, 409]) {
      const s = simular(t, [respuesta(status)]);
      const r = await s.correr();
      assert.equal(r.ok, false);
      assert.equal(s.fetchFn.mock.callCount(), 1, `status ${status}`);
    }
  });

  test("5xx persistente: 4 intentos en total, alerta y fallo", async (t) => {
    const s = simular(t, [respuesta(500)]);

    const r = await s.correr();

    assert.deepEqual(r, { ok: false, runId: RUN_ID, status: 500, intentos: 4 });
    assert.equal(s.fetchFn.mock.callCount(), 4);
    assert.deepEqual(
      s.sleep.mock.calls.map((c) => c.arguments[0]),
      [1000, 2000, 4000],
    );
    assert.equal(s.alertarEquipo.mock.callCount(), 1);
    sinDatosSensibles(s);
  });

  test("timeout: aborta, reintenta y reporta TimeoutError", async (t) => {
    // fetch que nunca responde y solo termina cuando se aborta la señal. El
    // timer de AbortSignal.timeout no mantiene vivo el proceso, así que el
    // setInterval simula el socket abierto de un fetch real.
    const colgado = (_url, init) =>
      new Promise((_resolve, reject) => {
        const socket = setInterval(() => {}, 1000);
        init.signal.addEventListener("abort", () => {
          clearInterval(socket);
          reject(init.signal.reason);
        });
      });
    const s = simular(t, [colgado], { timeoutMs: 20, maxReintentos: 1 });

    const r = await s.correr();

    assert.deepEqual(r, { ok: false, runId: RUN_ID, status: "TimeoutError", intentos: 2 });
    assert.equal(s.fetchFn.mock.callCount(), 2);
    assert.ok(s.lineas.some((l) => l.includes("status=TimeoutError intento=2")));
    assert.equal(s.alertarEquipo.mock.callCount(), 1);
  });

  test("error de red: reintenta y no imprime el mensaje del error", async (t) => {
    const red = () => Promise.reject(new TypeError("fetch failed http://backend.test"));
    const s = simular(t, [red, respuesta(200, RESPUESTA_200)]);

    const r = await s.correr();

    assert.equal(r.ok, true);
    assert.equal(s.fetchFn.mock.callCount(), 2);
    assert.ok(s.lineas.some((l) => l.includes("status=TypeError intento=1")));
    sinDatosSensibles(s);
  });

  test("la alerta pasa el filtro de sendTeamAlert", async (t) => {
    const { validarMensaje } = require("../../monitors/telegram");
    const s = simular(t, [respuesta(500)]);
    await s.correr();
    assert.equal(validarMensaje(s.alertarEquipo.mock.calls[0].arguments[0]), null);
  });

  test("sin cursos no llama al backend", async (t) => {
    const s = simular(t, [respuesta(200, RESPUESTA_200)]);

    const r = await s.correr({ status: "ok", courses: [] });

    assert.deepEqual(r, { ok: true, omitido: true });
    assert.equal(s.fetchFn.mock.callCount(), 0);
  });
});
