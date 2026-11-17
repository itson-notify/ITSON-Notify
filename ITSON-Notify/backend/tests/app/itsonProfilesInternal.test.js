// ITN-55 - GET /internal/itson-profiles/active con supertest y el Supabase
// simulado. Datos inventados.
// Usa su propia credencial (ITSON_PROFILES_API_KEY / config.itsonProfilesApiKey),
// distinta de INTERNAL_API_KEY.
const { test, describe } = require("node:test");
const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const request = require("supertest");

const { createApp } = require("../../src/app");
const { createLogger } = require("../../src/utils/logger");
const { credentialCryptoFromConfig } = require("../../src/services/credentialCrypto");
const { createItsonProfileRepository } = require("../../src/repositories/itsonProfileRepository");
const { createItsonProfileService } = require("../../src/services/itsonProfileService");
const { createFakeSupabase } = require("../helpers/fakeSupabase");
const { API_KEY, OTRA_API_KEY, PROFILES_API_KEY, CREDENTIALS_KEY, payload } = require("../helpers/payloads");

const RUTA = "/internal/itson-profiles/active";
const A = { userId: crypto.randomUUID(), email: "b.prueba123456@potros.itson.edu.mx", matricula: "00000123456", career: "INSOF" };
const B = { userId: crypto.randomUUID(), email: "a.prueba654321@potros.itson.edu.mx", matricula: "00000654321", career: "LCE" };
const SIN_PERFIL = { userId: crypto.randomUUID(), email: "c.prueba111111@potros.itson.edu.mx" };

function setup({ key = CREDENTIALS_KEY, profilesKey = PROFILES_API_KEY } = {}) {
  const db = createFakeSupabase();
  const logs = [];
  const config = {
    internalApiKey: API_KEY,
    itsonProfilesApiKey: profilesKey,
    credentialsEncryptionKey: key,
  };
  const service = createItsonProfileService({
    repo: createItsonProfileRepository(db.client),
    crypto: credentialCryptoFromConfig(config),
  });
  for (const u of [A, B, SIN_PERFIL]) db.tables.app_users.push({ id: u.userId, email: u.email });
  const sembrar = (u) => service.saveForUser(u);
  const app = createApp({ config, supabase: db.client, logger: createLogger((line) => logs.push(line)), channels: [] });
  const pedir = (llave = PROFILES_API_KEY) => request(app).get(RUTA).set("x-api-key", llave);
  return { db, logs, app, sembrar, pedir };
}

