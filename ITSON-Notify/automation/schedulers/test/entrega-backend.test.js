// Pruebas de la entrega al backend con fetch simulado. Datos inventados.
// ITN-52 - El correo llega por parámetro (uno por alumno) y la entrega ya no alerta:
// el cron junta las fallas y alerta una vez por corrida.
const { test, describe } = require("node:test");
const assert = require("node:assert/strict");

const { entregarResultados, leerConfigEntrega } = require("../entrega-backend");

const API_KEY = "llave-de-prueba-".padEnd(40, "x");
const EMAIL = "alumno@example.test";
const ENV = {
  BACKEND_URL: "http://backend.test/",
  INTERNAL_API_KEY: API_KEY,
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
  const errores = [];
  let i = 0;
  const fetchFn = t.mock.fn(async (url, init) => {
    const paso = pasos[Math.min(i++, pasos.length - 1)];
    return typeof paso === "function" ? paso(url, init) : paso;
  });
  const sleep = t.mock.fn(async () => {});
  const correr = (resultado = RESULTADO, email = EMAIL) =>
    entregarResultados(resultado, {
      config: CONFIG,
      email,
      capturedAt: CAPTURED_AT,
      log: (l) => lineas.push(l),
      logError: (l) => errores.push(l),
      fetchFn,
      randomUUID: () => RUN_ID,
      sleep,
      ...extra,
    });
  return { correr, fetchFn, sleep, lineas, errores };
}

const bodyEnviado = (s, n = 0) => JSON.parse(s.fetchFn.mock.calls[n].arguments[1].body);

function sinDatosSensibles(s) {
  const todo = [...s.lineas, ...s.errores].join("\n");
  for (const prohibido of [API_KEY, EMAIL, "Materia de prueba A", "85.5", "backend.test"]) {
    assert.ok(!todo.includes(prohibido), `no debe aparecer: ${prohibido}`);
  }
}

