// Pruebas del punto de entrada del cron con extract, alertar, entregar y el cliente
// de credenciales simulados. Datos inventados.
// ITN-52 - El cron es multi-alumno: lista las cuentas activas del backend y usa el
// token de cada una. Ya no hay Id_User, P_User ni ALUMNO_EMAIL.
const { test, describe } = require("node:test");
const assert = require("node:assert/strict");

const { ejecutar, arrancar, ocultarValores } = require("../extraccion-cron");
const { entregarResultados } = require("../entrega-backend");
const { crearClienteCredenciales } = require("../credenciales-backend");
const { notificarFalloCritico } = require("../../monitors/alertas");
const { sendTeamAlert, validarMensaje } = require("../../monitors/telegram");

const ENV = {
  BACKEND_URL: "http://backend.test",
  INTERNAL_API_KEY: "llave-de-prueba-".padEnd(40, "x"),
};
const CURSOS = [{ items: [{}, {}] }, { items: [{}] }];
const token = (n) => ["tok", "en", "prueba", String(n), "d".repeat(32)].join("");
const correo = (n) => `alumno${n}@example.test`;

// Backend en memoria: { [email]: { token, status } } con status active o
// needs_relink. `fallas` fuerza un status en una operación para un correo.
function backendSimulado(cuentas, { activas = null, fallas = {} } = {}) {
  const estado = Object.fromEntries(cuentas.map((n) => [correo(n), { token: token(n), status: "active" }]));
  const llamadas = { listar: 0, get: [], marcar: [] };
  const cliente = {
    async listarActivas() {
      llamadas.listar += 1;
      if (activas) return activas;
      const emails = Object.entries(estado).filter(([, v]) => v.status === "active").map(([e]) => e);
      return { ok: true, emails };
    },
    async leerToken(email) {
      llamadas.get.push(email);
      if (fallas.get?.[email]) return { ok: false, status: fallas.get[email] };
      const cuenta = estado[email];
      if (!cuenta) return { ok: false, status: 404 };
      if (cuenta.status !== "active") return { ok: false, status: 409 };
      return { ok: true, token: cuenta.token };
    },
    async marcarRevinculacion(email, reason) {
      llamadas.marcar.push({ email, reason });
      if (fallas.marcar?.[email]) return { ok: false, status: fallas.marcar[email] };
      estado[email].status = "needs_relink";
      return { ok: true };
    },
  };
  return { cliente, estado, llamadas };
}

// `resultados` mapea token -> resultado de la extracción (por defecto ok con CURSOS).
function simular(t, { cuentas = [1, 2], resultados = {}, env = ENV, envio = { ok: true }, backend = {} } = {}) {
  const lineas = [];
  const errores = [];
  const b = backendSimulado(cuentas, backend);
  const extract = t.mock.fn(async (tk) => resultados[tk] ?? { status: "ok", courses: CURSOS });
  const alertar = t.mock.fn(async () => {});
  const entregar = t.mock.fn(async () => (typeof envio === "function" ? envio() : envio));
  const pausa = t.mock.fn(async () => {});
  const correr = (extra = {}) =>
    ejecutar({
      env,
      extract,
      alertar,
      entregar,
      pausa,
      crearCliente: () => b.cliente,
      log: (l) => lineas.push(l),
      logError: (l) => errores.push(l),
      ...extra,
    });
  return { correr, extract, alertar, entregar, pausa, lineas, errores, ...b };
}

const ultimaLinea = (s) => [...s.lineas, ...s.errores].find((l) => l.startsWith("Corrida terminada"));

