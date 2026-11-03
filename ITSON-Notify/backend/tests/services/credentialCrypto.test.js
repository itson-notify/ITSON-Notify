// ITN-36 - Pruebas del cifrado de credenciales. Llaves y secretos inventados y
// generados en tiempo de ejecución.
const { test, describe } = require("node:test");
const assert = require("node:assert/strict");
const crypto = require("crypto");

const { createCredentialCrypto, credentialCryptoFromConfig } = require("../../src/services/credentialCrypto");
const { CredentialDecryptError } = require("../../src/utils/errors");

const SECRETO = ["token", "de", "prueba", "á".repeat(8), "a".repeat(32)].join("-");
const CONTEXTO = { userId: "11111111-1111-4111-8111-111111111111", portal: "ivirtual", kind: "ivirtual_token" };

const nuevaLlave = () => crypto.randomBytes(32);
const nuevoCifrador = (llave = nuevaLlave()) => createCredentialCrypto({ keys: { 1: llave } });

// Invierte un bit: el dato sigue midiendo lo mismo.
function alterar(buffer) {
  const copia = Buffer.from(buffer);
  copia[0] ^= 0x01;
  return copia;
}

function assertFallaSinFiltrar(fn, record, llave) {
  assert.throws(fn, (error) => {
    assert.ok(error instanceof CredentialDecryptError);
    assert.equal(error.message, "No se pudo descifrar la credencial");
    assert.equal(error.cause, undefined);
    const texto = `${error.message} ${error.stack} ${JSON.stringify(error)}`;
    assert.ok(!texto.includes(SECRETO));
    assert.ok(!texto.includes(record.ciphertext.toString("hex")));
    assert.ok(!texto.includes(record.ciphertext.toString("base64")));
    if (llave) assert.ok(!texto.includes(llave.toString("base64")));
    return true;
  });
}

describe("encryptSecret y decryptSecret", () => {
  test("ida y vuelta, también con acentos", () => {
    const { encryptSecret, decryptSecret } = nuevoCifrador();
    const record = encryptSecret(SECRETO, CONTEXTO);
    assert.equal(decryptSecret(record, CONTEXTO), SECRETO);
  });

  test("devuelve las partes con los largos y la versión esperados, sin texto en claro", () => {
    const record = nuevoCifrador().encryptSecret(SECRETO, CONTEXTO);
    assert.deepEqual(Object.keys(record).sort(), ["authTag", "ciphertext", "keyVersion", "nonce"]);
    assert.equal(record.nonce.length, 12);
    assert.equal(record.authTag.length, 16);
    assert.equal(record.keyVersion, 1);
    assert.ok(!record.ciphertext.includes(Buffer.from(SECRETO, "utf8")));
  });

  test("cada cifrado del mismo texto usa un nonce distinto", () => {
    const { encryptSecret } = nuevoCifrador();
    const nonces = new Set();
    const ciphertexts = new Set();
    for (let i = 0; i < 500; i += 1) {
      const record = encryptSecret(SECRETO, CONTEXTO);
      nonces.add(record.nonce.toString("hex"));
      ciphertexts.add(record.ciphertext.toString("hex"));
    }
    assert.equal(nonces.size, 500);
    assert.equal(ciphertexts.size, 500);
  });

  test("falla si se altera el ciphertext, el nonce o el tag", () => {
    const { encryptSecret, decryptSecret } = nuevoCifrador();
    const record = encryptSecret(SECRETO, CONTEXTO);
    for (const campo of ["ciphertext", "nonce", "authTag"]) {
      const alterado = { ...record, [campo]: alterar(record[campo]) };
      assertFallaSinFiltrar(() => decryptSecret(alterado, CONTEXTO), record);
    }
  });

  test("falla con un tag truncado o un nonce de otro largo", () => {
    const { encryptSecret, decryptSecret } = nuevoCifrador();
    const record = encryptSecret(SECRETO, CONTEXTO);
    for (const tag of [record.authTag.subarray(0, 4), record.authTag.subarray(0, 12), Buffer.alloc(0)]) {
      assertFallaSinFiltrar(() => decryptSecret({ ...record, authTag: tag }, CONTEXTO), record);
    }
    assertFallaSinFiltrar(() => decryptSecret({ ...record, nonce: record.nonce.subarray(0, 8) }, CONTEXTO), record);
  });

  test("falla si cambia el AAD: otro user_id, portal o kind", () => {
    const { encryptSecret, decryptSecret } = nuevoCifrador();
    const record = encryptSecret(SECRETO, CONTEXTO);
    const otros = [
      { ...CONTEXTO, userId: "22222222-2222-4222-8222-222222222222" },
      { ...CONTEXTO, portal: "google_classroom" },
      { ...CONTEXTO, kind: "ivirtual_password" },
    ];
    for (const otro of otros) {
      assertFallaSinFiltrar(() => decryptSecret(record, otro), record);
    }
  });

  test("falla con la llave incorrecta y el error no la revela", () => {
    const record = nuevoCifrador().encryptSecret(SECRETO, CONTEXTO);
    const otraLlave = nuevaLlave();
    assertFallaSinFiltrar(() => nuevoCifrador(otraLlave).decryptSecret(record, CONTEXTO), record, otraLlave);
  });

  test("falla con un registro incompleto", () => {
    const { encryptSecret, decryptSecret } = nuevoCifrador();
    const record = encryptSecret(SECRETO, CONTEXTO);
    for (const campo of ["ciphertext", "nonce", "authTag"]) {
      assertFallaSinFiltrar(() => decryptSecret({ ...record, [campo]: undefined }, CONTEXTO), record);
    }
    assert.throws(() => decryptSecret(null, CONTEXTO), CredentialDecryptError);
  });

  test("rechaza un secreto vacío o que no sea texto, y un contexto incompleto", () => {
    const { encryptSecret } = nuevoCifrador();
    for (const invalido of ["", null, undefined, 123, Buffer.from("x")]) {
      assert.throws(() => encryptSecret(invalido, CONTEXTO), TypeError);
    }
    for (const campo of ["userId", "portal", "kind"]) {
      assert.throws(() => encryptSecret(SECRETO, { ...CONTEXTO, [campo]: "" }), TypeError);
    }
  });
});

