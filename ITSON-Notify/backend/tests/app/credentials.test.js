// ITN-36 - Pruebas de /internal/credentials con supertest y un Supabase simulado
// (tests/helpers/fakeSupabase.js). Secretos inventados y armados en tiempo de
// ejecución.
// ITN-51 - El worker ya no guarda ni borra: las credenciales se siembran con el
// servicio (como lo hace /api/credentials/ivirtual) y PUT y DELETE responden 404.
const { test, describe } = require("node:test");
const assert = require("node:assert/strict");
const crypto = require("crypto");
const request = require("supertest");

const { createApp } = require("../../src/app");
const { createLogger } = require("../../src/utils/logger");
const { createCredentialRepository } = require("../../src/repositories/credentialRepository");
const { createCredentialService } = require("../../src/services/credentialService");
const { credentialCryptoFromConfig } = require("../../src/services/credentialCrypto");
const { createFakeSupabase } = require("../helpers/fakeSupabase");
const { API_KEY, OTRA_API_KEY, CREDENTIALS_KEY, EMAIL, OTRO_EMAIL } = require("../helpers/payloads");

const RUTA = "/internal/credentials";
const SECRETO = ["token", "de", "prueba", "f".repeat(32)].join("");
const SECRETO_GOOGLE = ["refresh", "token", "prueba", "g".repeat(40)].join("/");

const refIvirtual = (email = EMAIL) => ({ user: { email }, portal: "ivirtual", kind: "ivirtual_token" });
const refGoogle = (email = EMAIL) => ({ user: { email }, portal: "google_classroom", kind: "google_refresh_token" });

function setup({ key = CREDENTIALS_KEY } = {}) {
  const db = createFakeSupabase();
  const logs = [];
  const config = { internalApiKey: API_KEY, credentialsEncryptionKey: key };
  const repo = createCredentialRepository(db.client);
  const service = createCredentialService({ repo, crypto: credentialCryptoFromConfig(config) });
  // Siembra directa, sin HTTP: da de alta al estudiante y guarda cifrado.
  const guardar = async ({ user, portal, kind, secret } = { ...refIvirtual(), secret: SECRETO }) => {
    const userId = await repo.ensureUser(user.email);
    return service.saveSecretForUser({ userId, portal, kind, secret });
  };
  const app = createApp({
    config,
    supabase: db.client,
    logger: createLogger((line) => logs.push(line)),
  });
  const llamar = (metodo, sufijo, body, apiKey = API_KEY) =>
    request(app)[metodo](`${RUTA}${sufijo}`).set("x-api-key", apiKey).send(body);
  return {
    db,
    logs,
    app,
    llamar,
    guardar,
    leer: (body = refIvirtual(), apiKey) => llamar("post", "/get", body, apiKey),
    marcar: (body = refIvirtual(), apiKey) => llamar("post", "/needs-relink", body, apiKey),
  };
}

// El secreto en claro y codificado de las formas en que podría filtrarse.
function assertSinSecreto(texto, secreto = SECRETO) {
  for (const forma of [
    secreto,
    Buffer.from(secreto).toString("hex"),
    Buffer.from(secreto).toString("base64"),
  ]) {
    assert.ok(!texto.includes(forma), "apareció el secreto");
  }
}

describe("autenticación", () => {
  test("401 sin x-api-key o con una incorrecta en todas las rutas, sin tocar la base", async () => {
    const { app, db, logs } = setup();
    const rutas = [
      ["put", "", { ...refIvirtual(), secret: SECRETO }],
      ["post", "/get", refIvirtual()],
      ["post", "/needs-relink", refIvirtual()],
      ["delete", "", refIvirtual()],
    ];
    for (const [metodo, sufijo, body] of rutas) {
      const sinLlave = await request(app)[metodo](`${RUTA}${sufijo}`).send(body);
      assert.equal(sinLlave.status, 401, `${metodo} ${sufijo}`);
      assert.deepEqual(sinLlave.body, { error: "no_autorizado" });

      const incorrecta = await request(app)[metodo](`${RUTA}${sufijo}`).set("x-api-key", OTRA_API_KEY).send(body);
      assert.equal(incorrecta.status, 401, `${metodo} ${sufijo}`);
    }
    assert.equal(db.calls.length, 0);
    assertSinSecreto(logs.join("\n"));
  });
});

