// ITN-53 - Lectura de la sesión de Google del alumno, compartida por /auth/google
// y /api. La cookie solo identifica la sesión: siempre se confirma contra
// google_app_sessions para que un logout la invalide en todas las instancias.
// Una sesión con revoked_at (ITN-54) cuenta como cerrada.
const crypto = require("crypto");
const { decrypt } = require("../utils/secureToken");

const SESSION_COOKIE = "itn41_google_session";

const sessionHash = id => crypto.createHash("sha256").update(id).digest("hex");

// Express no instala cookie-parser; basta leer las dos cookies propias.
function cookieValue(req, name) {
  const item = (req.headers.cookie || "").split(";").map(value => value.trim())
    .find(value => value.startsWith(`${name}=`));
  return item ? item.slice(name.length + 1) : null;
}

// Devuelve la sesión descifrada o null si no hay una vigente. Lanza si falla la
// persistencia: quien llama debe responder 500, nunca dar acceso.
function createSessionReader({ secret, supabase, now = Date.now }) {
  return async function readSession(req) {
    const session = decrypt(cookieValue(req, SESSION_COOKIE), secret, "google-session");
    if (!session || !Number.isFinite(session.exp) || session.exp <= now() ||
        !session.userId || !session.googleId || typeof session.sessionId !== "string") return null;
    // "*" y no una lista de columnas: si falta la migración 011, pedir revoked_at
    // daría 42703 en cada petición. Sin la columna, revoked_at llega undefined.
    const { data, error } = await supabase.from("google_app_sessions")
      .select("*").eq("id", sessionHash(session.sessionId)).maybeSingle();
    if (error) throw error;
    // ITN-54: el logout marca la sesión con revoked_at en lugar de borrarla.
    return data && !data.revoked_at && data.user_id === session.userId &&
      data.google_id === session.googleId && Date.parse(data.expires_at) > now() ? session : null;
  };
}

function requireStudentSession({ readSession }) {
  return async function studentSessionMiddleware(req, res, next) {
    const session = await readSession(req);
    if (!session) return res.status(401).json({ error: "no_autenticado" });
    req.student = { userId: session.userId, googleId: session.googleId };
    return next();
  };
}

module.exports = { SESSION_COOKIE, sessionHash, cookieValue, createSessionReader, requireStudentSession };
