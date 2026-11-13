// ITN-55 - Lectura y escritura de student_itson_profiles (migración 012). Solo
// maneja la matrícula ya cifrada: nunca ve el texto plano ni la llave. Los bytea
// viajan como texto `\x...`, igual que en credentialRepository.
const { check, PersistenceError } = require("../utils/errors");

const TABLE = "student_itson_profiles";
const ON_CONFLICT = "user_id"; // llave primaria
const BATCH = 100;

const toBytea = (buffer) => `\\x${buffer.toString("hex")}`;

function fromBytea(value) {
  if (typeof value !== "string" || !value.startsWith("\\x")) {
    throw new PersistenceError(TABLE, { code: "bytea_invalido" });
  }
  return Buffer.from(value.slice(2), "hex");
}

const COLUMNAS = "user_id,matricula_ciphertext,matricula_nonce,matricula_auth_tag,key_version,career,updated_at";

function toRecord(row) {
  return {
    userId: row.user_id,
    ciphertext: fromBytea(row.matricula_ciphertext),
    nonce: fromBytea(row.matricula_nonce),
    authTag: fromBytea(row.matricula_auth_tag),
    keyVersion: row.key_version,
    career: row.career,
    updatedAt: row.updated_at,
  };
}

function createItsonProfileRepository(supabase) {
  async function getUserEmail(userId) {
    const row = check("app_users", await supabase.from("app_users").select("email").eq("id", userId).maybeSingle());
    return row?.email ?? null;
  }

  // Devuelve el registro cifrado o null.
  async function getProfile(userId) {
    const row = check(TABLE, await supabase.from(TABLE).select(COLUMNAS).eq("user_id", userId).maybeSingle());
    return row ? toRecord(row) : null;
  }

  // Crea o reemplaza el perfil del alumno. Devuelve { career, updatedAt }.
  async function saveProfile({ userId, ciphertext, nonce, authTag, keyVersion, career }, updatedAt) {
    const row = check(
      TABLE,
      await supabase
        .from(TABLE)
        .upsert(
          {
            user_id: userId,
            matricula_ciphertext: toBytea(ciphertext),
            matricula_nonce: toBytea(nonce),
            matricula_auth_tag: toBytea(authTag),
            key_version: keyVersion,
            career,
            updated_at: updatedAt,
          },
          { onConflict: ON_CONFLICT },
        )
        .select("career,updated_at")
        .single(),
    );
    return { career: row.career, updatedAt: row.updated_at };
  }

  // Devuelve true si borró la fila.
  async function deleteProfile(userId) {
    const rows = check(TABLE, await supabase.from(TABLE).delete().eq("user_id", userId).select("user_id"));
    return rows.length > 0;
  }

  // Todos los perfiles con el correo de su alumno, para el worker. Ordenados por
  // correo. Un perfil sin correo en app_users se omite.
  async function listProfilesWithEmail() {
    const filas = check(TABLE, await supabase.from(TABLE).select(COLUMNAS));
    const correos = new Map();
    const ids = [...new Set(filas.map((f) => f.user_id))];
    for (let i = 0; i < ids.length; i += BATCH) {
      const usuarios = check(
        "app_users",
        await supabase.from("app_users").select("id,email").in("id", ids.slice(i, i + BATCH)),
      );
      for (const u of usuarios) if (u.email) correos.set(u.id, u.email);
    }
    return filas
      .filter((f) => correos.has(f.user_id))
      .map((f) => ({ email: correos.get(f.user_id), record: toRecord(f) }))
      .sort((a, b) => (a.email < b.email ? -1 : a.email > b.email ? 1 : 0));
  }

  return { getUserEmail, getProfile, saveProfile, deleteProfile, listProfilesWithEmail };
}

module.exports = { createItsonProfileRepository, ON_CONFLICT };
