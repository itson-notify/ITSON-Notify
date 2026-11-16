// ITN-55 - Cifra y guarda, lee y descifra la matrícula del perfil ITSON. La API de
// ITSON no autentica, así que la matrícula funciona como credencial: se cifra con
// credentialCrypto y AAD "user_id:itson_api:matricula". El texto plano solo vive
// en memoria dentro de estas funciones; nada aquí lo guarda ni lo loguea.
const { pistaMatricula } = require("../models/itsonProfile");

const CONTEXTO = { portal: "itson_api", kind: "matricula" };
const contexto = (userId) => ({ userId, ...CONTEXTO });

function createItsonProfileService({ repo, crypto, now = () => Date.now() }) {
  const ahora = () => new Date(now()).toISOString();

  // Devuelve { career, updatedAt }.
  async function saveForUser({ userId, matricula, career }) {
    const cifrado = crypto.encryptSecret(matricula, contexto(userId));
    return repo.saveProfile({ userId, career, ...cifrado }, ahora());
  }

  // Devuelve { matriculaHint, career, updatedAt } o null. Descifra solo para armar
  // la pista; la matrícula completa nunca sale de aquí.
  async function getForUser(userId) {
    const record = await repo.getProfile(userId);
    if (!record) return null;
    const matricula = crypto.decryptSecret(record, contexto(userId));
    return { matriculaHint: pistaMatricula(matricula), career: record.career, updatedAt: record.updatedAt };
  }

  const deleteForUser = (userId) => repo.deleteProfile(userId);

  // Para el worker: { students: [{ email, matricula, career }], undecryptable }.
  // Un perfil que no se puede descifrar se omite y se cuenta; no detiene a los demás.
  async function listForWorker() {
    const students = [];
    let undecryptable = 0;
    for (const { email, record } of await repo.listProfilesWithEmail()) {
      try {
        students.push({ email, matricula: crypto.decryptSecret(record, contexto(record.userId)), career: record.career });
      } catch {
        undecryptable += 1;
      }
    }
    return { students, undecryptable };
  }

  return { saveForUser, getForUser, deleteForUser, listForWorker, getUserEmail: repo.getUserEmail };
}

module.exports = { createItsonProfileService, CONTEXTO };