describe("cron multi-alumno", () => {
  test("usa el token de cada alumno y entrega con su correo, en secuencia y con pausa", async (t) => {
    const s = simular(t, { cuentas: [1, 2, 3] });

    assert.equal(await s.correr(), 0);
    assert.deepEqual(s.extract.mock.calls.map((c) => c.arguments[0]), [token(1), token(2), token(3)]);
    assert.deepEqual(s.entregar.mock.calls.map((c) => c.arguments[1].email), [correo(1), correo(2), correo(3)]);
    assert.equal(s.pausa.mock.callCount(), 2, "una pausa entre cuentas, no antes de la primera");
    assert.equal(s.alertar.mock.callCount(), 0);
    const [, opciones] = s.entregar.mock.calls[0].arguments;
    assert.equal(opciones.config.endpoint, "http://backend.test/internal/grade-snapshots");
    assert.ok(!Number.isNaN(Date.parse(opciones.capturedAt)));
    assert.match(ultimaLinea(s), /cuentas=3 procesadas=3 entregadas=3/);
    assert.deepEqual(s.errores, []);
  });

  test("no necesita Id_User, P_User ni ALUMNO_EMAIL", async (t) => {
    const s = simular(t, { env: { ...ENV } });
    assert.equal(await s.correr(), 0);
    assert.equal(s.entregar.mock.callCount(), 2);
  });

  test("sin cuentas activas: sale con 0, sin alerta y con el conteo en el log", async (t) => {
    const s = simular(t, { cuentas: [] });
    assert.equal(await s.correr(), 0);
    assert.equal(s.extract.mock.callCount(), 0);
    assert.equal(s.alertar.mock.callCount(), 0);
    assert.deepEqual(s.lineas, ["Sin cuentas activas de iVirtual: 0 cuenta(s). Nada que consultar."]);
  });

  test("RPA_PAUSADO=true no consulta el backend ni iVirtual", async (t) => {
    const s = simular(t, { env: { ...ENV, RPA_PAUSADO: "true" } });
    assert.equal(await s.correr(), 0);
    assert.equal(s.llamadas.listar, 0);
    assert.equal(s.extract.mock.callCount(), 0);
    assert.equal(s.lineas.length, 1);
    assert.match(s.lineas[0], /^RPA pausado/);
  });
});

describe("token rechazado", () => {
  test("marca needs-relink con reason credenciales, no reintenta y no alerta", async (t) => {
    const s = simular(t, { cuentas: [1, 2], resultados: { [token(1)]: { status: "token_invalido", courses: [] } } });

    assert.equal(await s.correr(), 0);
    assert.deepEqual(s.llamadas.marcar, [{ email: correo(1), reason: "credenciales" }]);
    assert.equal(s.extract.mock.calls.filter((c) => c.arguments[0] === token(1)).length, 1);
    assert.equal(s.alertar.mock.callCount(), 0);
    assert.deepEqual(s.entregar.mock.calls.map((c) => c.arguments[1].email), [correo(2)]);
    assert.match(ultimaLinea(s), /token_invalido=1 marcadas_revinculacion=1/);
  });

  test("la cuenta marcada deja de salir en /active: la corrida siguiente no la consulta", async (t) => {
    const s = simular(t, { cuentas: [1, 2], resultados: { [token(1)]: { status: "token_invalido", courses: [] } } });
    await s.correr();
    assert.equal(s.estado[correo(1)].status, "needs_relink");

    s.extract.mock.resetCalls();
    assert.equal(await s.correr(), 0);
    assert.deepEqual(s.extract.mock.calls.map((c) => c.arguments[0]), [token(2)]);
    assert.ok(!s.llamadas.get.slice(2).includes(correo(1)));
  });

  test("bloque: 3 o más cuentas y todas invalidtoken no marca ninguna, alerta una vez y sale con 1", async (t) => {
    const invalido = { status: "token_invalido", courses: [] };
    const s = simular(t, {
      cuentas: [1, 2, 3],
      resultados: { [token(1)]: invalido, [token(2)]: invalido, [token(3)]: invalido },
    });

    assert.equal(await s.correr(), 1);
    assert.deepEqual(s.llamadas.marcar, []);
    assert.equal(s.alertar.mock.callCount(), 1);
    const [evento] = s.alertar.mock.calls[0].arguments;
    assert.equal(evento.tipo, "tokens_en_bloque");
    assert.deepEqual(evento.conteos, { cuentas: 3, token_invalido: 3 });
    assert.ok(Object.values(s.estado).every((c) => c.status === "active"));
  });

  test("con menos de 3 cuentas procesadas, todas invalidtoken sí se marcan", async (t) => {
    const invalido = { status: "token_invalido", courses: [] };
    const s = simular(t, { cuentas: [1, 2], resultados: { [token(1)]: invalido, [token(2)]: invalido } });
    assert.equal(await s.correr(), 0);
    assert.equal(s.llamadas.marcar.length, 2);
    assert.equal(s.alertar.mock.callCount(), 0);
  });

  test("si una de 3 extrae bien no es bloque: marca las otras dos", async (t) => {
    const invalido = { status: "token_invalido", courses: [] };
    const s = simular(t, { cuentas: [1, 2, 3], resultados: { [token(1)]: invalido, [token(3)]: invalido } });
    assert.equal(await s.correr(), 0);
    assert.deepEqual(s.llamadas.marcar.map((m) => m.email), [correo(1), correo(3)]);
  });

  test("otros errores de iVirtual (nopermissions, accessexception) no marcan la cuenta", async (t) => {
    const s = simular(t, {
      cuentas: [1, 2],
      resultados: {
        [token(1)]: { status: "error", courses: [], error: "x", errorcode: "nopermissions" },
        [token(2)]: { status: "error", courses: [], error: "x", errorcode: "accessexception" },
      },
    });
    assert.equal(await s.correr(), 1);
    assert.deepEqual(s.llamadas.marcar, []);
  });

  test("si falla marcar needs-relink se cuenta como falla de backend y alerta una vez", async (t) => {
    const s = simular(t, {
      cuentas: [1],
      resultados: { [token(1)]: { status: "token_invalido", courses: [] } },
      backend: { fallas: { marcar: { [correo(1)]: 503 } } },
    });
    assert.equal(await s.correr(), 1);
    assert.equal(s.alertar.mock.callCount(), 1);
    assert.equal(s.alertar.mock.calls[0].arguments[0].conteos.fallas_backend, 1);
  });
});

