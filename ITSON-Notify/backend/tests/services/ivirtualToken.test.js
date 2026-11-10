// ITN-52 - Cliente de token.php del backend con fetch simulado. Nunca sale a la red.
// Datos inventados; la contraseña y el token se arman en tiempo de ejecución.
const { test, describe } = require("node:test");
const assert = require("node:assert/strict");

const {
  requestToken,
  createExchangeToken,
  IvirtualTokenError,
  TOKEN_URL,
} = require("../../src/services/ivirtualToken");

const USUARIO = "usuario.prueba";
const PASSWORD = ["Contra", "sena", "Prueba", "91z"].join("-");
const TOKEN = ["token", "ivirtual", "prueba", "b".repeat(32)].join("");
const CREDS = { username: USUARIO, password: PASSWORD };

const json = (data, status = 200) =>
  new Response(JSON.stringify(data), { status, headers: { "Content-Type": "application/json" } });

// Cada paso es una Response, una función que la devuelve o un error que se lanza.
function simular(pasos) {
  const llamadas = [];
  const esperas = [];
  let i = 0;
  const fetchFn = async (url, init) => {
    llamadas.push({ url, init });
    const paso = pasos[Math.min(i++, pasos.length - 1)];
    if (paso instanceof Error) throw paso;
    return typeof paso === "function" ? paso(url, init) : paso;
  };
  const opts = { fetchFn, sleep: async (ms) => esperas.push(ms) };
  return { llamadas, esperas, opts };
}

function assertSin(texto, valor) {
  for (const forma of [valor, Buffer.from(valor).toString("hex"), Buffer.from(valor).toString("base64")]) {
    assert.ok(!texto.includes(forma), "apareció un valor sensible");
  }
}

describe("requestToken", () => {
  test("POST form-urlencoded a token.php con service=moodle_mobile_app, sin datos en la URL", async () => {
    const s = simular([json({ token: TOKEN })]);
    assert.equal(await requestToken(CREDS, s.opts), TOKEN);

    assert.equal(s.llamadas.length, 1);
    const { url, init } = s.llamadas[0];
    assert.equal(url, TOKEN_URL);
    assert.equal(url, "https://ivirtual.itson.edu.mx/login/token.php");
    assert.equal(init.method, "POST");
    assert.equal(init.headers["Content-Type"], "application/x-www-form-urlencoded");
    assert.ok(init.signal instanceof AbortSignal);
    const body = new URLSearchParams(init.body);
    assert.equal(body.get("username"), USUARIO);
    assert.equal(body.get("password"), PASSWORD);
    assert.equal(body.get("service"), "moodle_mobile_app");
    assertSin(url, PASSWORD);
    assertSin(url, USUARIO);
  });

  test("reintenta en red y 5xx con backoff, y luego obtiene el token", async () => {
    const s = simular([new TypeError("fetch failed"), json({}, 503), json({ token: TOKEN })]);
    assert.equal(await requestToken(CREDS, s.opts), TOKEN);
    assert.equal(s.llamadas.length, 3);
    assert.deepEqual(s.esperas, [500, 1000]);
  });

  test("5xx persistente: 3 intentos y lanza http", async () => {
    const s = simular([json({}, 500)]);
    await assert.rejects(requestToken(CREDS, s.opts), (e) => e instanceof IvirtualTokenError && e.errorcode === "http");
    assert.equal(s.llamadas.length, 3);
  });

  test("no reintenta un errorcode de Moodle ni un 4xx", async () => {
    for (const paso of [json({ error: "x", errorcode: "invalidlogin" }), json({}, 403)]) {
      const s = simular([paso]);
      await assert.rejects(requestToken(CREDS, s.opts));
      assert.equal(s.llamadas.length, 1);
    }
  });

  test("timeout: aborta y lo reporta como timeout", async () => {
    const colgado = (_url, init) =>
      new Promise((_resolve, reject) => {
        const socket = setInterval(() => {}, 1000);
        init.signal.addEventListener("abort", () => {
          clearInterval(socket);
          reject(init.signal.reason);
        });
      });
    const s = simular([colgado]);
    await assert.rejects(
      requestToken(CREDS, { ...s.opts, timeoutMs: 20, retries: 0 }),
      (e) => e.errorcode === "timeout",
    );
  });

  test("respuesta sin token o que no es JSON lanza", async () => {
    for (const paso of [json({}), new Response("<html>", { status: 200 })]) {
      const s = simular([paso]);
      await assert.rejects(requestToken(CREDS, s.opts), IvirtualTokenError);
    }
  });

  test("el mensaje de error no repite usuario ni contraseña", async () => {
    const s = simular([json({ errorcode: "invalidlogin", error: `Login ${USUARIO} con ${PASSWORD} inválido` })]);
    await assert.rejects(requestToken(CREDS, s.opts), (e) => {
      assertSin(e.message, PASSWORD);
      assert.ok(!e.message.includes(USUARIO));
      return true;
    });
  });
});

describe("createExchangeToken (puerto)", () => {
  test("devuelve el token si iVirtual aceptó", async () => {
    const s = simular([json({ token: TOKEN })]);
    assert.equal(await createExchangeToken(s.opts)(CREDS), TOKEN);
  });

  test("invalidlogin resuelve con reason credenciales", async () => {
    const s = simular([json({ error: "Invalid login", errorcode: "invalidlogin" })]);
    assert.deepEqual(await createExchangeToken(s.opts)(CREDS), { ok: false, reason: "credenciales" });
  });

  test("forcepasswordchangenotice y passwordisexpired resuelven con cambio_password", async () => {
    for (const errorcode of ["forcepasswordchangenotice", "passwordisexpired"]) {
      const s = simular([json({ error: "x", errorcode })]);
      assert.deepEqual(await createExchangeToken(s.opts)(CREDS), { ok: false, reason: "cambio_password" });
    }
  });

  test("red, 5xx y otros errorcode lanzan", async () => {
    for (const paso of [new TypeError("fetch failed"), json({}, 502), json({ errorcode: "servicenotavailable" })]) {
      const s = simular([paso]);
      await assert.rejects(createExchangeToken(s.opts)(CREDS), IvirtualTokenError);
    }
  });
});
