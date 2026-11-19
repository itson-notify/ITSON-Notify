// Validación de la configuración VAPID (Web Push) al arrancar.
// Push es opcional: si las llaves faltan o son inválidas, NO se lanza. Se
// devuelve { enabled: false, reason } y el backend sigue sin el canal web_push.
// Ni el resultado ni los motivos incluyen valores de las llaves: solo un código
// de lista cerrada (los mensajes de error de web-push pueden traer el subject).
const crypto = require("crypto");

const VAPID_SUBJECT_DEFAULT = "mailto:notificaciones@itson.edu.mx";

// Motivos posibles (lista cerrada, aptos para el logger).
const MOTIVOS = Object.freeze({
  AUSENTE: "vapid_ausente",
  INCOMPLETA: "vapid_incompleta",
  INVALIDA: "vapid_invalida",
});

// Origen ficticio solo para que getVapidHeaders valide; no hay red.
const AUDIENCIA_VALIDACION = "https://push.invalid";

function derivaPublica(privateKey) {
  const ecdh = crypto.createECDH("prime256v1");
  ecdh.setPrivateKey(Buffer.from(privateKey, "base64url"));
  return ecdh.getPublicKey().toString("base64url");
}

// publicKey/privateKey: textos (o vacíos/null). webpushImpl inyectable en pruebas.
function validateVapidConfig({ publicKey, privateKey, subject, webpushImpl } = {}) {
  const pub = typeof publicKey === "string" ? publicKey.trim() : "";
  const priv = typeof privateKey === "string" ? privateKey.trim() : "";
  const sub = (typeof subject === "string" ? subject.trim() : "") || VAPID_SUBJECT_DEFAULT;

  if (!pub && !priv) return { enabled: false, reason: MOTIVOS.AUSENTE };
  if (!pub || !priv) return { enabled: false, reason: MOTIVOS.INCOMPLETA };

  try {
    const wp = webpushImpl ?? require("web-push");
    // Valida subject, formato y largo de ambas llaves, y firma un JWT con la privada.
    wp.getVapidHeaders(AUDIENCIA_VALIDACION, sub, pub, priv, "aes128gcm");
    // La pública debe corresponder a la privada; si no, los servicios Push rechazan.
    if (derivaPublica(priv) !== pub) return { enabled: false, reason: MOTIVOS.INVALIDA };
  } catch {
    // Nunca se propaga ni se registra el mensaje: puede incluir valores.
    return { enabled: false, reason: MOTIVOS.INVALIDA };
  }

  return { enabled: true, reason: null, publicKey: pub, privateKey: priv, subject: sub };
}

module.exports = { validateVapidConfig, MOTIVOS_VAPID: MOTIVOS, VAPID_SUBJECT_DEFAULT };
