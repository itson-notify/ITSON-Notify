// ITN-36 - Orquesta cifrar y guardar, leer y descifrar. El texto plano solo existe en
// memoria durante estas funciones: readSecret lo entrega a la ruta para responder al
// worker, y nada aquí lo guarda ni lo loguea.
const { CredentialNotFoundError, CredentialNeedsRelinkError } = require("../utils/errors");

function createCredentialService({ repo, crypto, now = () => Date.now() }) {
  const ahora = () => new Date(now()).toISOString();

  async function buscarUsuario(email) {
    const userId = await repo.findUserIdByEmail(email);
    if (!userId) throw new CredentialNotFoundError();
    return userId;
  }

  // ITN-51 - Guarda el secreto del alumno de la sesión. El usuario ya existe en
  // app_users porque la sesión de Google lo creó.
  // Devuelve { userId, portal, kind, status, keyVersion }, sin datos cifrados.
  async function saveSecretForUser({ userId, portal, kind, secret }) {
    const cifrado = crypto.encryptSecret(secret, { userId, portal, kind });
    const saved = await repo.saveCredential({ userId, portal, kind, ...cifrado }, ahora());
    return { userId, portal, kind, status: saved.status, keyVersion: saved.key_version };
  }

  // Devuelve { userId, keyVersion, secret }. Una credencial en needs_relink no se
  // descifra: así el worker deja de reintentar contra el portal.
  async function readSecret({ email, portal, kind }) {
    const userId = await buscarUsuario(email);
    const record = await repo.getCredential({ userId, portal, kind });
    if (!record) throw new CredentialNotFoundError();
    if (record.status !== "active") throw new CredentialNeedsRelinkError();
    const secret = crypto.decryptSecret(record, { userId, portal, kind });
    return { userId, keyVersion: record.keyVersion, secret };
  }

  // Devuelve { userId, portal, kind, status }.
  async function markNeedsRelink({ email, portal, kind }) {
    const userId = await buscarUsuario(email);
    const marcada = await repo.markNeedsRelink({ userId, portal, kind }, ahora());
    if (!marcada) throw new CredentialNotFoundError();
    return { userId, portal, kind, status: marcada.status };
  }

  // ITN-51 - Estado de la credencial sin tocar los campos cifrados.
  // Devuelve { status, lastValidatedAt } o null si el alumno no la ha vinculado.
  async function getStatusForUser({ userId, portal, kind }) {
    return repo.getCredentialStatus({ userId, portal, kind });
  }

  // ITN-51 - Borra la credencial del alumno de la sesión. Devuelve { userId }.
  async function deleteSecretForUser({ userId, portal, kind }) {
    if (!(await repo.deleteCredential({ userId, portal, kind }))) throw new CredentialNotFoundError();
    return { userId };
  }

  return { saveSecretForUser, readSecret, markNeedsRelink, getStatusForUser, deleteSecretForUser };
}

module.exports = { createCredentialService };