describe("leerConfigEntrega", () => {
  test("arma el endpoint sin doble diagonal", () => {
    assert.equal(CONFIG.endpoint, "http://backend.test/internal/grade-snapshots");
    assert.equal(CONFIG.backendUrl, "http://backend.test");
  });

  test("variables faltantes: las nombra sin imprimir valores", () => {
    const r = leerConfigEntrega({ INTERNAL_API_KEY: "  " });
    assert.equal(r.ok, false);
    assert.equal(r.error, "Faltan variables del servicio: BACKEND_URL, INTERNAL_API_KEY.");
  });

  test("ITN-52: ya no exige ALUMNO_EMAIL ni lo pone en la config", () => {
    const r = leerConfigEntrega(ENV);
    assert.equal(r.ok, true);
    assert.ok(!("email" in r.config));
  });

  test("valores inválidos no se repiten en el error", () => {
    for (const [env, esperado] of [
      [{ ...ENV, BACKEND_URL: "no-es-url" }, /BACKEND_URL/],
      [{ ...ENV, BACKEND_URL: "ftp://backend.test" }, /BACKEND_URL/],
      [{ ...ENV, INTERNAL_API_KEY: "corta" }, /INTERNAL_API_KEY/],
    ]) {
      const r = leerConfigEntrega(env);
      assert.equal(r.ok, false);
      assert.match(r.error, esperado);
      assert.ok(!/no-es-url|ftp:|corta/.test(r.error));
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

  test("401: no reintenta y devuelve fallo sin alertar", async (t) => {
    const s = simular(t, [respuesta(401, { error: "no_autorizado" })]);

    const r = await s.correr();

    assert.deepEqual(r, { ok: false, runId: RUN_ID, status: 401, intentos: 1 });
    assert.equal(s.fetchFn.mock.callCount(), 1);
    assert.equal(s.sleep.mock.callCount(), 0);
    assert.ok(s.errores.some((l) => l.includes("status=401 intento=1")));
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

  test("5xx persistente: 4 intentos en total y fallo", async (t) => {
    const s = simular(t, [respuesta(500)]);

    const r = await s.correr();

    assert.deepEqual(r, { ok: false, runId: RUN_ID, status: 500, intentos: 4 });
    assert.equal(s.fetchFn.mock.callCount(), 4);
    assert.deepEqual(
      s.sleep.mock.calls.map((c) => c.arguments[0]),
      [1000, 2000, 4000],
    );
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
    assert.ok(s.errores.some((l) => l.includes("status=TimeoutError intento=2")));
  });

  test("error de red: reintenta y no imprime el mensaje del error", async (t) => {
    const red = () => Promise.reject(new TypeError("fetch failed http://backend.test"));
    const s = simular(t, [red, respuesta(200, RESPUESTA_200)]);

    const r = await s.correr();

    assert.equal(r.ok, true);
    assert.equal(s.fetchFn.mock.callCount(), 2);
    assert.ok(s.errores.some((l) => l.includes("status=TypeError intento=1")));
    sinDatosSensibles(s);
  });

  test("ITN-52: usa el correo recibido por parámetro, uno por alumno", async (t) => {
    const s = simular(t, [respuesta(200, RESPUESTA_200)]);
    await s.correr(RESULTADO, "otra.alumna@example.test");
    await s.correr(RESULTADO, "  tercera@example.test ");
    assert.equal(bodyEnviado(s, 0).user.email, "otra.alumna@example.test");
    assert.equal(bodyEnviado(s, 1).user.email, "tercera@example.test");
  });

  test("ITN-52: sin correo válido no llama al backend y no lo imprime", async (t) => {
    for (const email of [null, "", "sin-arroba"]) {
      const s = simular(t, [respuesta(200, RESPUESTA_200)]);
      const r = await s.correr(RESULTADO, email);
      assert.equal(r.ok, false);
      assert.equal(r.status, "correo_invalido");
      assert.equal(s.fetchFn.mock.callCount(), 0);
      assert.ok(!s.errores.join("\n").includes("sin-arroba"));
    }
  });

  test("sin cursos no llama al backend", async (t) => {
    const s = simular(t, [respuesta(200, RESPUESTA_200)]);

    const r = await s.correr({ status: "ok", courses: [] });

    assert.deepEqual(r, { ok: true, omitido: true });
    assert.equal(s.fetchFn.mock.callCount(), 0);
  });

  test("canales: el éxito sale por log y no toca logError", async (t) => {
    const s = simular(t, [respuesta(200, RESPUESTA_200)]);

    await s.correr();

    assert.equal(s.lineas.length, 1);
    assert.match(s.lineas[0], /^Entrega al backend correcta: /);
    assert.deepEqual(s.errores, []);
  });

  test("canales: cada intento fallido sale por logError y el éxito final por log", async (t) => {
    const s = simular(t, [respuesta(503), respuesta(200, RESPUESTA_200)]);

    await s.correr();

    assert.equal(s.errores.length, 1);
    assert.match(s.errores[0], /^Entrega al backend fallida: .*status=503 intento=1$/);
    assert.equal(s.lineas.length, 1);
    assert.match(s.lineas[0], /^Entrega al backend correcta: .*intento=2 /);
  });

  test("por defecto la entrega usa console.log y console.error", async (t) => {
    const stdout = t.mock.method(console, "log", () => {});
    const stderr = t.mock.method(console, "error", () => {});
    let paso = 0;
    const fetchFn = async () => (paso++ === 0 ? respuesta(503) : respuesta(200, RESPUESTA_200));

    await entregarResultados(RESULTADO, {
      config: CONFIG,
      email: EMAIL,
      fetchFn,
      randomUUID: () => RUN_ID,
      sleep: async () => {},
    });

    assert.equal(stderr.mock.callCount(), 1);
    assert.match(stderr.mock.calls[0].arguments[0], /^Entrega al backend fallida/);
    assert.equal(stdout.mock.callCount(), 1);
    assert.match(stdout.mock.calls[0].arguments[0], /^Entrega al backend correcta/);
  });
});
