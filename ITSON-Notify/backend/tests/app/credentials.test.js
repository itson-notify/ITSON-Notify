// ITN-36 - Pruebas de /internal/credentials con supertest y un Supabase simulado
// (tests/helpers/fakeSupabase.js). Secretos inventados y armados en tiempo de
// ejecución.
const { test, describe } = require("node:test");
const assert = require("node:assert/strict");
const crypto = require("crypto");
const request = require("supertest");

const { createApp } = require("../../src/app");
const { createLogger } = require("../../src/utils/logger");
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
  const app = createApp({
    config: { internalApiKey: API_KEY, credentialsEncryptionKey: key },
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
    guardar: (body = { ...refIvirtual(), secret: SECRETO }, apiKey) => llamar("put", "", body, apiKey),
    leer: (body = refIvirtual(), apiKey) => llamar("post", "/get", body, apiKey),
    marcar: (body = refIvirtual(), apiKey) => llamar("post", "/needs-relink", body, apiKey),
    borrar: (body = refIvirtual(), apiKey) => llamar("delete", "", body, apiKey),
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

describe("PUT /internal/credentials", () => {
  test("guarda cifrado y responde solo portal, kind y status", async () => {
    const { guardar, db } = setup();
    const res = await guardar();

    assert.equal(res.status, 200);
    assert.deepEqual(res.body, { portal: "ivirtual", kind: "ivirtual_token", status: "active" });
    assert.equal(res.headers["cache-control"], "no-store");
    assertSinSecreto(JSON.stringify(res.body));

    assert.equal(db.tables.student_credentials.length, 1);
    const fila = db.tables.student_credentials[0];
    assert.equal(fila.user_id, db.tables.app_users[0].id);
    assert.equal(fila.key_version, 1);
    assert.equal(fila.status, "active");
    assert.match(fila.nonce, /^\\x[0-9a-f]{24}$/);
    assert.match(fila.auth_tag, /^\\x[0-9a-f]{32}$/);
  });

  test("la fila no contiene el secreto en claro ni codificado", async () => {
    const { guardar, db } = setup();
    await guardar();
    const fila = db.tables.student_credentials[0];
    assertSinSecreto(JSON.stringify(fila));
    const cifrado = Buffer.from(fila.ciphertext.slice(2), "hex");
    assert.ok(!cifrado.includes(Buffer.from(SECRETO)));
    assert.ok(!Object.keys(fila).includes("secret"));
  });

  test("da de alta al estudiante nuevo y normaliza el correo", async () => {
    const { guardar, leer, db } = setup();
    await guardar({ ...refIvirtual(`  ${EMAIL.toUpperCase()} `), secret: SECRETO });
    assert.equal(db.tables.app_users[0].email, EMAIL);
    const res = await leer();
    assert.equal(res.body.secret, SECRETO);
  });

  test("guarda el secreto tal cual, sin recortarlo", async () => {
    const { guardar, leer } = setup();
    const conEspacios = `  ${SECRETO}  `;
    await guardar({ ...refIvirtual(), secret: conEspacios });
    assert.equal((await leer()).body.secret, conEspacios);
  });

  test("volver a guardar reemplaza el secreto, con otro nonce, y reactiva la cuenta", async () => {
    const { guardar, leer, marcar, db } = setup();
    await guardar();
    const nonceAnterior = db.tables.student_credentials[0].nonce;
    await marcar();

    const nuevo = `${SECRETO}-nuevo`;
    const res = await guardar({ ...refIvirtual(), secret: nuevo });

    assert.equal(res.body.status, "active");
    assert.equal(db.tables.student_credentials.length, 1);
    assert.notEqual(db.tables.student_credentials[0].nonce, nonceAnterior);
    assert.equal((await leer()).body.secret, nuevo);
  });
});

describe("POST /internal/credentials/get", () => {
  test("devuelve lo guardado, sin cache", async () => {
    const { guardar, leer } = setup();
    await guardar();
    const res = await leer();
    assert.equal(res.status, 200);
    assert.deepEqual(res.body, { portal: "ivirtual", kind: "ivirtual_token", secret: SECRETO });
    assert.equal(res.headers["cache-control"], "no-store");
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

describe("DELETE /internal/credentials", () => {
  test("borra el registro: después get responde 404 y el estudiante sigue existiendo", async () => {
    const { guardar, leer, borrar, db } = setup();
    await guardar();

    const res = await borrar();
    assert.equal(res.status, 200);
    assert.deepEqual(res.body, { portal: "ivirtual", kind: "ivirtual_token", status: "borrada" });
    assert.equal(db.tables.student_credentials.length, 0);
    assert.equal(db.tables.app_users.length, 1);
    assert.equal((await leer()).status, 404);
  });

  test("404 si no existe", async () => {
    const { guardar, borrar } = setup();
    assert.deepEqual((await borrar()).body, { error: "no_encontrado" });
    await guardar();
    assert.equal((await borrar(refGoogle())).status, 404);
  });

  test("400 sin body", async () => {
    const { app } = setup();
    const res = await request(app).delete(RUTA).set("x-api-key", API_KEY);
    assert.equal(res.status, 400);
    assert.equal(res.body.error, "cuerpo_invalido");
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
      ["put", "", () => ({ ...refIvirtual(), secret: SECRETO })],
      ["post", "/get", () => refIvirtual()],
      ["post", "/needs-relink", () => refIvirtual()],
      ["delete", "", () => refIvirtual()],
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

  test("400 si el secreto falta, está vacío, no es texto o es demasiado largo", async () => {
    const { guardar, db } = setup();
    const invalidos = [undefined, "", "   ", null, 123, { valor: SECRETO }, "x".repeat(4097)];
    for (const secret of invalidos) {
      const res = await guardar({ ...refIvirtual(), secret });
      assert.equal(res.status, 400);
      assert.ok(res.body.detalles.some((d) => d.path === "secret"));
      assertSinSecreto(JSON.stringify(res.body));
    }
    assert.equal(db.calls.length, 0);
  });

  test("JSON mal formado responde 400 y su contenido no llega a respuesta ni logs", async () => {
    const { app, logs } = setup();
    const res = await request(app)
      .put(RUTA)
      .set("x-api-key", API_KEY)
      .set("Content-Type", "application/json")
      .send(`{"secret": "${SECRETO}"`);
    assert.equal(res.status, 400);
    assert.deepEqual(res.body, { error: "cuerpo_invalido" });
    assertSinSecreto(logs.join("\n"));
  });

  test("un body de más de 1 MB responde 413 sin copiarlo", async () => {
    const { guardar, logs } = setup();
    const res = await guardar({ ...refIvirtual(), secret: `${SECRETO}${"x".repeat(1024 * 1024)}` });
    assert.equal(res.status, 413);
    assert.deepEqual(res.body, { error: "cuerpo_demasiado_grande" });
    assertSinSecreto(logs.join("\n"));
  });
});

describe("fallas de Supabase", () => {
  test("500 sin el mensaje de Supabase en la respuesta ni en los logs", async () => {
    const { guardar, leer, marcar, borrar, db, logs } = setup();
    await guardar();

    const casos = [
      ["app_users", "upsert", () => guardar(), "credencial_no_guardada"],
      ["student_credentials", "upsert", () => guardar(), "credencial_no_guardada"],
      ["app_users", "select", () => leer(), "credencial_no_leida"],
      ["student_credentials", "select", () => leer(), "credencial_no_leida"],
      ["student_credentials", "update", () => marcar(), "credencial_no_marcada"],
      ["student_credentials", "delete", () => borrar(), "credencial_no_borrada"],
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
    const { app, guardar, leer, marcar, borrar, db, logs } = setup();

    await guardar();
    await guardar({ ...refGoogle(), secret: SECRETO_GOOGLE });
    await leer();
    await marcar({ ...refIvirtual(), reason: "cambio_password" });
    await leer();
    await guardar({ ...refIvirtual(), kind: "ivirtual_password", secret: SECRETO });
    await guardar({ user: { email: SECRETO }, portal: SECRETO, kind: SECRETO, secret: SECRETO });
    await request(app).put(RUTA).set("x-api-key", API_KEY).set("Content-Type", "application/json").send(`{"secret":"${SECRETO}`);
    await request(app).put(RUTA).send({ ...refIvirtual(), secret: SECRETO });
    db.failNext("student_credentials", "upsert");
    await guardar();
    db.tables.student_credentials[0].auth_tag = `\\x${"00".repeat(16)}`;
    await guardar();
    await borrar();
    await leer();

    assert.ok(logs.length >= 10);
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

    const guardada = JSON.parse(logs.find((l) => l.includes("credencial_guardada")));
    assert.deepEqual(
      { user_id: guardada.user_id, portal: guardada.portal, kind: guardada.kind, key_version: guardada.key_version },
      { user_id: db.tables.app_users[0].id, portal: "ivirtual", kind: "ivirtual_token", key_version: 1 },
    );
    assert.ok(logs.some((l) => JSON.parse(l).event === "credencial_leida"));
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