describe("PUT y DELETE /internal/credentials (ITN-51)", () => {
  test("ya no existen: 404 con llave válida, sin escribir ni borrar", async () => {
    const { llamar, guardar, db } = setup();
    await guardar();
    const antes = structuredClone(db.tables.student_credentials);
    const llamadasAntes = db.calls.length;

    const put = await llamar("put", "", { ...refIvirtual(), secret: `${SECRETO}-nuevo` });
    const del = await llamar("delete", "", refIvirtual());
    for (const res of [put, del]) {
      assert.equal(res.status, 404);
      assert.deepEqual(res.body, { error: "no_encontrado" });
      assertSinSecreto(JSON.stringify(res.body));
    }
    assert.deepEqual(db.tables.student_credentials, antes);
    assert.equal(db.calls.length, llamadasAntes);
  });
});

describe("POST /internal/credentials/get", () => {
  test("devuelve lo guardado, sin cache, y la fila no tiene el secreto en claro", async () => {
    const { guardar, leer } = setup();
    await guardar();
    const res = await leer();
    assert.equal(res.status, 200);
    assert.deepEqual(res.body, { portal: "ivirtual", kind: "ivirtual_token", secret: SECRETO });
    assert.equal(res.headers["cache-control"], "no-store");
  });

  test("devuelve el secreto tal cual, sin recortarlo", async () => {
    const { guardar, leer } = setup();
    const conEspacios = `  ${SECRETO}  `;
    await guardar({ ...refIvirtual(), secret: conEspacios });
    assert.equal((await leer()).body.secret, conEspacios);
  });

  test("guarda los dos tipos por separado y por estudiante", async () => {
    const { guardar, leer } = setup();
    await guardar();
    await guardar({ ...refGoogle(), secret: SECRETO_GOOGLE });
    await guardar({ ...refIvirtual(OTRO_EMAIL), secret: `${SECRETO}-otro` });

    assert.equal((await leer(refIvirtual())).body.secret, SECRETO);
    assert.equal((await leer(refGoogle())).body.secret, SECRETO_GOOGLE);
    assert.equal((await leer(refIvirtual(OTRO_EMAIL))).body.secret, `${SECRETO}-otro`);
    assert.equal((await leer(refGoogle(OTRO_EMAIL))).status, 404);
  });

  test("404 si no existe, sin dar de alta al estudiante", async () => {
    const { leer, db } = setup();
    const res = await leer();
    assert.equal(res.status, 404);
    assert.deepEqual(res.body, { error: "no_encontrado" });
    assert.equal(db.tables.app_users.length, 0);
  });

  test("500 sin secreto y sin marcar la cuenta si la llave es otra", async () => {
    const original = setup();
    await original.guardar();
    const otra = setup({ key: crypto.randomBytes(32) });
    otra.db.tables.app_users = original.db.tables.app_users;
    otra.db.tables.student_credentials = original.db.tables.student_credentials;

    const res = await otra.leer();

    assert.equal(res.status, 500);
    assert.deepEqual(res.body, { error: "error_interno" });
    assert.equal(otra.db.tables.student_credentials[0].status, "active");
    assert.equal(JSON.parse(otra.logs.at(-1)).event, "credencial_no_descifrable");
  });

  test("una fila alterada o copiada a otro estudiante no se descifra", async () => {
    const { guardar, leer, db, logs } = setup();
    await guardar();
    await guardar({ ...refIvirtual(OTRO_EMAIL), secret: `${SECRETO}-otro` });
    const [mia, otra] = db.tables.student_credentials;

    otra.ciphertext = mia.ciphertext;
    otra.nonce = mia.nonce;
    otra.auth_tag = mia.auth_tag;
    const copiada = await leer(refIvirtual(OTRO_EMAIL));
    assert.equal(copiada.status, 500);
    assertSinSecreto(JSON.stringify(copiada.body));

    mia.ciphertext = `\\x00${mia.ciphertext.slice(4)}`;
    const alterada = await leer();
    assert.equal(alterada.status, 500);
    assertSinSecreto(JSON.stringify(alterada.body));
    assertSinSecreto(logs.join("\n"));
  });
});

