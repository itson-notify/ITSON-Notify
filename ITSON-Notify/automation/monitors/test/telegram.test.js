// Pruebas de sendTeamAlert con fetch simulado. Token y chat_id inventados.
const { test, describe } = require("node:test");
const assert = require("node:assert/strict");

const { sendTeamAlert, validarMensaje } = require("../telegram");

const TOKEN_FALSO = "123456789:AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA";
const ENV = { TELEGRAM_BOT_TOKEN: TOKEN_FALSO, TELEGRAM_CHAT_ID: "-100123" };

function simular(t, respuesta = { ok: true, status: 200, json: async () => ({ ok: true }) }) {
  const lineas = [];
  const fetchFn = t.mock.fn(async () => respuesta);
  const log = (linea) => lineas.push(linea);
  const enviar = (texto, env = ENV) => sendTeamAlert(texto, { env, fetchFn, log });
  return { enviar, fetchFn, lineas };
}

describe("sendTeamAlert", () => {
  test("envía texto plano al chat configurado", async (t) => {
    const s = simular(t);

    assert.deepEqual(await s.enviar("Extracción detenida: cambio_password"), { ok: true });
    assert.equal(s.fetchFn.mock.callCount(), 1);
    const [url, opciones] = s.fetchFn.mock.calls[0].arguments;
    assert.equal(url, `https://api.telegram.org/bot${TOKEN_FALSO}/sendMessage`);
    const cuerpo = JSON.parse(opciones.body);
    assert.equal(cuerpo.chat_id, "-100123");
    assert.equal(cuerpo.parse_mode, undefined);
  });

  test("sin variables no llama a Telegram ni lanza", async (t) => {
    const s = simular(t);

    assert.deepEqual(await s.enviar("Prueba", {}), { ok: false, motivo: "sin_configuracion" });
    assert.equal(s.fetchFn.mock.callCount(), 0);
  });

  test("error de Telegram: no lanza y no imprime el token", async (t) => {
    const s = simular(t, {
      ok: false,
      status: 401,
      json: async () => ({ description: "Unauthorized" }),
    });

    const r = await s.enviar("Prueba");
    assert.equal(r.motivo, "error_telegram");
    assert.ok(s.lineas.every((l) => !l.includes(TOKEN_FALSO)));
  });

  test("fallo de red: no lanza y no imprime el token", async (t) => {
    const lineas = [];
    const fetchFn = async (url) => {
      throw new Error(`fetch failed ${url}`);
    };
    const r = await sendTeamAlert("Prueba", { env: ENV, fetchFn, log: (l) => lineas.push(l) });

    assert.equal(r.motivo, "error_red");
    assert.ok(lineas.every((l) => !l.includes(TOKEN_FALSO)));
  });

  test("rechaza mensajes sensibles sin llamar a Telegram ni repetirlos", async (t) => {
    const s = simular(t);
    const r = await s.enviar("Login falló, password=hunter2");

    assert.deepEqual(r, { ok: false, motivo: "rechazado" });
    assert.equal(s.fetchFn.mock.callCount(), 0);
    assert.ok(s.lineas.every((l) => !l.includes("hunter2")));
  });
});

describe("validarMensaje", () => {
  const permitidos = [
    "Extracción detenida: cambio_password (ivirtual-api)",
    'ALERTA_RPA {"tipo":"credenciales","fuente":"ivirtual-api","fecha":"2026-10-20T14:00:00.000Z"}',
    "worker-rpa: Moodle respondió 503 tras 3 reintentos",
  ];
  for (const texto of permitidos) {
    test(`permite: ${texto}`, () => assert.equal(validarMensaje(texto), null));
  }

  const rechazados = [
    ["token de bot", `Token ${TOKEN_FALSO}`],
    ["contraseña con valor", "Contraseña: abc123"],
    ["P_User", "P_User=loquesea"],
    ["wstoken en URL", "GET /webservice/rest/server.php?wstoken=abc"],
    ["header", "Authorization: Bearer abcdefghijklmnop"],
    ["JWT", "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.firma"],
    ["correo", "Falló el envío a alumno@potros.itson.edu.mx"],
    ["matrícula", "Error con la matrícula 00000123456"],
    ["CURP", "CURP GOMA800101HSRRRN09"],
    ["llave larga", "key " + ["sk", "live", "0123456789abcdefghijklmnopqrstuv"].join("_")],
    ["vacío", "   "],
    ["largo", "x ".repeat(200)],
  ];
  for (const [nombre, texto] of rechazados) {
    test(`rechaza: ${nombre}`, () => assert.notEqual(validarMensaje(texto), null));
  }
});
