// ITN-36 - Cifrado de las credenciales de los estudiantes con AES-256-GCM.
//
// Cada cifrado usa un nonce aleatorio de 12 bytes. El AAD (`user_id:portal:kind`)
// amarra el ciphertext a su fila: copiarlo a otro estudiante o tipo hace que falle
// la autenticación. Las llaves salen de la config, en un mapa versión -> llave,
// para poder rotarlas: se cifra con la versión actual y se descifra con la de la
// fila. Los errores nunca llevan el texto, la llave ni el ciphertext.
const crypto = require("crypto");
const { CredentialDecryptError } = require("../utils/errors");

const ALGORITHM = "aes-256-gcm";
const KEY_BYTES = 32;
const NONCE_BYTES = 12;
// Se fija el largo del tag: sin esto, GCM también aceptaría tags truncados, que
// son más fáciles de falsificar.
const TAG_BYTES = 16;

const CURRENT_KEY_VERSION = 1;

function aadFor({ userId, portal, kind }) {
  for (const parte of [userId, portal, kind]) {
    if (typeof parte !== "string" || parte === "") {
      throw new TypeError("El contexto de la credencial requiere userId, portal y kind");
    }
  }
  return Buffer.from(`${userId}:${portal}:${kind}`, "utf8");
}

// keys: { [keyVersion]: Buffer de 32 bytes }.
function createCredentialCrypto({ keys, currentVersion = CURRENT_KEY_VERSION }) {
  const llaves = new Map(Object.entries(keys ?? {}).map(([version, key]) => [Number(version), key]));
  for (const key of llaves.values()) {
    if (!Buffer.isBuffer(key) || key.length !== KEY_BYTES) {
      throw new Error(`Las llaves de credenciales deben medir ${KEY_BYTES} bytes`);
    }
  }
  if (!llaves.has(currentVersion)) {
    throw new Error("Falta la llave de la versión actual de credenciales");
  }

  // Devuelve { ciphertext, nonce, authTag, keyVersion }, los tres primeros en Buffer.
  function encryptSecret(plaintext, context) {
    if (typeof plaintext !== "string" || plaintext === "") {
      throw new TypeError("El secreto debe ser un texto no vacío");
    }
    const aad = aadFor(context);
    const nonce = crypto.randomBytes(NONCE_BYTES);
    const cipher = crypto.createCipheriv(ALGORITHM, llaves.get(currentVersion), nonce, {
      authTagLength: TAG_BYTES,
    });
    cipher.setAAD(aad);
    const ciphertext = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
    return { ciphertext, nonce, authTag: cipher.getAuthTag(), keyVersion: currentVersion };
  }

  // Cualquier falla (dato alterado, otro contexto, llave incorrecta o versión
  // desconocida) lanza el mismo error, sin la causa original.
  function decryptSecret(record, context) {
    try {
      const { ciphertext, nonce, authTag, keyVersion } = record;
      const decipher = crypto.createDecipheriv(ALGORITHM, llaves.get(keyVersion), nonce, {
        authTagLength: TAG_BYTES,
      });
      decipher.setAAD(aadFor(context));
      decipher.setAuthTag(authTag);
      return Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString("utf8");
    } catch {
      throw new CredentialDecryptError();
    }
  }

  return { encryptSecret, decryptSecret };
}

// Hoy solo existe la v1. Para rotar, agrega aquí la llave nueva y sube
// CURRENT_KEY_VERSION (procedimiento en backend/README.md).
function credentialCryptoFromConfig(config) {
  return createCredentialCrypto({ keys: { [CURRENT_KEY_VERSION]: config.credentialsEncryptionKey } });
}

module.exports = { createCredentialCrypto, credentialCryptoFromConfig, CURRENT_KEY_VERSION };