describe("cuentas omitidas o fallidas", () => {
  test("get 404 o 409 se omite en silencio y sigue con las demás", async (t) => {
    const s = simular(t, { cuentas: [1, 2, 3], backend: { fallas: { get: { [correo(1)]: 404, [correo(2)]: 409 } } } });
    assert.equal(await s.correr(), 0);
    assert.deepEqual(s.extract.mock.calls.map((c) => c.arguments[0]), [token(3)]);
    assert.equal(s.alertar.mock.callCount(), 0);
    assert.deepEqual(s.errores, []);
    assert.match(ultimaLinea(s), /omitidas=2/);
  });

  test("una cuenta fallida no detiene a las demás", async (t) => {
    const s = simular(t, {
      cuentas: [1, 2, 3],
      resultados: { [token(2)]: { status: "error", courses: [], error: "HTTP 503", errorcode: null } },
    });
    assert.equal(await s.correr(), 1);
    assert.deepEqual(s.entregar.mock.calls.map((c) => c.arguments[1].email), [correo(1), correo(3)]);
  });

  test("get con 5xx en una cuenta: se cuenta y la corrida sigue", async (t) => {
    const s = simular(t, { cuentas: [1, 2], backend: { fallas: { get: { [correo(1)]: 503 } } } });
    assert.equal(await s.correr(), 1);
    assert.deepEqual(s.extract.mock.calls.map((c) => c.arguments[0]), [token(2)]);
  });

  test("get con 401 cancela la corrida completa con una alerta", async (t) => {
    const s = simular(t, { cuentas: [1, 2, 3], backend: { fallas: { get: { [correo(2)]: 401 } } } });
    assert.equal(await s.correr(), 1);
    assert.equal(s.extract.mock.callCount(), 1);
    assert.deepEqual(s.llamadas.get, [correo(1), correo(2)]);
    assert.equal(s.alertar.mock.callCount(), 1);
    assert.equal(s.alertar.mock.calls[0].arguments[0].tipo, "backend");
  });

  test("varias fallas de iVirtual, backend y entrega: UNA sola alerta con conteos", async (t) => {
    let entregas = 0;
    const s = simular(t, {
      cuentas: [1, 2, 3, 4, 5],
      resultados: {
        [token(1)]: { status: "error", courses: [], error: "HTTP 503", errorcode: null },
        [token(2)]: { status: "error", courses: [], error: "x", errorcode: "invalidrecord" },
      },
      backend: { fallas: { get: { [correo(3)]: 500 } } },
      envio: () => (entregas++ === 0 ? { ok: false, status: 503 } : { ok: true }),
    });

    assert.equal(await s.correr(), 1);
    assert.equal(s.alertar.mock.callCount(), 1);
    const [evento] = s.alertar.mock.calls[0].arguments;
    assert.equal(evento.tipo, "corrida_con_fallas");
    assert.deepEqual(evento.conteos, {
      cuentas: 5, fallidas: 4, fallas_ivirtual: 2, fallas_backend: 1, entregas_fallidas: 1,
    });
  });

  test("backend inalcanzable al listar: alerta una vez y sale con 1", async (t) => {
    const s = simular(t, { backend: { activas: { ok: false, status: "TypeError" } } });
    assert.equal(await s.correr(), 1);
    assert.equal(s.extract.mock.callCount(), 0);
    assert.equal(s.alertar.mock.callCount(), 1);
    assert.equal(s.alertar.mock.calls[0].arguments[0].tipo, "backend");
    assert.match(s.errores[0], /^No se pudo leer la lista de cuentas activas: status=TypeError$/);
  });

  test("configuración incompleta: alerta configuración sin valores y no llama al backend", async (t) => {
    const { BACKEND_URL, ...sinBackend } = ENV;
    const s = simular(t, { env: sinBackend });
    assert.equal(await s.correr(), 1);
    assert.equal(s.llamadas.listar, 0);
    assert.equal(s.alertar.mock.callCount(), 1);
    assert.deepEqual(Object.keys(s.alertar.mock.calls[0].arguments[0]).sort(), ["fecha", "fuente", "tipo"]);
    assert.match(s.errores[0], /BACKEND_URL/);
  });

  test("pasa el env de la corrida a la alerta y espera el envío", async (t) => {
    const s = simular(t, { backend: { activas: { ok: false, status: 503 } } });
    let termino = false;
    const alertar = async (_evento, opciones) => {
      assert.equal(opciones.env, ENV);
      await new Promise((resolve) => setImmediate(resolve));
      termino = true;
    };
    assert.equal(await s.correr({ alertar }), 1);
    assert.ok(termino);
  });

  test("alerta rechazada o sin Telegram: conserva el código de salida", async (t) => {
    const s = simular(t, { backend: { activas: { ok: false, status: 503 } } });
    assert.equal(await s.correr({ alertar: notificarFalloCritico }), 1);
  });
});

