// Pruebas de loadConfig: falla con mensajes que nombran variables, nunca
// valores. Valores inventados y armados en tiempo de ejecución.
const { test, describe } = require("node:test");
const assert = require("node:assert/strict");
const crypto = require("crypto");
const util = require("util");

const {
  loadConfig,
  ALLOWED_GOOGLE_OAUTH_SCOPE,
} = require("../../src/config/env");

const LLAVE = ["llave", "interna", "z".repeat(32)].join("-");
const SERVICE_ROLE = ["rol", "de", "servicio", "w".repeat(20)].join("-");
const LLAVE_CREDENCIALES = crypto.randomBytes(32).toString("base64");
const SYNTHETIC_CLIENT_ID = ["client", "id", "sintetico", "12345.apps.googleusercontent.test"].join("-");
const SYNTHETIC_CLIENT_SECRET = ["secret", "oauth", "sintetico", "x".repeat(24)].join("-");
const SYNTHETIC_REDIRECT_URI = "http://localhost:3000/v1/auth/google/callback";

const valido = () => ({
  PORT: "3000",
  INTERNAL_API_KEY: LLAVE,
  SUPABASE_URL: "https://proyecto-inventado.supabase.test",
  SUPABASE_SERVICE_ROLE_KEY: SERVICE_ROLE,
  CREDENTIALS_ENCRYPTION_KEY: LLAVE_CREDENCIALES,
});

const validoConOAuth = () => ({
  ...valido(),
  GOOGLE_CLIENT_ID: SYNTHETIC_CLIENT_ID,
  GOOGLE_CLIENT_SECRET: SYNTHETIC_CLIENT_SECRET,
  GOOGLE_REDIRECT_URI: SYNTHETIC_REDIRECT_URI,
  GOOGLE_OAUTH_SCOPES: ALLOWED_GOOGLE_OAUTH_SCOPE,
});

