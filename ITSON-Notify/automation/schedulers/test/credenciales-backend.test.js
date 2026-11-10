// ITN-52 - Cliente de /internal/credentials del worker con fetch simulado. Datos
// inventados; nunca sale a la red.
const { test, describe } = require("node:test");
const assert = require("node:assert/strict");

const { crearClienteCredenciales } = require("../credenciales-backend");
const { leerConfigEntrega } = require("../entrega-backend");

const API_KEY = "llave-de-prueba-".padEnd(40, "x");
const CONFIG = leerConfigEntrega({ BACKEND_URL: "http://backend.test/", INTERNAL_API_KEY: API_KEY }).config;
const EMAIL = "alumna@example.test";
const TOKEN = ["token", "prueba", "c".repeat(32)].join("");

const respuesta = (status, body = {}) => ({ ok: status >= 200 && status < 300, status, json: async () => body });

function simular(t, pasos) {
  let i = 0;
  const fetchFn = t.mock.fn(async (url, init) => {
    const paso = pasos[Math.min(i++, pasos.length - 1)];
    return typeof paso === "function" ? paso(url, init) : paso;
  });
  const sleep = t.mock.fn(async () => {});
  const cliente = crearClienteCredenciales({ config: CONFIG, fetchFn, sleep });
  const llamada = (n = 0) => {
    const [url, init] = fetchFn.mock.calls[n].arguments;
    return { url, init, body: init.body ? JSON.parse(init.body) : undefined };
  };
  return { cliente, fetchFn, sleep, llamada };
}

describe("listarActivas", () => {
  test("GET /active?portal=ivirtual con x-api-key y devuelve los correos", async (t) => {
    const s = simular(t, [respuesta(200, { students: [{ email: EMAIL }, { email: "otro@example.test" }] })]);
    assert.deepEqual(await s.cliente.listarActivas(), { ok: true, emails: [EMAIL, "otro@example.test"] });
    const { url, init } = s.llamada();
    assert.equal(url, "http://backend.test/internal/credentials/active?portal=ivirtual");
    assert.equal(init.method, "GET");
    assert.equal(init.headers["x-api-key"], API_KEY);
    assert.equal(init.body, undefined);
  });

  test("5xx y red se reintentan; 401 no", async (t) => {
    const red = () => Promise.reject(new TypeError("fetch failed http://backend.test"));
    const s = simular(t, [red, respuesta(503), respuesta(200, { students: [] })]);
    assert.deepEqual(await s.cliente.listarActivas(), { ok: true, emails: [] });
    assert.equal(s.fetchFn.mock.callCount(), 3);

    const n = simular(t, [respuesta(401)]);
    assert.deepEqual(await n.cliente.listarActivas(), { ok: false, status: 401 });
    assert.equal(n.fetchFn.mock.callCount(), 1);
  });

  test("red persistente: devuelve solo el nombre del error, sin la URL", async (t) => {
    const s = simular(t, [() => Promise.reject(new TypeError("fetch failed http://backend.test"))]);
    const r = await s.cliente.listarActivas();
    assert.deepEqual(r, { ok: false, status: "TypeError" });
  });

  test("respuesta sin students: respuesta_invalida", async (t) => {
    const s = simular(t, [respuesta(200, { otra: 1 })]);
    assert.deepEqual(await s.cliente.listarActivas(), { ok: false, status: "respuesta_invalida" });
  });
});

describe("leerToken", () => {
  test("POST /get con el correo y devuelve el token", async (t) => {
    const s = simular(t, [respuesta(200, { portal: "ivirtual", kind: "ivirtual_token", secret: TOKEN })]);
    assert.deepEqual(await s.cliente.leerToken(EMAIL), { ok: true, token: TOKEN });
    const { url, init, body } = s.llamada();
    assert.equal(url, "http://backend.test/internal/credentials/get");
    assert.equal(init.method, "POST");
    assert.deepEqual(body, { user: { email: EMAIL }, portal: "ivirtual", kind: "ivirtual_token" });
    assert.ok(!url.includes(EMAIL));
  });

  test("404 y 409 devuelven su status sin reintentar", async (t) => {
    for (const status of [404, 409]) {
      const s = simular(t, [respuesta(status)]);
      assert.deepEqual(await s.cliente.leerToken(EMAIL), { ok: false, status });
      assert.equal(s.fetchFn.mock.callCount(), 1);
    }
  });
});

describe("marcarRevinculacion", () => {
  test("POST /needs-relink con reason credenciales", async (t) => {
    const s = simular(t, [respuesta(200, { status: "needs_relink" })]);
    assert.deepEqual(await s.cliente.marcarRevinculacion(EMAIL), { ok: true });
    const { url, body } = s.llamada();
    assert.equal(url, "http://backend.test/internal/credentials/needs-relink");
    assert.deepEqual(body, { user: { email: EMAIL }, portal: "ivirtual", kind: "ivirtual_token", reason: "credenciales" });
  });
});
