// ITN-28 - Canales de notificación.
// "log" siempre está disponible. "email" (Resend) y "web_push" (VAPID) solo se
// arman si existen sus llaves en el entorno; si faltan, se omiten sin fallar.
// El correo va al alumno dueño de cada aviso (app_users.email); NOTIFY_EMAIL_TO
// es solo un override de pruebas.

const RESEND_URL = "https://api.resend.com/emails";
const RESEND_TIMEOUT_MS = 10_000;

// Registra que se notificó, con un evento fijo y solo los ids de
// grade_changes. Nunca escribe el texto del mensaje: lleva materia, actividad
// y calificaciones.
function logChannel(logger = console) {
  return {
    name: "log",
    async send(message, { gradeChangeId, gradeChangeIds, classroomTaskEventId }) {
      // ITN-50 - Avisos de tareas de Classroom: solo el id del evento del outbox.
      if (classroomTaskEventId) {
        logger.info("notificacion_enviada", { classroom_task_event_id: classroomTaskEventId });
        return;
      }
      logger.info("notificacion_enviada", {
        grade_change_id: gradeChangeId,
        grade_change_ids: gradeChangeIds ?? [gradeChangeId],
      });
    },
  };
}

// Dominios reservados (RFC 2606 / RFC 6761): nunca reciben correo real. Los
// usa el ensayo sintético (ensayo.itn56.<hora>@example.test) y las pruebas.
const TLDS_RESERVADOS = ["test", "invalid", "localhost", "example"];
const DOMINIOS_RESERVADOS = ["example.com", "example.org", "example.net"];
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

// Revisa el correo del alumno antes de llamar a Resend. Devuelve el motivo del
// rechazo o null si se puede enviar. El motivo nunca incluye el correo.
function motivoCorreoNoEnviable(email) {
  if (typeof email !== "string" || email.trim() === "") return "Alumno sin correo registrado";
  const limpio = email.trim().toLowerCase();
  if (!EMAIL_RE.test(limpio)) return "Correo del alumno inválido";
  const dominio = limpio.slice(limpio.lastIndexOf("@") + 1);
  const tld = dominio.slice(dominio.lastIndexOf(".") + 1);
  const reservado =
    TLDS_RESERVADOS.includes(tld) ||
    DOMINIOS_RESERVADOS.some((d) => dominio === d || dominio.endsWith(`.${d}`));
  return reservado ? "Correo del alumno con dominio reservado" : null;
}

// Envía el aviso por correo con la API HTTP de Resend (sin dependencias).
// Destinatario, uno por correo:
//   overrideTo  si viene (NOTIFY_EMAIL_TO), todos los avisos van ahí y no se
//               consulta app_users. Solo para pruebas locales y el ensayo.
//   si no, el correo del alumno dueño del aviso: emailRepo.getUserEmail(meta.userId).
// Si el alumno no tiene correo, es inválido o de un dominio reservado, lanza sin
// llamar a Resend y el aviso queda failed. Ningún error incluye la llave ni el
// correo: solo el motivo, o el status y el mensaje de Resend.
function emailChannel({ apiKey, from, overrideTo, emailRepo, fetchImpl = fetch }) {
  if (!overrideTo && typeof emailRepo?.getUserEmail !== "function") {
    throw new Error("emailChannel requiere overrideTo o emailRepo.getUserEmail");
  }

  async function destinatario(userId) {
    if (overrideTo) return overrideTo;
    if (!userId) throw new Error("emailChannel requiere userId");
    const email = await emailRepo.getUserEmail(userId);
    const motivo = motivoCorreoNoEnviable(email);
    if (motivo) throw new Error(motivo);
    return email.trim();
  }

  return {
    name: "email",
    async send(message, { userId } = {}) {
      const to = await destinatario(userId);
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
    async send(message, { userId, gradeChangeId, classroomTaskEventId } = {}) {
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
        // ITN-50 - Cada tarea de Classroom con su propia etiqueta, para que un
        // aviso no reemplace al anterior en el dispositivo.
        tag: gradeChangeId
          ? `itson-change-${gradeChangeId}`
          : classroomTaskEventId
            ? `itson-classroom-${classroomTaskEventId}`
            : "itson-notify",
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
//   emailRepo              repo con getUserEmail(userId) (notificationRepository):
//                          el correo de cada aviso va al alumno dueño (app_users.email)
//   env.NOTIFY_EMAIL_TO    opcional, SOLO para pruebas: si está definida, todos los
//                          correos van a esa dirección y no se consulta app_users
//   env.NOTIFY_EMAIL_FROM  remitente; por defecto el de pruebas de Resend
//   env.VAPID_PUBLIC_KEY / env.VAPID_PRIVATE_KEY + pushRepo  activan web_push
function buildChannels({
  env = process.env,
  logger = console,
  fetchImpl,
  pushRepo,
  emailRepo,
  webpushImpl,
} = {}) {
  const channels = [logChannel(logger)];
  const overrideTo = env.NOTIFY_EMAIL_TO?.trim() || undefined;

  if (!env.RESEND_API_KEY) {
    logger.info("canal_email_omitido", { reason: "sin_resend_api_key" });
  } else if (!overrideTo && typeof emailRepo?.getUserEmail !== "function") {
    logger.warn("canal_email_omitido", { reason: "sin_email_repo" });
  } else {
    channels.push(
      emailChannel({
        apiKey: env.RESEND_API_KEY,
        from: env.NOTIFY_EMAIL_FROM || "ITSON Notify <onboarding@resend.dev>",
        overrideTo,
        emailRepo,
        fetchImpl,
      }),
    );
  }

  if (env.VAPID_PUBLIC_KEY && env.VAPID_PRIVATE_KEY && pushRepo) {
    // Push es opcional: si setVapidDetails rechaza las llaves, se omite el canal
    // en lugar de tumbar el proceso. Nunca se registra el mensaje del error.
    try {
      channels.push(
        webPushChannel({
          vapidPublicKey: env.VAPID_PUBLIC_KEY,
          vapidPrivateKey: env.VAPID_PRIVATE_KEY,
          vapidSubject: env.VAPID_SUBJECT || "mailto:notificaciones@itson.edu.mx",
          pushRepo,
          webpushImpl,
        }),
      );
    } catch {
      logger.warn("canal_web_push_omitido", { reason: "vapid_invalida" });
    }
  }

  return channels;
}

module.exports = {
  buildChannels,
  logChannel,
  emailChannel,
  webPushChannel,
  motivoCorreoNoEnviable,
  RESEND_URL,
};