describe("loadConfig", () => {
  test("lee la configuración válida sin Google OAuth (integración deshabilitada)", () => {
    const config = loadConfig(valido());
    assert.equal(config.port, 3000);
    assert.equal(config.internalApiKey, LLAVE);
    assert.ok(config.googleOAuth);
    assert.equal(config.googleOAuth.enabled, false);
    assert.equal(config.googleOAuth.clientId, null);
    assert.equal(config.googleOAuth.clientSecret, null);
    assert.equal(config.googleOAuth.redirectUri, null);
    assert.deepEqual(config.googleOAuth.scopes, []);
  });

  test("nombra todas las variables que faltan", () => {
    assert.throws(() => loadConfig({}), {
      message:
        "Faltan variables de entorno: PORT, INTERNAL_API_KEY, SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, CREDENTIALS_ENCRYPTION_KEY",
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

  describe("CREDENTIALS_ENCRYPTION_KEY (ITN-36)", () => {
    test("decodifica la llave de 32 bytes sin exponerla al enumerar ni serializar la config", () => {
      const config = loadConfig(valido());
      const esperada = Buffer.from(LLAVE_CREDENCIALES, "base64");
      assert.ok(config.credentialsEncryptionKey.equals(esperada));

      assert.ok(!Object.keys(config).includes("credentialsEncryptionKey"));
      assert.equal({ ...config }.credentialsEncryptionKey, undefined);
      for (const texto of [JSON.stringify(config), util.inspect(config, { depth: null })]) {
        assert.ok(!texto.includes(LLAVE_CREDENCIALES));
        assert.ok(!texto.includes("credentialsEncryptionKey"));
      }
    });

    test("si falta, el error nombra solo la variable", () => {
      for (const ausente of [undefined, "", "   "]) {
        const env = { ...valido(), CREDENTIALS_ENCRYPTION_KEY: ausente };
        assert.throws(() => loadConfig(env), {
          message: "Faltan variables de entorno: CREDENTIALS_ENCRYPTION_KEY",
        });
      }
    });

    test("rechaza lo que no decodifica a 32 bytes, sin repetir el valor", () => {
      const invalidas = {
        de_16_bytes: crypto.randomBytes(16).toString("base64"),
        de_31_bytes: crypto.randomBytes(31).toString("base64"),
        de_33_bytes: crypto.randomBytes(33).toString("base64"),
        en_hex: crypto.randomBytes(32).toString("hex"),
        no_base64: `valor-que-no-es-base64-${"!".repeat(21)}=`,
        base64url: `${"-_".repeat(21)}A=`,
        // Bits sobrantes en el último carácter: decodifica, pero no es canónico.
        no_canonica: `${"A".repeat(42)}B=`,
      };
      for (const [nombre, invalida] of Object.entries(invalidas)) {
        assert.throws(
          () => loadConfig({ ...valido(), CREDENTIALS_ENCRYPTION_KEY: invalida }),
          (error) => {
            assert.match(error.message, /Variables de entorno inválidas: CREDENTIALS_ENCRYPTION_KEY/, nombre);
            assert.ok(!error.message.includes(invalida), nombre);
            return true;
          },
        );
      }
    });

    test("otro error de configuración tampoco revela la llave válida", () => {
      assert.throws(
        () => loadConfig({ ...valido(), PORT: "puerto" }),
        (error) => {
          assert.ok(!error.message.includes(LLAVE_CREDENCIALES));
          return true;
        },
      );
    });
  });

  describe("Google OAuth 2.0 (ITN-40)", () => {
    test("acepta configuración válida de solo lectura para Google Classroom", () => {
      const config = loadConfig(validoConOAuth());
      assert.equal(config.googleOAuth.enabled, true);
      assert.equal(config.googleOAuth.clientId, SYNTHETIC_CLIENT_ID);
      assert.equal(config.googleOAuth.clientSecret, SYNTHETIC_CLIENT_SECRET);
      assert.equal(config.googleOAuth.redirectUri, SYNTHETIC_REDIRECT_URI);
      assert.deepEqual(config.googleOAuth.scopes, [ALLOWED_GOOGLE_OAUTH_SCOPE]);

      // Evita exponer clientSecret al serializar la configuración (p. ej. logs o respuestas).
      const serializado = JSON.stringify(config);
      assert.ok(!serializado.includes(SYNTHETIC_CLIENT_SECRET));
    });

    test("acepta URI de redirección https en producción y http en localhost/127.0.0.1", () => {
      const configHttps = loadConfig({
        ...validoConOAuth(),
        GOOGLE_REDIRECT_URI: "https://api.itson-notify.test/v1/auth/google/callback",
      });
      assert.equal(
        configHttps.googleOAuth.redirectUri,
        "https://api.itson-notify.test/v1/auth/google/callback",
      );

      const configLoopback = loadConfig({
        ...validoConOAuth(),
        GOOGLE_REDIRECT_URI: "http://127.0.0.1:3000/callback",
      });
      assert.equal(configLoopback.googleOAuth.redirectUri, "http://127.0.0.1:3000/callback");
    });

    test("rechaza scopes de escritura o no autorizados", () => {
      const scopesInvalidos = [
        "https://www.googleapis.com/auth/classroom.courses",
        "https://www.googleapis.com/auth/classroom.coursework.students",
        "https://www.googleapis.com/auth/classroom.rosters",
        `${ALLOWED_GOOGLE_OAUTH_SCOPE} https://www.googleapis.com/auth/classroom.courses`,
        "scope-inventado-escritura",
      ];

      for (const scopeInvalido of scopesInvalidos) {
        const env = {
          ...validoConOAuth(),
          GOOGLE_OAUTH_SCOPES: scopeInvalido,
        };
        assert.throws(
          () => loadConfig(env),
          (error) => {
            assert.match(error.message, /GOOGLE_OAUTH_SCOPES/);
            assert.ok(!error.message.includes(SYNTHETIC_CLIENT_SECRET));
            assert.ok(!error.message.includes("scope-inventado-escritura"));
            return true;
          },
        );
      }
    });

    test("rechaza URI de redirección inválida o insegura", () => {
      const urisInvalidas = [
        "no-es-una-url",
        "http://dominio-remoto-inseguro.test/callback",
        "ftp://localhost:3000/callback",
        "javascript:alert(1)",
        "https://api.itson-notify.test/callback#fragmento",
        "https://usuario:secreto@api.itson-notify.test/callback",
      ];

      for (const uriInvalida of urisInvalidas) {
        const env = {
          ...validoConOAuth(),
          GOOGLE_REDIRECT_URI: uriInvalida,
        };
        assert.throws(
          () => loadConfig(env),
          (error) => {
            assert.match(error.message, /GOOGLE_REDIRECT_URI/);
            assert.ok(!error.message.includes(uriInvalida));
            assert.ok(!error.message.includes(SYNTHETIC_CLIENT_SECRET));
            return true;
          },
        );
      }
    });

    test("exige todas las variables obligatorias de OAuth cuando la integración se activa parcialmente", () => {
      const envParcial = {
        ...valido(),
        GOOGLE_CLIENT_ID: SYNTHETIC_CLIENT_ID,
      };

      assert.throws(
        () => loadConfig(envParcial),
        (error) => {
          assert.match(error.message, /Faltan variables de entorno:/);
          assert.match(error.message, /GOOGLE_CLIENT_SECRET/);
          assert.match(error.message, /GOOGLE_REDIRECT_URI/);
          assert.match(error.message, /GOOGLE_OAUTH_SCOPES/);
          assert.ok(!error.message.includes(SYNTHETIC_CLIENT_ID));
          return true;
        },
      );
    });

    test("acepta la lista cerrada para GOOGLE_OAUTH_ENABLED (true, false, 1, 0) y vacío sin variables OAuth", () => {
      for (const flagHabilitado of ["true", "1", " TRUE ", " 1 "]) {
        const config = loadConfig({
          ...validoConOAuth(),
          GOOGLE_OAUTH_ENABLED: flagHabilitado,
        });
        assert.equal(config.googleOAuth.enabled, true);
        assert.equal(config.googleOAuth.clientId, SYNTHETIC_CLIENT_ID);
        assert.equal(config.googleOAuth.clientSecret, SYNTHETIC_CLIENT_SECRET);
        assert.equal(config.googleOAuth.redirectUri, SYNTHETIC_REDIRECT_URI);
        assert.deepEqual(config.googleOAuth.scopes, [ALLOWED_GOOGLE_OAUTH_SCOPE]);
      }

      for (const flagDeshabilitado of ["false", "0", " FALSE ", " 0 ", "", "   "]) {
        const config = loadConfig({
          ...valido(),
          GOOGLE_OAUTH_ENABLED: flagDeshabilitado,
        });
        assert.equal(config.googleOAuth.enabled, false);
        assert.equal(config.googleOAuth.clientId, null);
        assert.equal(config.googleOAuth.clientSecret, null);
        assert.equal(config.googleOAuth.redirectUri, null);
        assert.deepEqual(config.googleOAuth.scopes, []);
      }
    });

    test("exige las cuatro variables OAuth cuando GOOGLE_OAUTH_ENABLED es true o 1", () => {
      for (const flagHabilitado of ["true", "1"]) {
        assert.throws(
          () => loadConfig({ ...valido(), GOOGLE_OAUTH_ENABLED: flagHabilitado }),
          (error) => {
            assert.match(error.message, /Faltan variables de entorno:/);
            assert.match(error.message, /GOOGLE_CLIENT_ID/);
            assert.match(error.message, /GOOGLE_CLIENT_SECRET/);
            assert.match(error.message, /GOOGLE_REDIRECT_URI/);
            assert.match(error.message, /GOOGLE_OAUTH_SCOPES/);
            return true;
          },
        );
      }
    });

    test("deshabilita OAuth sin consumir valores cuando GOOGLE_OAUTH_ENABLED es false o 0 aunque existan otras variables OAuth", () => {
      for (const flagDeshabilitado of ["false", "0"]) {
        const configConVariablesValidas = loadConfig({
          ...validoConOAuth(),
          GOOGLE_OAUTH_ENABLED: flagDeshabilitado,
        });
        assert.equal(configConVariablesValidas.googleOAuth.enabled, false);
        assert.equal(configConVariablesValidas.googleOAuth.clientId, null);
        assert.equal(configConVariablesValidas.googleOAuth.clientSecret, null);
        assert.equal(configConVariablesValidas.googleOAuth.redirectUri, null);
        assert.deepEqual(configConVariablesValidas.googleOAuth.scopes, []);
        assert.ok(!JSON.stringify(configConVariablesValidas).includes(SYNTHETIC_CLIENT_SECRET));

        const configConVariablesParciales = loadConfig({
          ...valido(),
          GOOGLE_OAUTH_ENABLED: flagDeshabilitado,
          GOOGLE_CLIENT_ID: SYNTHETIC_CLIENT_ID,
        });
        assert.equal(configConVariablesParciales.googleOAuth.enabled, false);
        assert.equal(configConVariablesParciales.googleOAuth.clientId, null);
        assert.equal(configConVariablesParciales.googleOAuth.clientSecret, null);
        assert.equal(configConVariablesParciales.googleOAuth.redirectUri, null);
        assert.deepEqual(configConVariablesParciales.googleOAuth.scopes, []);
      }
    });

    test("rechaza valores inválidos en GOOGLE_OAUTH_ENABLED (tru, yes, enabled, 2) mencionando solo GOOGLE_OAUTH_ENABLED sin imprimir el valor", () => {
      const valoresInvalidos = ["tru", "yes", "enabled", "2"];

      for (const valorInvalido of valoresInvalidos) {
        for (const baseEnv of [valido(), validoConOAuth()]) {
          const env = {
            ...baseEnv,
            GOOGLE_OAUTH_ENABLED: valorInvalido,
          };

          assert.throws(
            () => loadConfig(env),
            (error) => {
              assert.match(error.message, /GOOGLE_OAUTH_ENABLED/);
              assert.doesNotMatch(error.message, /GOOGLE_CLIENT_ID/);
              assert.doesNotMatch(error.message, /GOOGLE_CLIENT_SECRET/);
              assert.doesNotMatch(error.message, /GOOGLE_REDIRECT_URI/);
              assert.doesNotMatch(error.message, /GOOGLE_OAUTH_SCOPES/);
              assert.ok(!error.message.includes(valorInvalido));
              assert.ok(!error.message.includes(SYNTHETIC_CLIENT_SECRET));
              return true;
            },
          );
        }
      }
    });

    test("no filtra secretos ni valores sensibles en mensajes de error", () => {
      const secretoSensible = "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-99999";
      const clientIdSensible = "999999-cliente-sintetico-no-filtrar.apps.googleusercontent.test";
      const envConError = {
        ...valido(),
        GOOGLE_CLIENT_ID: clientIdSensible,
        GOOGLE_CLIENT_SECRET: secretoSensible,
        GOOGLE_REDIRECT_URI: "http://remoto-inseguro.test/oauth",
        GOOGLE_OAUTH_SCOPES: "https://www.googleapis.com/auth/classroom.courses",
      };

      assert.throws(
        () => loadConfig(envConError),
        (error) => {
          assert.match(error.message, /GOOGLE_REDIRECT_URI/);
          assert.match(error.message, /GOOGLE_OAUTH_SCOPES/);
          for (const secreto of [
            secretoSensible,
            clientIdSensible,
            "http://remoto-inseguro.test/oauth",
            LLAVE,
            SERVICE_ROLE,
          ]) {
            assert.ok(!error.message.includes(secreto));
          }
          return true;
        },
      );
    });
  });
});