describe("POST /internal/credentials/needs-relink", () => {
  test("marca la cuenta y después get responde 409 sin secreto", async () => {
    const { guardar, leer, marcar, db } = setup();
    await guardar();

    const res = await marcar({ ...refIvirtual(), reason: "credenciales" });
    assert.equal(res.status, 200);
    assert.deepEqual(res.body, { portal: "ivirtual", kind: "ivirtual_token", status: "needs_relink" });
    assert.equal(db.tables.student_credentials[0].status, "needs_relink");

    const get = await leer();
    assert.equal(get.status, 409);
    assert.deepEqual(get.body, { error: "requiere_revinculacion" });
    assertSinSecreto(JSON.stringify(get.body));
  });

  test("acepta los dos resultados del worker, y marcar dos veces no falla", async () => {
    const { guardar, marcar } = setup();
    await guardar();
    for (const reason of ["credenciales", "cambio_password", undefined]) {
      assert.equal((await marcar({ ...refIvirtual(), reason })).status, 200);
    }
  });

  test("400 con un motivo desconocido y 404 si no existe", async () => {
    const { guardar, marcar } = setup();
    assert.equal((await marcar()).status, 404);
    await guardar();
    const res = await marcar({ ...refIvirtual(), reason: "otro" });
    assert.equal(res.status, 400);
    assert.ok(res.body.detalles.some((d) => d.path === "reason"));
  });

  test("solo marca la credencial indicada", async () => {
    const { guardar, leer, marcar } = setup();
    await guardar();
    await guardar({ ...refGoogle(), secret: SECRETO_GOOGLE });
    await marcar(refIvirtual());
    assert.equal((await leer(refGoogle())).status, 200);
  });
});

describe("validación del body", () => {
  test("400 en cuerpos inválidos, sin tocar la base y sin devolver valores", async () => {
    const casos = {
      sin_user: (b) => delete b.user,
      sin_email: (b) => (b.user = {}),
      email_invalido: (b) => (b.user.email = SECRETO),
      sin_portal: (b) => delete b.portal,
      portal_desconocido: (b) => (b.portal = "otro"),
      sin_kind: (b) => delete b.kind,
      kind_desconocido: (b) => (b.kind = SECRETO),
      kind_de_otro_portal: (b) => (b.kind = "google_refresh_token"),
      // Solo existe en el esquema de la 007: la API aún no lo admite.
      password_de_ivirtual: (b) => (b.kind = "ivirtual_password"),
    };
    const { llamar, db } = setup();
    const rutas = [
      ["post", "/get", () => refIvirtual()],
      ["post", "/needs-relink", () => refIvirtual()],
    ];
    for (const [metodo, sufijo, base] of rutas) {
      for (const [nombre, romper] of Object.entries(casos)) {
        const body = structuredClone(base());
        romper(body);
        const res = await llamar(metodo, sufijo, body);
        assert.equal(res.status, 400, `${metodo} ${sufijo} ${nombre}`);
        assert.equal(res.body.error, "cuerpo_invalido", nombre);
        assertSinSecreto(JSON.stringify(res.body));
      }
    }
    assert.equal(db.calls.length, 0);
  });

  test("JSON mal formado responde 400 y su contenido no llega a respuesta ni logs", async () => {
    const { app, logs } = setup();
    const res = await request(app)
      .post(`${RUTA}/get`)
      .set("x-api-key", API_KEY)
      .set("Content-Type", "application/json")
      .send(`{"secret": "${SECRETO}"`);
    assert.equal(res.status, 400);
    assert.deepEqual(res.body, { error: "cuerpo_invalido" });
    assertSinSecreto(logs.join("\n"));
  });

  test("un body de más de 1 MB responde 413 sin copiarlo", async () => {
    const { llamar, logs } = setup();
    const res = await llamar("post", "/get", { ...refIvirtual(), secret: `${SECRETO}${"x".repeat(1024 * 1024)}` });
    assert.equal(res.status, 413);
    assert.deepEqual(res.body, { error: "cuerpo_demasiado_grande" });
    assertSinSecreto(logs.join("\n"));
  });
});

