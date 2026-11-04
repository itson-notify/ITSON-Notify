// ITN-36 - Repositorio de student_credentials sobre el Supabase simulado. Datos
// inventados.
const { test, describe, beforeEach } = require("node:test");
const assert = require("node:assert/strict");
const crypto = require("crypto");

const { createCredentialRepository } = require("../../src/repositories/credentialRepository");
const { PersistenceError } = require("../../src/utils/errors");
const { createFakeSupabase } = require("../helpers/fakeSupabase");

const AHORA = "2026-11-03T12:00:00.000Z";
const DESPUES = "2026-11-03T13:00:00.000Z";

const cifrado = () => ({
  ciphertext: crypto.randomBytes(40),
  nonce: crypto.randomBytes(12),
  authTag: crypto.randomBytes(16),
  keyVersion: 1,
});

describe("credentialRepository", () => {
  let db;
  let repo;
  let ref;

  beforeEach(async () => {
    db = createFakeSupabase();
    repo = createCredentialRepository(db.client);
    const userId = await repo.ensureUser("alumna.prueba@example.test");
    ref = { userId, portal: "ivirtual", kind: "ivirtual_token" };
  });

  test("guarda los bytea como texto \\x y los devuelve como los mismos Buffer", async () => {
    const datos = cifrado();
    const guardada = await repo.saveCredential({ ...ref, ...datos }, AHORA);
    assert.deepEqual(guardada, { portal: "ivirtual", kind: "ivirtual_token", status: "active", key_version: 1 });

    const fila = db.tables.student_credentials[0];
    assert.equal(fila.ciphertext, `\\x${datos.ciphertext.toString("hex")}`);
    assert.equal(fila.nonce, `\\x${datos.nonce.toString("hex")}`);
    assert.equal(fila.auth_tag, `\\x${datos.authTag.toString("hex")}`);
    assert.equal(fila.updated_at, AHORA);

    const leida = await repo.getCredential(ref);
    assert.ok(leida.ciphertext.equals(datos.ciphertext));
    assert.ok(leida.nonce.equals(datos.nonce));
    assert.ok(leida.authTag.equals(datos.authTag));
    assert.equal(leida.keyVersion, 1);
    assert.equal(leida.status, "active");
  });

  test("guardar otra vez reemplaza la misma fila, reactiva la cuenta y conserva el id", async () => {
    await repo.saveCredential({ ...ref, ...cifrado() }, AHORA);
    const { id } = db.tables.student_credentials[0];
    await repo.markNeedsRelink(ref, AHORA);
    db.tables.student_credentials[0].last_validated_at = AHORA;

    const nuevo = cifrado();
    const guardada = await repo.saveCredential({ ...ref, ...nuevo }, DESPUES);

    assert.equal(guardada.status, "active");
    assert.equal(db.tables.student_credentials.length, 1);
    const fila = db.tables.student_credentials[0];
    assert.equal(fila.id, id);
    assert.equal(fila.last_validated_at, null);
    assert.equal(fila.updated_at, DESPUES);
    assert.equal(fila.ciphertext, `\\x${nuevo.ciphertext.toString("hex")}`);
  });

  test("un kind distinto del mismo estudiante es otra fila", async () => {
    await repo.saveCredential({ ...ref, ...cifrado() }, AHORA);
    await repo.saveCredential({ ...ref, portal: "google_classroom", kind: "google_refresh_token", ...cifrado() }, AHORA);
    assert.equal(db.tables.student_credentials.length, 2);
  });

  test("getCredential, markNeedsRelink y deleteCredential avisan si no existe", async () => {
    assert.equal(await repo.getCredential(ref), null);
    assert.equal(await repo.markNeedsRelink(ref, AHORA), null);
    assert.equal(await repo.deleteCredential(ref), false);
  });

  test("markNeedsRelink cambia solo esa credencial y actualiza updated_at", async () => {
    const otraRef = { ...ref, portal: "google_classroom", kind: "google_refresh_token" };
    await repo.saveCredential({ ...ref, ...cifrado() }, AHORA);
    await repo.saveCredential({ ...otraRef, ...cifrado() }, AHORA);

    const marcada = await repo.markNeedsRelink(ref, DESPUES);

    assert.deepEqual(marcada, { portal: "ivirtual", kind: "ivirtual_token", status: "needs_relink" });
    assert.equal((await repo.getCredential(ref)).status, "needs_relink");
    assert.equal((await repo.getCredential(otraRef)).status, "active");
    assert.equal(db.tables.student_credentials.find((c) => c.portal === "ivirtual").updated_at, DESPUES);
  });

  test("deleteCredential borra solo esa credencial", async () => {
    const otraRef = { ...ref, portal: "google_classroom", kind: "google_refresh_token" };
    await repo.saveCredential({ ...ref, ...cifrado() }, AHORA);
    await repo.saveCredential({ ...otraRef, ...cifrado() }, AHORA);

    assert.equal(await repo.deleteCredential(ref), true);
    assert.equal(await repo.getCredential(ref), null);
    assert.ok(await repo.getCredential(otraRef));
  });

  test("findUserIdByEmail no da de alta a nadie", async () => {
    assert.equal(await repo.findUserIdByEmail("nadie@example.test"), null);
    assert.equal(db.tables.app_users.length, 1);
    assert.equal(await repo.findUserIdByEmail("alumna.prueba@example.test"), ref.userId);
  });

  test("los errores no copian el mensaje de Supabase", async () => {
    db.failNext("student_credentials", "upsert", "XX000");
    await assert.rejects(
      () => repo.saveCredential({ ...ref, ...cifrado() }, AHORA),
      (error) => {
        assert.ok(error instanceof PersistenceError);
        assert.equal(error.step, "student_credentials");
        assert.equal(error.code, "XX000");
        assert.ok(!error.message.includes("fallo simulado"));
        return true;
      },
    );
  });

  test("un bytea leído en otro formato lanza PersistenceError sin el valor", async () => {
    await repo.saveCredential({ ...ref, ...cifrado() }, AHORA);
    const raro = "valor-en-otro-formato";
    db.tables.student_credentials[0].ciphertext = raro;
    await assert.rejects(
      () => repo.getCredential(ref),
      (error) => {
        assert.ok(error instanceof PersistenceError);
        assert.equal(error.code, "bytea_invalido");
        assert.ok(!error.message.includes(raro));
        return true;
      },
    );
  });
});
