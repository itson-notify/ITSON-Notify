// ITN-36 - Lectura y escritura de student_credentials (migración 007).
// Solo maneja datos ya cifrados: nunca ve el secreto ni la llave. Fuera de este
// archivo los bytea son Buffer; por PostgREST viajan como texto `\x...`, porque
// JSON.stringify convertiría un Buffer en un objeto.
const { check, PersistenceError } = require("../utils/errors");
const { upsertUser } = require("./snapshotRepository");

const CREDENTIALS_ON_CONFLICT = "user_id,portal,kind"; // 007
const ACTIVE_BATCH = 100;

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

  // Volver a vincular reactiva la cuenta y reemplaza la validación anterior, que era
  // de otro secreto. ITN-52 - lastValidatedAt es la hora en que el portal aceptó este
  // secreto, o null si nadie lo ha validado.
  async function saveCredential(
    { userId, portal, kind, ciphertext, nonce, authTag, keyVersion },
    updatedAt,
    { lastValidatedAt = null } = {},
  ) {
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
            last_validated_at: lastValidatedAt,
            updated_at: updatedAt,
          },
          { onConflict: CREDENTIALS_ON_CONFLICT },
        )
        .select("portal,kind,status,key_version,last_validated_at")
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

  // ITN-52 - Correos de los alumnos con una credencial activa de portal y kind.
  // Solo lee user_id de student_credentials (nunca los campos cifrados) y después el
  // correo en app_users, en tandas para no armar URLs enormes en PostgREST.
  // Devuelve los correos ordenados.
  async function listActiveEmails({ portal, kind }) {
    const filas = check(
      "student_credentials",
      await supabase
        .from("student_credentials")
        .select("user_id")
        .eq("portal", portal)
        .eq("kind", kind)
        .eq("status", "active"),
    );
    const ids = [...new Set(filas.map((f) => f.user_id))];
    const correos = [];
    for (let i = 0; i < ids.length; i += ACTIVE_BATCH) {
      const usuarios = check(
        "app_users",
        await supabase.from("app_users").select("email").in("id", ids.slice(i, i + ACTIVE_BATCH)),
      );
      for (const u of usuarios) if (u.email) correos.push(u.email);
    }
    return correos.sort();
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
    listActiveEmails,
  };
}

module.exports = { createCredentialRepository, CREDENTIALS_ON_CONFLICT };