describe("versiones de llave", () => {
  test("cifra con la versión actual y descifra filas de una versión anterior", () => {
    const v1 = nuevaLlave();
    const v2 = nuevaLlave();
    const antiguo = createCredentialCrypto({ keys: { 1: v1 } }).encryptSecret(SECRETO, CONTEXTO);

    const rotado = createCredentialCrypto({ keys: { 1: v1, 2: v2 }, currentVersion: 2 });
    assert.equal(rotado.decryptSecret(antiguo, CONTEXTO), SECRETO);

    const nuevo = rotado.encryptSecret(SECRETO, CONTEXTO);
    assert.equal(nuevo.keyVersion, 2);
    assert.equal(createCredentialCrypto({ keys: { 2: v2 }, currentVersion: 2 }).decryptSecret(nuevo, CONTEXTO), SECRETO);
  });

  test("una key_version desconocida falla con el mismo error", () => {
    const { encryptSecret, decryptSecret } = nuevoCifrador();
    const record = encryptSecret(SECRETO, CONTEXTO);
    assertFallaSinFiltrar(() => decryptSecret({ ...record, keyVersion: 99 }, CONTEXTO), record);
  });

  test("no se crea sin llaves válidas y el error no las incluye", () => {
    const corta = crypto.randomBytes(16);
    for (const keys of [undefined, {}, { 1: corta }, { 1: "texto" }, { 2: nuevaLlave() }]) {
      assert.throws(
        () => createCredentialCrypto({ keys }),
        (error) => {
          assert.ok(!error.message.includes(corta.toString("base64")));
          return true;
        },
      );
    }
  });

  test("credentialCryptoFromConfig toma la llave de la config como v1", () => {
    const llave = nuevaLlave();
    const record = credentialCryptoFromConfig({ credentialsEncryptionKey: llave }).encryptSecret(SECRETO, CONTEXTO);
    assert.equal(record.keyVersion, 1);
    assert.equal(nuevoCifrador(llave).decryptSecret(record, CONTEXTO), SECRETO);
    assert.throws(() => credentialCryptoFromConfig({}));
  });
});
