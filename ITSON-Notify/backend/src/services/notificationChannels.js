// ITN-28 - Canales de notificación de prueba.
// "log" siempre está disponible. "email" (Resend) solo se arma si existe
// RESEND_API_KEY; si falta, el canal se omite sin fallar.
// FCM y Telegram quedan fuera de alcance de ITN-28.

const RESEND_URL = "https://api.resend.com/emails";
const RESEND_TIMEOUT_MS = 10_000;

// Registra que se notificó, con un evento fijo y solo los ids de
// grade_changes. Nunca escribe el texto del mensaje: lleva materia, actividad
// y calificaciones.
function logChannel(logger = console) {
  return {
    name: "log",
    async send(message, { gradeChangeId, gradeChangeIds }) {
      logger.info("notificacion_enviada", {
        grade_change_id: gradeChangeId,
        grade_change_ids: gradeChangeIds ?? [gradeChangeId],
      });
    },
  };
}

// Envía el aviso por correo con la API HTTP de Resend (sin dependencias).
// El error nunca incluye la llave: solo el status y el mensaje de Resend.
function emailChannel({ apiKey, from, to, fetchImpl = fetch }) {
  return {
    name: "email",
    async send(message) {
      const res = await fetchImpl(RESEND_URL, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${apiKey}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ from, to: [to], subject: message.subject, text: message.text }),
        signal: AbortSignal.timeout(RESEND_TIMEOUT_MS),
      });
      if (!res.ok) {
        let detalle = "";
        try {
          detalle = (await res.json())?.message ?? "";
        } catch {
          // cuerpo vacío o no JSON
        }
        throw new Error(`Resend respondió ${res.status}${detalle ? `: ${detalle}` : ""}`);
      }
    },
  };
}

// Arma los canales disponibles según el entorno.
//   env.RESEND_API_KEY     sin ella no hay canal email
//   env.NOTIFY_EMAIL_TO    destinatario de prueba (obligatorio para email)
//   env.NOTIFY_EMAIL_FROM  remitente; por defecto el de pruebas de Resend
function buildChannels({ env = process.env, logger = console, fetchImpl } = {}) {
  const channels = [logChannel(logger)];

  if (!env.RESEND_API_KEY) {
    logger.info("canal_email_omitido", { reason: "sin_resend_api_key" });
    return channels;
  }
  if (!env.NOTIFY_EMAIL_TO) {
    logger.warn("canal_email_omitido", { reason: "sin_notify_email_to" });
    return channels;
  }

  channels.push(
    emailChannel({
      apiKey: env.RESEND_API_KEY,
      from: env.NOTIFY_EMAIL_FROM || "ITSON Notify <onboarding@resend.dev>",
      to: env.NOTIFY_EMAIL_TO,
      fetchImpl,
    }),
  );
  return channels;
}

module.exports = { buildChannels, logChannel, emailChannel, RESEND_URL };