describe("fallas de Supabase", () => {
  test("500 sin el mensaje de Supabase en la respuesta ni en los logs", async () => {
    const { guardar, leer, marcar, db, logs } = setup();
    await guardar();

    const casos = [
      ["app_users", "select", () => leer(), "credencial_no_leida"],
      ["student_credentials", "select", () => leer(), "credencial_no_leida"],
      ["student_credentials", "update", () => marcar(), "credencial_no_marcada"],
    ];
    for (const [tabla, op, accion, evento] of casos) {
      db.failNext(tabla, op);
      const res = await accion();
      assert.equal(res.status, 500, `${tabla} ${op}`);
      assert.deepEqual(res.body, { error: "error_interno" });

      const linea = JSON.parse(logs.at(-1));
      assert.equal(linea.event, evento);
      assert.equal(linea.step, tabla);
      assert.equal(linea.error_code, "XX000");
    }
    const todo = logs.join("\n");
    assert.ok(!todo.includes("fallo simulado"));
    assertSinSecreto(todo);
  });
});

describe("privacidad de los logs", () => {
  test("ningún flujo registra el secreto, el correo ni el body", async () => {
    const { app, llamar, guardar, leer, marcar, db, logs } = setup();

    await guardar();
    await guardar({ ...refGoogle(), secret: SECRETO_GOOGLE });
    await leer();
    await marcar({ ...refIvirtual(), reason: "cambio_password" });
    await leer();
    await leer({ user: { email: SECRETO }, portal: SECRETO, kind: SECRETO });
    await marcar({ user: { email: SECRETO }, portal: SECRETO, kind: SECRETO });
    await request(app).post(`${RUTA}/get`).set("x-api-key", API_KEY).set("Content-Type", "application/json").send(`{"secret":"${SECRETO}`);
    await request(app).post(`${RUTA}/get`).send({ ...refIvirtual(), secret: SECRETO });
    await llamar("put", "", { ...refIvirtual(), secret: SECRETO });
    await llamar("delete", "", refIvirtual());
    db.failNext("student_credentials", "select");
    await leer();
    db.tables.student_credentials[0].status = "active";
    db.tables.student_credentials[0].auth_tag = `\\x${"00".repeat(16)}`;
    await leer();
    await leer(refGoogle(OTRO_EMAIL));

    assert.ok(logs.length >= 8);
    const todo = logs.join("\n");
    assertSinSecreto(todo);
    assertSinSecreto(todo, SECRETO_GOOGLE);
    assert.ok(!todo.includes(EMAIL));
    for (const linea of logs) {
      const parsed = JSON.parse(linea);
      for (const prohibido of ["body", "email", "secret", "ciphertext", "nonce", "auth_tag"]) {
        assert.ok(!(prohibido in parsed), prohibido);
      }
    }
  });

  test("los eventos llevan solo campos seguros", async () => {
    const { guardar, leer, logs, db } = setup();
    await guardar();
    await leer();

    const leida = JSON.parse(logs.find((l) => l.includes("credencial_leida")));
    assert.deepEqual(
      { user_id: leida.user_id, portal: leida.portal, kind: leida.kind, key_version: leida.key_version },
      { user_id: db.tables.app_users[0].id, portal: "ivirtual", kind: "ivirtual_token", key_version: 1 },
    );
  });

  test("el logger descarta el secreto aunque alguien lo pase por error", () => {
    const logs = [];
    createLogger((l) => logs.push(l)).info("prueba", { secret: SECRETO, token: SECRETO, body: { secret: SECRETO } });
    assertSinSecreto(logs.join("\n"));
  });

  test("createApp exige la llave de credenciales y su error no la incluye", () => {
    const db = createFakeSupabase();
    assert.throws(
      () => createApp({ config: { internalApiKey: API_KEY }, supabase: db.client }),
      { message: "createApp requiere config.credentialsEncryptionKey" },
    );
  });
});
