// ITN-28 - Canales de notificación.
// "log" siempre está disponible. "email" (Resend) y "web_push" (VAPID) solo se
// arman si existen sus llaves en el entorno; si faltan, se omiten sin fallar.

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

// Envía el aviso por Web Push a los dispositivos suscritos del usuario, después
// de purgar los de sesiones revocadas (ITN-54). Si un endpoint responde 404 o 410 (suscripción vencida o revocada), se borra.
function webPushChannel({
  vapidPublicKey,
  vapidPrivateKey,
  vapidSubject = "mailto:notificaciones@itson.edu.mx",
  pushRepo,
  webpushImpl,
}) {
  const wp = webpushImpl ?? require("web-push");
  wp.setVapidDetails(vapidSubject, vapidPublicKey, vapidPrivateKey);

  return {
    name: "web_push",
    async send(message, { userId, gradeChangeId } = {}) {
      if (!userId) throw new Error("webPushChannel requiere userId");
      // ITN-54: antes de elegir destinatarios, purga el Push de las sesiones que el
      // logout marcó como revocadas. Falla cerrado: si la purga lanza, no se envía
      // a ningún dispositivo y el aviso queda failed para el siguiente reintento.
      await pushRepo.purgeRevokedPushSubscriptions(userId);
      const subs = await pushRepo.listPushSubscriptions(userId);
      if (!subs || subs.length === 0) {
        throw new Error("Usuario sin suscripciones Web Push");
      }

      const payload = JSON.stringify({
        title: message.subject,
        body: message.text,
        tag: gradeChangeId ? `itson-change-${gradeChangeId}` : "itson-notify",
        url: "/notifications",
      });

      let enviados = 0;
      let ultimoError = null;

      for (const sub of subs) {
        try {
          await wp.sendNotification(
            { endpoint: sub.endpoint, keys: { p256dh: sub.p256dh, auth: sub.auth } },
            payload,
          );
          enviados += 1;
        } catch (err) {
          if (err?.statusCode === 404 || err?.statusCode === 410) {
            try {
              await pushRepo.deletePushSubscription(userId, sub.endpoint);
            } catch {
              // Si falla el borrado, se limpia en el siguiente intento.
            }
          }
          ultimoError = err;
        }
      }

      if (enviados === 0 && ultimoError) {
        throw new Error(`Web Push respondió ${ultimoError.statusCode ?? "error"}`);
      }
    },
  };
}

// Arma los canales disponibles según el entorno.
//   env.RESEND_API_KEY     sin ella no hay canal email
//   env.NOTIFY_EMAIL_TO    destinatario de prueba (obligatorio para email)
//   env.NOTIFY_EMAIL_FROM  remitente; por defecto el de pruebas de Resend
//   env.VAPID_PUBLIC_KEY / env.VAPID_PRIVATE_KEY + pushRepo  activan web_push
function buildChannels({
  env = process.env,
  logger = console,
  fetchImpl,
  pushRepo,
  webpushImpl,
} = {}) {
  const channels = [logChannel(logger)];

  if (!env.RESEND_API_KEY) {
    logger.info("canal_email_omitido", { reason: "sin_resend_api_key" });
  } else if (!env.NOTIFY_EMAIL_TO) {
    logger.warn("canal_email_omitido", { reason: "sin_notify_email_to" });
  } else {
    channels.push(
      emailChannel({
        apiKey: env.RESEND_API_KEY,
        from: env.NOTIFY_EMAIL_FROM || "ITSON Notify <onboarding@resend.dev>",
        to: env.NOTIFY_EMAIL_TO,
        fetchImpl,
      }),
    );
  }

  if (env.VAPID_PUBLIC_KEY && env.VAPID_PRIVATE_KEY && pushRepo) {
    channels.push(
      webPushChannel({
        vapidPublicKey: env.VAPID_PUBLIC_KEY,
        vapidPrivateKey: env.VAPID_PRIVATE_KEY,
        vapidSubject: env.VAPID_SUBJECT || "mailto:notificaciones@itson.edu.mx",
        pushRepo,
        webpushImpl,
      }),
    );
  }

  return channels;
}

module.exports = { buildChannels, logChannel, emailChannel, webPushChannel, RESEND_URL };