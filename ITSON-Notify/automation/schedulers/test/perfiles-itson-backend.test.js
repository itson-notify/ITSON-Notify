// ITN-55 - Cliente de GET /internal/itson-profiles/active con fetch simulado. Datos
// inventados.
const { test } = require("node:test");
const assert = require("node:assert/strict");

const { crearClientePerfilesItson, RUTA } = require("../perfiles-itson-backend");

const CONFIG = { backendUrl: "http://backend.test", apiKey: "llave-de-prueba-".padEnd(40, "x") };
const OK = { email: "a.prueba123456@potros.itson.edu.mx", matricula: "00000123456", career: "INSOF" };

function cliente(respuestas) {
  const llamadas = [];
  const fetchFn = async (url, init) => {
    llamadas.push({ url, init });
    const r = respuestas[Math.min(llamadas.length - 1, respuestas.length - 1)];
    if (typeof r === "function") return r();
    return { ok: r.status < 300, status: r.status, json: async () => r.body };
  };
  return { c: crearClientePerfilesItson({ config: CONFIG, fetchFn, sleep: async () => {} }), llamadas };
}

test("GET con x-api-key a la ruta interna y entradas inválidas descartadas", async () => {
  const { c, llamadas } = cliente([{ status: 200, body: { students: [OK, { ...OK, matricula: "123" }, { ...OK, career: "insof" }] } }]);
  const r = await c.listarActivos();
  assert.deepEqual(r, { ok: true, alumnos: [OK], descartados: 2 });
  assert.equal(llamadas[0].url, `${CONFIG.backendUrl}${RUTA}`);
  assert.equal(llamadas[0].init.method, "GET");
  assert.equal(llamadas[0].init.headers["x-api-key"], CONFIG.apiKey);
});

test("401 no se reintenta; 5xx sí, y el error solo lleva el status", async () => {
  const a = cliente([{ status: 401 }]);
  assert.deepEqual(await a.c.listarActivos(), { ok: false, status: 401 });
  assert.equal(a.llamadas.length, 1);

  const b = cliente([{ status: 503 }]);
  assert.deepEqual(await b.c.listarActivos(), { ok: false, status: 503 });
  assert.equal(b.llamadas.length, 3);
});

test("error de red: solo el nombre del error", async () => {
  const { c } = cliente([() => { throw new TypeError(`fetch failed ${CONFIG.backendUrl}`); }]);
  assert.deepEqual(await c.listarActivos(), { ok: false, status: "TypeError" });
});

test("respuesta sin students: respuesta_invalida", async () => {
  const { c } = cliente([{ status: 200, body: { otra: 1 } }]);
  assert.deepEqual(await c.listarActivos(), { ok: false, status: "respuesta_invalida" });
});
