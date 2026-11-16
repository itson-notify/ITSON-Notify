// ITN-56 - El script del ensayo contra un backend local en proceso (Supabase
// simulado y canal en memoria). Datos inventados.
const { test, describe } = require("node:test");
const assert = require("node:assert/strict");

const { createApp } = require("../../src/app");
const { createLogger } = require("../../src/utils/logger");
const { createFakeSupabase } = require("../helpers/fakeSupabase");
const { API_KEY, CREDENTIALS_KEY } = require("../helpers/payloads");
const { main, backendUrl, mananaAlCierre } = require("../../scripts/ensayo-tarea-nueva");

describe("scripts/ensayo-tarea-nueva", () => {
  test("A es línea base y B avisa 'Nueva tarea publicada' con la fecha", async (t) => {
    const db = createFakeSupabase();
    const enviados = [];
    const app = createApp({
      config: { internalApiKey: API_KEY, credentialsEncryptionKey: CREDENTIALS_KEY },
      supabase: db.client,
      logger: createLogger(() => {}),
      channels: [{ name: "email", send: async (m) => enviados.push(m) }],
    });
    const server = app.listen(0);
    t.after(() => server.close());
    const salida = [];
    t.mock.method(console, "log", (l) => salida.push(l));

    await main({ INTERNAL_API_KEY: API_KEY, ENSAYO_BACKEND_URL: `http://127.0.0.1:${server.address().port}`, ENSAYO_DUE_AT: "2026-11-21T06:59:00.000Z" });

    assert.match(salida[0], /Snapshot A .*status=200 .*baseline=true/);
    assert.match(salida[1], /Snapshot B .*status=200 .*baseline=false .*notified=1 failed=0/);
    assert.equal(enviados.length, 1);
    assert.equal(
      enviados[0].text,
      "Nueva tarea publicada: Tarea nueva de ensayo en Curso de ensayo ITN-56. " +
        "Fecha de entrega: viernes 20 de noviembre de 2026, 23:59 (hora de Hermosillo).",
    );
    const texto = salida.join("\n");
    assert.ok(!texto.includes(API_KEY) && !texto.includes("@example.test"), "sin llave ni correo en la salida");
  });

  test("solo acepta un backend local y nunca corre en producción", async () => {
    assert.throws(() => backendUrl({ ENSAYO_BACKEND_URL: "https://itson-notify.up.railway.app" }), /localhost/);
    await assert.rejects(main({ NODE_ENV: "production", INTERNAL_API_KEY: API_KEY }), /production/);
  });

  test("la fecha por defecto es mañana 23:59 en Hermosillo", () => {
    // 2026-11-19 10:00 en Hermosillo -> 2026-11-20 23:59 Hermosillo = 2026-11-21 06:59 UTC
    assert.equal(mananaAlCierre(Date.parse("2026-11-19T17:00:00Z")), "2026-11-21T06:59:00.000Z");
    // 23:30 en Hermosillo (06:30 UTC del día siguiente) sigue contando desde el día local.
    assert.equal(mananaAlCierre(Date.parse("2026-11-20T06:30:00Z")), "2026-11-21T06:59:00.000Z");
  });
});
