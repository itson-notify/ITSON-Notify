// ITN-36 - Lectura y escritura de student_credentials (migración 007).
// Solo maneja datos ya cifrados: nunca ve el secreto ni la llave. Fuera de este
// archivo los bytea son Buffer; por PostgREST viajan como texto `\x...`, porque
// JSON.stringify convertiría un Buffer en un objeto.
const { check, PersistenceError } = require("../utils/errors");
const { upsertUser } = require("./snapshotRepository");

const CREDENTIALS_ON_CONFLICT = "user_id,portal,kind"; // 007

const toBytea = (buffer) => `\\x${buffer.toString("hex")}`;

function fromBytea(value) {
  if (typeof value !== "string" || !value.startsWith("\\x")) {
    throw new PersistenceError("student_credentials", { code: "bytea_invalido" });
  }
  return Buffer.from(value.slice(2), "hex");
}

function createCredentialRepository(supabase) {
  const fila = ({ userId, portal, kind }, consulta) =>
    consulta.eq("user_id", userId).eq("portal", portal).eq("kind", kind);

  // Solo lectura: consultar una credencial no da de alta a nadie.
  async function findUserIdByEmail(email) {
    const row = check(
      "app_users",
      await supabase.from("app_users").select("id").eq("email", email).maybeSingle(),
    );
    return row?.id ?? null;
  }

  const ensureUser = (email) => upsertUser(supabase, email);

  // Volver a vincular reactiva la cuenta y borra la validación anterior, que era
  // de otro secreto.
  async function saveCredential({ userId, portal, kind, ciphertext, nonce, authTag, keyVersion }, updatedAt) {
    return check(
      "student_credentials",
      await supabase
        .from("student_credentials")
        .upsert(
          {
            user_id: userId,
            portal,
            kind,
            ciphertext: toBytea(ciphertext),
            nonce: toBytea(nonce),
            auth_tag: toBytea(authTag),
            key_version: keyVersion,
            status: "active",
            last_validated_at: null,
            updated_at: updatedAt,
          },
          { onConflict: CREDENTIALS_ON_CONFLICT },
        )
        .select("portal,kind,status,key_version")
        .single(),
    );
  }

  // Devuelve { ciphertext, nonce, authTag, keyVersion, status } o null.
  async function getCredential(ref) {
    const row = check(
      "student_credentials",
      await fila(ref, supabase.from("student_credentials").select("ciphertext,nonce,auth_tag,key_version,status"))
        .maybeSingle(),
    );
    if (!row) return null;
    return {
      ciphertext: fromBytea(row.ciphertext),
      nonce: fromBytea(row.nonce),
      authTag: fromBytea(row.auth_tag),
      keyVersion: row.key_version,
      status: row.status,
    };
  }

  // ITN-51 - Solo status y last_validated_at, para responder al alumno sin leer
  // el ciphertext. Devuelve { status, lastValidatedAt } o null.
  async function getCredentialStatus(ref) {
    const row = check(
      "student_credentials",
      await fila(ref, supabase.from("student_credentials").select("status,last_validated_at")).maybeSingle(),
    );
    return row ? { status: row.status, lastValidatedAt: row.last_validated_at ?? null } : null;
  }

  // Devuelve { portal, kind, status } o null si no existe.
  async function markNeedsRelink(ref, updatedAt) {
    return check(
      "student_credentials",
      await fila(ref, supabase.from("student_credentials").update({ status: "needs_relink", updated_at: updatedAt }))
        .select("portal,kind,status")
        .maybeSingle(),
    );
  }

  // Devuelve true si borró la fila.
  async function deleteCredential(ref) {
    const rows = check(
      "student_credentials",
      await fila(ref, supabase.from("student_credentials").delete()).select("id"),
    );
    return rows.length > 0;
  }

  return {
    findUserIdByEmail,
    ensureUser,
    saveCredential,
    getCredential,
    getCredentialStatus,
    markNeedsRelink,
    deleteCredential,
  };
}

module.exports = { createCredentialRepository, CREDENTIALS_ON_CONFLICT };