describe("ocultarValores", () => {
  test("redacta la llave del env y el token de la cuenta en curso", () => {
    const tk = token(9);
    const texto = ocultarValores(`a ${ENV.INTERNAL_API_KEY} b ${tk} c`, ENV, [tk]);
    assert.equal(texto, "a [oculto] b [oculto] c");
  });

  test("el token en curso no llega a los logs aunque el resultado lo cite", async (t) => {
    const tk = token(1);
    const s = simular(t, { cuentas: [1] });
    const extract = async () => ({ status: "ok", courses: CURSOS });
    // La entrega simulada intenta loguear el token: el cron lo redacta.
    const entregar = async (_r, { log, logError }) => {
      log(`algo ${tk}`);
      logError(`otro ${tk}`);
      return { ok: true };
    };
    await s.correr({ extract, entregar });
    assert.ok(![...s.lineas, ...s.errores].join("\n").includes(tk));
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

  test("corrida sin excepción: devuelve su código y no alerta", async (t) => {
    const alertar = t.mock.fn(async () => {});

    assert.equal(await arrancar({ correr: async () => 0, alertar, logError: () => {} }), 0);
    assert.equal(alertar.mock.callCount(), 0);
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
    assert.match(stderr.mock.calls[0].arguments[0], /^Faltan variables del servicio: BACKEND_URL, INTERNAL_API_KEY\./);
    assert.match(stderr.mock.calls[1].arguments[0], /^ALERTA_RPA /);
  });
});

// Recorre la corrida con las piezas reales (cliente de credenciales, entrega,
// alertas.js y sendTeamAlert) y fetch simulado. iVirtual, el backend y Telegram
// repiten el token y el correo en sus respuestas para probar que no se filtran en
// logs ni alertas, en texto, hex o base64.
describe("privacidad de logs y alertas (ITN-39, ITN-52)", () => {
  const TELEGRAM_BOT_TOKEN = "123456789:TOKENRECONOCIBLETOKENRECONOCIBLE12";
  const ENV_COMPLETO = { ...ENV, TELEGRAM_BOT_TOKEN, TELEGRAM_CHAT_ID: "-100123" };
  const formas = (v) => [v, Buffer.from(v).toString("hex"), Buffer.from(v).toString("base64")];

  function instrumentar({ cuentas, tokens, getStatus = {}, snapshotStatus = 200 }) {
    const salidas = [];
    const textos = [];
    const marcadas = [];
    const log = (l) => salidas.push(l);
    const backendFetch = async (url, init) => {
      const body = init.body ? JSON.parse(init.body) : null;
      if (url.endsWith("/active?portal=ivirtual")) {
        return { ok: true, status: 200, json: async () => ({ students: cuentas.map((email) => ({ email })) }) };
      }
      if (url.endsWith("/get")) {
        const status = getStatus[body.user.email] ?? 200;
        return { ok: status === 200, status, json: async () => ({ secret: tokens[body.user.email] }) };
      }
      if (url.endsWith("/needs-relink")) {
        marcadas.push(body);
        return { ok: true, status: 200, json: async () => ({ status: "needs_relink" }) };
      }
      return { ok: snapshotStatus === 200, status: snapshotStatus, json: async () => ({ baseline: false, changes_detected: 0 }) };
    };
    const telegramFetch = async (_url, init) => {
      textos.push(JSON.parse(init.body).text);
      return { ok: false, status: 500, json: async () => ({ description: "Internal" }) };
    };
    const enviar = (texto, opciones) => sendTeamAlert(texto, { ...opciones, fetchFn: telegramFetch });
    const alertar = (evento, opciones) => notificarFalloCritico(evento, { ...opciones, enviar });
    const crearCliente = (opts) => crearClienteCredenciales({ ...opts, fetchFn: backendFetch, sleep: async () => {} });
    const entregar = (result, opciones) =>
      entregarResultados(result, { ...opciones, fetchFn: backendFetch, sleep: async () => {}, maxReintentos: 0 });
    const correr = (extract) =>
      ejecutar({ env: ENV_COMPLETO, extract, alertar, entregar, crearCliente, pausa: async () => {}, log, logError: log });
    const revisar = (valores) => {
      const todo = [...salidas, ...textos].join("\n");
      for (const valor of valores) for (const forma of formas(valor)) assert.ok(!todo.includes(forma), "se filtró un valor");
      for (const texto of textos) assert.equal(validarMensaje(texto), null);
    };
    return { correr, salidas, textos, marcadas, revisar };
  }

  test("token y correo no aparecen en logs ni alertas, con fallas, rechazos y entregas fallidas", async () => {
    const cuentas = [1, 2, 3, 4, 5].map(correo);
    const tokens = Object.fromEntries(cuentas.map((e, i) => [e, token(i + 1)]));
    const m = instrumentar({ cuentas, tokens, getStatus: { [correo(5)]: 503 }, snapshotStatus: 500 });
    const extract = async (tk) => {
      if (tk === token(1)) return { status: "token_invalido", courses: [] };
      if (tk === token(2)) {
        return { status: "error", courses: [], error: `fallo ${tk} ${correo(2)}`, errorcode: tk };
      }
      return { status: "ok", courses: [{ externalId: "1", subject: "Materia", items: [] }] };
    };

    assert.equal(await m.correr(extract), 1);
    assert.equal(m.textos.length, 1, "una sola alerta por corrida");
    assert.equal(m.marcadas.length, 1);
    m.revisar([...Object.values(tokens), ...cuentas, ENV.INTERNAL_API_KEY, TELEGRAM_BOT_TOKEN]);
  });

  test("tokens en bloque: una alerta con conteos y sin datos de alumnos", async () => {
    const cuentas = [1, 2, 3].map(correo);
    const tokens = Object.fromEntries(cuentas.map((e, i) => [e, token(i + 1)]));
    const m = instrumentar({ cuentas, tokens });

    assert.equal(await m.correr(async () => ({ status: "token_invalido", courses: [] })), 1);
    assert.equal(m.textos.length, 1);
    assert.match(m.textos[0], /tokens rechazados en bloque/);
    assert.equal(m.marcadas.length, 0);
    m.revisar([...Object.values(tokens), ...cuentas]);
  });
});