describe("GET /internal/itson-profiles/active", () => {
  test("401 sin llave, con otra llave o con la INTERNAL_API_KEY general, sin tocar la base", async () => {
    const { app, pedir, db } = setup();
    for (const intento of [
      () => request(app).get(RUTA),
      () => pedir(""),
      () => pedir(OTRA_API_KEY),
      () => pedir("otra-llave-de-distinto-largo"),
      () => pedir(API_KEY), // la llave general no puede leer matrículas
    ]) {
      const res = await intento();
      assert.equal(res.status, 401);
      assert.deepEqual(res.body, { error: "no_autorizado" });
    }
    assert.equal(db.calls.length, 0);
  });

  test("la credencial de perfiles no abre ninguna de las demás rutas internas", async () => {
    const { app, db } = setup();
    const rutasGenerales = [
      () => request(app).post("/internal/grade-snapshots").set("x-api-key", PROFILES_API_KEY).send(payload()),
      () => request(app).get("/internal/credentials/active?portal=ivirtual").set("x-api-key", PROFILES_API_KEY),
      () =>
        request(app)
          .post("/internal/credentials/get")
          .set("x-api-key", PROFILES_API_KEY)
          .send({ user: { email: A.email }, portal: "ivirtual", kind: "ivirtual_token" }),
      () =>
        request(app)
          .post("/internal/credentials/needs-relink")
          .set("x-api-key", PROFILES_API_KEY)
          .send({ user: { email: A.email }, portal: "ivirtual", kind: "ivirtual_token", reason: "credenciales" }),
    ];
    for (const llamar of rutasGenerales) {
      const res = await llamar();
      assert.equal(res.status, 401);
      assert.deepEqual(res.body, { error: "no_autorizado" });
    }
    assert.equal(db.calls.length, 0);
  });

  test("sin itsonProfilesApiKey configurada, la ruta falla cerrado con 401", async () => {
    const { app, pedir, db } = setup({ profilesKey: null });
    assert.equal((await request(app).get(RUTA)).status, 401);
    assert.equal((await pedir(API_KEY)).status, 401);
    assert.equal((await pedir(PROFILES_API_KEY)).status, 401);
    assert.equal(db.calls.length, 0);
  });

  test("createApp rechaza una itsonProfilesApiKey corta o igual a internalApiKey sin citar su valor", () => {
    const db = createFakeSupabase();
    for (const mala of ["llave-corta-secreta", API_KEY]) {
      assert.throws(
        () =>
          createApp({
            config: {
              internalApiKey: API_KEY,
              itsonProfilesApiKey: mala,
              credentialsEncryptionKey: CREDENTIALS_KEY,
            },
            supabase: db.client,
          }),
        (error) => {
          assert.ok(!error.message.includes(mala));
          return true;
        },
      );
    }
  });

  test("lista solo alumnos con perfil, ordenados por correo, con la matrícula descifrada", async () => {
    const { sembrar, pedir } = setup();
    await sembrar(A);
    await sembrar(B);
    const res = await pedir();
    assert.equal(res.status, 200);
    assert.equal(res.headers["cache-control"], "no-store");
    assert.deepEqual(res.body, {
      students: [
        { email: B.email, matricula: B.matricula, career: B.career },
        { email: A.email, matricula: A.matricula, career: A.career },
      ],
    });
  });

  test("sin perfiles: lista vacía", async () => {
    const { pedir } = setup();
    const res = await pedir();
    assert.equal(res.status, 200);
    assert.deepEqual(res.body, { students: [] });
  });

  test("el log solo lleva el conteo: ni correos, ni matrículas, ni carreras, ni llaves", async () => {
    const { sembrar, pedir, logs } = setup();
    await sembrar(A);
    await pedir();
    await pedir(API_KEY);
    const texto = logs.join("\n");
    assert.match(texto, /perfiles_itson_listados/);
    assert.match(texto, /"count":1/);
    for (const dato of [A.email, A.matricula, "123456", A.career, PROFILES_API_KEY, API_KEY]) {
      assert.ok(!texto.includes(dato));
    }
  });

  test("un perfil que no se descifra se omite y los demás salen", async () => {
    const { sembrar, pedir, db, logs } = setup();
    await sembrar(A);
    await sembrar(B);
    // Copia el cifrado de B a A: el AAD es de otro user_id y no se descifra.
    const fa = db.tables.student_itson_profiles.find((p) => p.user_id === A.userId);
    const fb = db.tables.student_itson_profiles.find((p) => p.user_id === B.userId);
    Object.assign(fa, { matricula_ciphertext: fb.matricula_ciphertext, matricula_nonce: fb.matricula_nonce, matricula_auth_tag: fb.matricula_auth_tag });
    const res = await pedir();
    assert.equal(res.status, 200);
    assert.deepEqual(res.body.students.map((s) => s.email), [B.email]);
    assert.match(logs.join("\n"), /perfil_itson_no_descifrable/);
  });

  test("si ninguno se descifra (llave equivocada): 500, no una lista vacía", async () => {
    const otra = setup();
    await otra.sembrar(A);
    const conOtraLlave = setup({ key: crypto.randomBytes(32) });
    conOtraLlave.db.tables.student_itson_profiles.push(...otra.db.tables.student_itson_profiles);
    const res = await conOtraLlave.pedir();
    assert.equal(res.status, 500);
    assert.deepEqual(res.body, { error: "error_interno" });
  });

  test("no hay escrituras: PUT, POST y DELETE responden 404 con la llave de perfiles y 401 con la general", async () => {
    const { app } = setup();
    for (const metodo of ["put", "post", "delete"]) {
      const conPerfiles = await request(app)[metodo](RUTA).set("x-api-key", PROFILES_API_KEY).send({});
      assert.equal(conPerfiles.status, 404);
      const conGeneral = await request(app)[metodo](RUTA).set("x-api-key", API_KEY).send({});
      assert.equal(conGeneral.status, 401);
    }
  });
});
