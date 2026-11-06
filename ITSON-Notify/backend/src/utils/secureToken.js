// ITN-41 - Cifra datos sensibles con AES-256-GCM.
// `purpose` separa los usos de la misma clave: OAuth, sesión y refresh token
// no pueden intercambiarse aunque se copie su valor entre contextos.
const crypto = require("crypto");

function encrypt(value, secret, purpose) {
  if (!secret || secret.length < 32) throw new Error("GOOGLE_AUTH_SECRET debe tener 32 caracteres o más");
  const key = crypto.createHmac("sha256", secret).update(purpose).digest();
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv("aes-256-gcm", key, iv);
  const data = Buffer.concat([cipher.update(JSON.stringify(value)), cipher.final()]);
  return [iv, data, cipher.getAuthTag()].map(part => part.toString("base64url")).join(".");
}

// Devuelve null cuando el valor está manipulado, tiene formato inválido o
// procede de otra clave/propósito. Nunca devuelve contenidos sin autenticar.
function decrypt(value, secret, purpose) {
  if (typeof value !== "string" || !secret || secret.length < 32) return null;
  const parts = value.split(".");
  if (parts.length !== 3) return null;

  try {
    const [iv, data, tag] = parts.map(part => Buffer.from(part, "base64url"));
    if (iv.length !== 12 || tag.length !== 16) return null;
    const key = crypto.createHmac("sha256", secret).update(purpose).digest();
    const decipher = crypto.createDecipheriv("aes-256-gcm", key, iv);
    decipher.setAuthTag(tag);
    return JSON.parse(Buffer.concat([decipher.update(data), decipher.final()]).toString("utf8"));
  } catch {
    return null;
  }
}

module.exports = { encrypt, decrypt };
