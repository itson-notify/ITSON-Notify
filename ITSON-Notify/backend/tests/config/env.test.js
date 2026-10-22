// Pruebas de loadConfig: falla con mensajes que nombran variables, nunca
// valores. Valores inventados y armados en tiempo de ejecución.
const { test, describe } = require("node:test");
const assert = require("node:assert/strict");

const { loadConfig } = require("../../src/config/env");

const LLAVE = ["llave", "interna", "z".repeat(32)].join("-");
const SERVICE_ROLE = ["rol", "de", "servicio", "w".repeat(20)].join("-");
const valido = () => ({
  PORT: "3000",
  INTERNAL_API_KEY: LLAVE,
  SUPABASE_URL: "https://proyecto-inventado.supabase.test",
  SUPABASE_SERVICE_ROLE_KEY: SERVICE_ROLE,
});

describe("loadConfig", () => {
  test("lee la configuración válida", () => {
    const config = loadConfig(valido());
    assert.equal(config.port, 3000);
    assert.equal(config.internalApiKey, LLAVE);
  });

  test("nombra todas las variables que faltan", () => {
    assert.throws(() => loadConfig({}), {
      message: "Faltan variables de entorno: PORT, INTERNAL_API_KEY, SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY",
    });
    const env = valido();
    env.SUPABASE_SERVICE_ROLE_KEY = "   ";
    assert.throws(() => loadConfig(env), /SUPABASE_SERVICE_ROLE_KEY/);
  });

  test("rechaza valores inválidos sin repetirlos", () => {
    const env = { ...valido(), PORT: "puerto", INTERNAL_API_KEY: "corta", SUPABASE_URL: "no-es-url" };
    assert.throws(
      () => loadConfig(env),
      (error) => {
        assert.match(error.message, /PORT/);
        assert.match(error.message, /INTERNAL_API_KEY/);
        assert.match(error.message, /SUPABASE_URL/);
        for (const valor of ["puerto", "corta", "no-es-url", SERVICE_ROLE]) {
          assert.ok(!error.message.includes(valor));
        }
        return true;
      },
    );
  });
});
