// ITN-50 / ITN-44 - Consumidor y adaptadores de transporte para el ledger
// aditivo de notificaciones de Classroom (classroom_notification_deliveries, 019).
//
// Garantías de contrato:
//   1. No usa grade_changes ni escribe filas en notifications_log.
//   2. Reclamación en dos fases: claim() (FOR UPDATE SKIP LOCKED + lease_until) ->
//      beginSend() (revalida autorización con permiso de tareas e integridad del
//      evento justo antes del I/O, congela payload/fingerprint/idempotency_key y
//      pasa a 'sending') -> transporte -> ack() (CAS por claim_token).
//   3. Los resultados del transporte están tipados: 'accepted', 'not_accepted'
//      (transitorio o permanente), 'blocked' o 'unknown'. Cualquier excepción no
//      tipada pasa conservadoramente a 'unknown' sin reenvío automático ciego.
//   4. Resend usa Idempotency-Key estable por entrega; si falla con timeout/5xx
//      fuera de la ventana certificada de idempotencia (o sin garantía), pasa a
//      'unknown'.
//   5. Privacidad: ningún log ni columna de error contiene user_id, google_id,
//      correo, nombres de cursos, títulos de tareas, fechas ni endpoints Push.
const crypto = require("crypto");
const { motivoCorreoNoEnviable } = require("./notificationChannels");
const { NEW_TASK_SUBJECT } = require("./notificationService");
const { formatearFechaHermosillo, fraseEntrega, ZONA } = require("../utils/fechaHermosillo");
const { CAMPOS_PERMITIDOS } = require("../utils/logger");

// Registra los campos de conteo e ids seguros del despacho de Classroom en la
// lista blanca del logger sin modificar backend/src/utils/logger.js (evita
// colisionar con PR #41).
for (const campo of [
  "classroom_task_event_id",
  "delivery_id",
  "procesados",
  "enviados",
  "fallidos",
  "omitidos",
]) {
  CAMPOS_PERMITIDOS?.add?.(campo);
}

const RESEND_URL = "https://api.resend.com/emails";
const RESEND_TIMEOUT_MS = 10_000;
// Ventana conservadora bajo las 24 h de Idempotency-Key de Resend.
const RESEND_IDEMPOTENCY_TTL_MS = 23 * 60 * 60 * 1000;

const DEFAULT_MAX_ATTEMPTS = 5;
const DEFAULT_LEASE_SECONDS = 60;
const DEFAULT_SEND_DEADLINE_SECONDS = 30;
const BACKOFF_BASE_SECONDS = 30;
const BACKOFF_MAX_SECONDS = 1800;

const CLASSROOM_NOTIF_TYPE = "tareas";
const SIN_MATERIA = "Materia no disponible";

// Lista cerrada de banderas booleanas (igual que GOOGLE_OAUTH_ENABLED).
const ALLOWED_DISPATCH_FLAG_VALUES = Object.freeze(["true", "false", "1", "0"]);

// Usuario piloto permitido por defecto (Pedro) para que no salga ningún aviso
// a otros estudiantes mientras se valida el despacho de Classroom.
const DEFAULT_CLASSROOM_DISPATCH_ALLOWED_USERS = Object.freeze([
  "pedro.izquierdo252587@potros.itson.edu.mx",
  "pedro.izquierdo3005@gmail.com",
]);

function parseClassroomDispatchFlag(raw) {
  if (typeof raw === "boolean") return { valid: true, enabled: raw };
  const flag = typeof raw === "string" ? raw.trim().toLowerCase() : "";
  if (flag === "") return { valid: true, enabled: false };
  if (!ALLOWED_DISPATCH_FLAG_VALUES.includes(flag)) return { valid: false, enabled: false };
  return { valid: true, enabled: flag === "true" || flag === "1" };
}

function parseClassroomDispatchAllowedUsers(raw) {
  if (raw === undefined || raw === null) {
    return [...DEFAULT_CLASSROOM_DISPATCH_ALLOWED_USERS];
  }
  const items = Array.isArray(raw) || raw instanceof Set
    ? [...raw]
    : typeof raw === "string"
      ? raw.split(",")
      : [];
  const normalized = [];
  for (const item of items) {
    if (typeof item !== "string") continue;
    const token = item.trim();
    if (!token || token === "*") continue;
    normalized.push(token.toLowerCase());
  }
  return Object.freeze([...new Set(normalized)]);
}

function isClassroomUserAllowed(user, allowedUsers) {
  const list = Array.isArray(allowedUsers) ? allowedUsers : parseClassroomDispatchAllowedUsers(allowedUsers);
  if (list.length === 0) return false;
  const set = new Set(list.map((u) => String(u).trim().toLowerCase()).filter((u) => u && u !== "*"));
  if (set.size === 0) return false;

  const candidates = [user?.userId, user?.user_id, user?.googleId, user?.google_id, user?.email];
  return candidates.some((val) => typeof val === "string" && val.trim() !== "" && set.has(val.trim().toLowerCase()));
}

function loadClassroomDispatchConfig(env = process.env, config = {}) {
  const flagResult =
    typeof config?.classroomDispatchEnabled === "boolean"
      ? { valid: true, enabled: config.classroomDispatchEnabled }
      : parseClassroomDispatchFlag(env?.CLASSROOM_DISPATCH_ENABLED);

  if (!flagResult.valid) {
    throw new Error(
      "Configuración inválida o incompleta en backend/.env: CLASSROOM_DISPATCH_ENABLED (booleano inválido)",
    );
  }

  const rawAllowed =
    config?.classroomDispatchAllowedUsers !== undefined
      ? config.classroomDispatchAllowedUsers
      : env?.CLASSROOM_DISPATCH_ALLOWED_USERS !== undefined && String(env.CLASSROOM_DISPATCH_ALLOWED_USERS).trim() !== ""
        ? env.CLASSROOM_DISPATCH_ALLOWED_USERS
        : undefined;

  return {
    classroomDispatchEnabled: flagResult.enabled,
    classroomDispatchAllowedUsers: parseClassroomDispatchAllowedUsers(rawAllowed),
  };
}

const ERROR_CODE_WHITELIST = new Set([
  "invalid_recipient_email",
  "resend_rate_limited",
  "resend_rejected_4xx",
  "resend_idempotency_conflict",
  "resend_transient_with_idempotency",
  "resend_ambiguous_after_ttl",
  "resend_ambiguous_timeout",
  "push_no_subscriptions",
  "push_subscriptions_gone",
  "push_service_transient",
  "push_service_rejected",
  "push_ambiguous_network",
  "push_purge_failed",
  "channel_unconfigured",
  "channel_send_failed",
  "untyped_transport_error",
  "transport_invalid_outcome",
  "send_deadline_expired",
  "max_attempts_reached",
  "cancel_requested",
  "authorization_revoked",
  "tasks_scope_revoked",
  "tasks_scope_missing",
  "needs_relink",
  "recipient_changed",
  "event_no_longer_valid",
  "event_not_eligible",
  "event_deleted",
  "user_not_allowed",
]);

function sanitizeErrorCode(code, fallback = "untyped_transport_error") {
  if (typeof code === "string" && ERROR_CODE_WHITELIST.has(code)) return code;
  return fallback;
}

function sanitizeProviderRef(ref) {
  if (typeof ref !== "string") return null;
  const trimmed = ref.trim();
  if (!/^[A-Za-z0-9:_./-]{1,120}$/.test(trimmed)) return null;
  return trimmed;
}

// Vinculación privada del destinatario con HMAC-SHA256 ("v1:<64 hex>").
function computeRecipientFingerprint({ channel, email, userId, googleId, secret }) {
  if (typeof secret !== "string" || secret.length < 16) {
    throw new Error("computeRecipientFingerprint requiere un secret válido");
  }
  let target;
  if (channel === "email") {
    const clean = typeof email === "string" ? email.trim().toLowerCase() : "";
    if (!clean) return null;
    target = `classroom:email:${clean}`;
  } else if (channel === "web_push") {
    if (!userId || !googleId) return null;
    target = `classroom:web_push:${userId}:${googleId}`;
  } else {
    return null;
  }
  const digest = crypto.createHmac("sha256", secret).update(target, "utf8").digest("hex");
  return `v1:${digest}`;
}

function computeBackoffSeconds(attempts, randomFn = Math.random) {
  const exp = Math.min(Math.max(Number(attempts) || 1, 1), 6);
  const base = Math.min(BACKOFF_BASE_SECONDS * 2 ** (exp - 1), BACKOFF_MAX_SECONDS);
  const jitter = Math.floor(randomFn() * Math.max(Math.floor(base * 0.2), 1));
  return base + jitter;
}

function isValidClassroomUrl(value) {
  if (typeof value !== "string" || value.length === 0 || value.length > 3000) return false;
  try {
    const url = new URL(value);
    return (
      url.protocol === "https:" &&
      url.hostname === "classroom.google.com" &&
      !url.username &&
      !url.password
    );
  } catch {
    return false;
  }
}

function formatClassroomTaskMessage(payload = {}) {
  const courseName =
    typeof payload?.course_name === "string" && payload.course_name.trim() !== ""
      ? payload.course_name.trim()
      : null;
  const taskTitle =
    typeof payload?.task_title === "string" && payload.task_title.trim() !== ""
      ? payload.task_title.trim()
      : "una actividad";
  const dueAt = payload && "due_at" in payload ? payload.due_at : undefined;
  const donde = courseName ? ` en ${courseName}` : "";
  const entrega = fraseEntrega(dueAt);
  const baseText = `Nueva tarea publicada: ${taskTitle}${donde}.${entrega ? ` ${entrega}` : ""}`;
  const link = isValidClassroomUrl(payload?.alternate_link) ? payload.alternate_link : null;
  return {
    subject: NEW_TASK_SUBJECT,
    text: link ? `${baseText}\nEnlace: ${link}` : baseText,
  };
}

// Convierte una fila sent de classroom_notification_deliveries a la interfaz Notif
// de la bandeja del alumno (GET /api/notifications) con categoría "tareas".
function toClassroomDeliveryNotif(row) {
  const p = row?.payload ?? {};
  const materia =
    typeof p.course_name === "string" && p.course_name.trim() !== "" ? p.course_name.trim() : null;
  const tarea =
    typeof p.task_title === "string" && p.task_title.trim() !== "" ? p.task_title.trim() : null;
  const rows = [];
  if (materia) rows.push({ label: "Materia", value: materia });
  if (tarea) rows.push({ label: "Tarea", value: tarea });
  if ("due_at" in p) {
    const fecha = formatearFechaHermosillo(p.due_at);
    rows.push({ label: "Entrega", value: fecha ? `${fecha} (${ZONA})` : "Sin fecha de entrega" });
  }
  const msg = formatClassroomTaskMessage(p);
  const ts = row?.sent_at ?? row?.created_at ?? new Date().toISOString();
  return {
    id: row.event_id ?? row.id,
    type: CLASSROOM_NOTIF_TYPE,
    title: "Nueva tarea publicada",
    subject: materia ?? SIN_MATERIA,
    time: new Date(ts).toISOString(),
    unread: row?.read_at == null,
    body: msg.text,
    rows,
  };
}

// Adaptador tipado de correo (Resend) con Idempotency-Key estable por entrega.
function createClassroomEmailTransport({
  apiKey,
  from = "ITSON Notify <onboarding@resend.dev>",
  overrideTo,
  fetchImpl = fetch,
  timeoutMs = RESEND_TIMEOUT_MS,
  idempotencyTtlMs = RESEND_IDEMPOTENCY_TTL_MS,
  idempotencySupported = true,
} = {}) {
  if (!apiKey || typeof apiKey !== "string") {
    throw new Error("createClassroomEmailTransport requiere apiKey");
  }

  return {
    channel: "email",
    async send(message, session, { now = Date.now } = {}) {
      const destination = overrideTo ? overrideTo.trim() : session?.recipient_email;
      const invalidReason = motivoCorreoNoEnviable(destination);
      if (invalidReason) {
        return {
          status: "not_accepted",
          permanent: true,
          errorCode: "invalid_recipient_email",
        };
      }

      const idempotencyKey = session?.idempotency_key;
      const createdAtMs = session?.created_at ? Date.parse(session.created_at) : now();
      const withinIdempotencyWindow =
        idempotencySupported === true &&
        typeof idempotencyKey === "string" &&
        idempotencyKey.length > 0 &&
        now() - (Number.isFinite(createdAtMs) ? createdAtMs : now()) <= idempotencyTtlMs;

      let res;
      try {
        res = await fetchImpl(RESEND_URL, {
          method: "POST",
          headers: {
            Authorization: `Bearer ${apiKey}`,
            "Content-Type": "application/json",
            ...(idempotencyKey ? { "Idempotency-Key": idempotencyKey } : {}),
          },
          body: JSON.stringify({
            from,
            to: [destination.trim()],
            subject: message.subject,
            text: message.text,
          }),
          signal: AbortSignal.timeout(timeoutMs),
        });
      } catch {
        // Fallo de red o timeout tras iniciar la petición HTTP.
        if (withinIdempotencyWindow) {
          return {
            status: "not_accepted",
            permanent: false,
            errorCode: "resend_transient_with_idempotency",
          };
        }
        return {
          status: "unknown",
          errorCode: "resend_ambiguous_timeout",
        };
      }

      if (res.ok) {
        let body = null;
        try {
          body = await res.json();
        } catch {
          body = null;
        }
        return {
          status: "accepted",
          providerReference: sanitizeProviderRef(body?.id) ?? "resend_ok",
        };
      }

      if (res.status === 429 || res.status === 408) {
        return {
          status: "not_accepted",
          permanent: false,
          errorCode: "resend_rate_limited",
        };
      }

      if (res.status === 409) {
        return {
          status: "unknown",
          errorCode: "resend_idempotency_conflict",
        };
      }

      if (res.status >= 400 && res.status < 500) {
        return {
          status: "not_accepted",
          permanent: true,
          errorCode: "resend_rejected_4xx",
        };
      }

      // 5xx: resultado ambiguo salvo que la ventana de Idempotency-Key siga vigente.
      if (withinIdempotencyWindow) {
        return {
          status: "not_accepted",
          permanent: false,
          errorCode: "resend_transient_with_idempotency",
        };
      }

      return {
        status: "unknown",
        errorCode: "resend_ambiguous_after_ttl",
      };
    },
  };
}

// Adaptador tipado de Web Push con tag por evento y purga de sesiones revocadas.
function createClassroomWebPushTransport({
  vapidPublicKey,
  vapidPrivateKey,
  vapidSubject = "mailto:notificaciones@itson.edu.mx",
  pushRepo,
  webpushImpl,
} = {}) {
  if (!pushRepo) throw new Error("createClassroomWebPushTransport requiere pushRepo");
  const wp = webpushImpl ?? require("web-push");
  wp.setVapidDetails(vapidSubject, vapidPublicKey, vapidPrivateKey);

  return {
    channel: "web_push",
    async send(message, session) {
      const userId = session?.user_id;
      const eventId = session?.event_id;
      if (!userId || !eventId) {
        return { status: "not_accepted", permanent: true, errorCode: "transport_invalid_outcome" };
      }

      try {
        await pushRepo.purgeRevokedPushSubscriptions(userId);
      } catch {
        return { status: "not_accepted", permanent: false, errorCode: "push_purge_failed" };
      }

      const subs = await pushRepo.listPushSubscriptions(userId);
      if (!Array.isArray(subs) || subs.length === 0) {
        return { status: "blocked", errorCode: "push_no_subscriptions" };
      }

      const body = JSON.stringify({
        title: message.subject,
        body: message.text,
        tag: `itson-classroom-task-${eventId}`,
        url: "/notifications",
      });

      let sentCount = 0;
      let goneCount = 0;
      let transientCount = 0;
      let permanentCount = 0;
      let ambiguousCount = 0;

      for (const sub of subs) {
        try {
          await wp.sendNotification(
            { endpoint: sub.endpoint, keys: { p256dh: sub.p256dh, auth: sub.auth } },
            body,
          );
          sentCount += 1;
        } catch (err) {
          const code = err?.statusCode;
          if (code === 404 || code === 410) {
            goneCount += 1;
            try {
              await pushRepo.deletePushSubscription(userId, sub.endpoint);
            } catch {
              // Se limpiará en la siguiente corrida.
            }
          } else if (code === 429 || code === 408 || (typeof code === "number" && code >= 500)) {
            transientCount += 1;
          } else if (typeof code === "number" && code >= 400 && code < 500) {
            permanentCount += 1;
          } else {
            ambiguousCount += 1;
          }
        }
      }

      if (sentCount >= 1) {
        return {
          status: "accepted",
          providerReference: `push_devices:${sentCount}/${subs.length}`,
        };
      }
      if (ambiguousCount > 0) {
        return { status: "unknown", errorCode: "push_ambiguous_network" };
      }
      if (goneCount === subs.length) {
        return { status: "blocked", errorCode: "push_subscriptions_gone" };
      }
      if (transientCount > 0) {
        return { status: "not_accepted", permanent: false, errorCode: "push_service_transient" };
      }
      return {
        status: "not_accepted",
        permanent: permanentCount > 0,
        errorCode: "push_service_rejected",
      };
    },
  };
}

async function invokeTransportSafely(transport, message, session, options) {
  try {
    const result = await transport.send(message, session, options);
    if (!result || typeof result.status !== "string") {
      return { status: "unknown", errorCode: "transport_invalid_outcome" };
    }
    if (!["accepted", "not_accepted", "blocked", "unknown"].includes(result.status)) {
      return { status: "unknown", errorCode: "transport_invalid_outcome" };
    }
    return result;
  } catch {
    // Excepción no tipada después de beginSend: se trata conservadoramente como unknown.
    return { status: "unknown", errorCode: "untyped_transport_error" };
  }
}

// Envuelve un canal tipo { name, send(message, meta) } en el contrato tipado
// de transporte del ledger cuando se inyectan canales de prueba en createApp.
function wrapLegacyChannelAsTransport(channel) {
  return {
    name: channel.name === "web_push" ? "web_push" : "email",
    async send(message, permission) {
      try {
        await channel.send(
          { subject: message.subject, text: message.text },
          {
            userId: permission.user_id,
            classroomTaskEventId: permission.event_id,
            deliveryId: permission.delivery_id,
            idempotencyKey: permission.idempotency_key,
          },
        );
        return {
          status: "accepted",
          providerReference: permission.idempotency_key ?? null,
        };
      } catch (err) {
        return {
          status: "not_accepted",
          permanent: Boolean(err?.permanent),
          errorCode: "channel_send_failed",
        };
      }
    },
  };
}

// Arma los transportes tipados { email, web_push } a partir de transports
// inyectados, configuración de entorno (Resend / VAPID) o canales inyectados.
function buildClassroomTransports({
  config = {},
  env = process.env,
  pushRepo,
  channels,
  transports,
  fetchImpl,
  webpushImpl,
} = {}) {
  if (transports && (transports.email || transports.web_push)) {
    return transports;
  }

  const built = {};
  const resendApiKey = config?.resendApiKey || env?.RESEND_API_KEY;
  if (resendApiKey) {
    built.email = createClassroomEmailTransport({
      apiKey: resendApiKey,
      from: config?.notifyEmailFrom || env?.NOTIFY_EMAIL_FROM || "ITSON Notify <onboarding@resend.dev>",
      overrideTo: (config?.notifyEmailTo || env?.NOTIFY_EMAIL_TO || "").trim() || undefined,
      fetchImpl,
    });
  }

  const vapidPublicKey = config?.vapidPublicKey || env?.VAPID_PUBLIC_KEY;
  const vapidPrivateKey = config?.vapidPrivateKey || env?.VAPID_PRIVATE_KEY;
  const pushEnabled = (config?.pushEnabled ?? true) && Boolean(vapidPublicKey && vapidPrivateKey && pushRepo);
  if (pushEnabled) {
    try {
      built.web_push = createClassroomWebPushTransport({
        vapidPublicKey,
        vapidPrivateKey,
        vapidSubject: config?.vapidSubject || env?.VAPID_SUBJECT || "mailto:notificaciones@itson.edu.mx",
        pushRepo,
        webpushImpl,
      });
    } catch {
      // Si las llaves VAPID son inválidas, se omite web_push sin tumbar el proceso.
    }
  }

  if (Array.isArray(channels)) {
    const emailCh = channels.find((c) => c?.name === "email" && typeof c.send === "function");
    const pushCh = channels.find((c) => c?.name === "web_push" && typeof c.send === "function");
    if (!built.email && emailCh) built.email = wrapLegacyChannelAsTransport(emailCh);
    if (!built.web_push && pushCh) built.web_push = wrapLegacyChannelAsTransport(pushCh);
    if (!built.email && !built.web_push) {
      const logCh = channels.find((c) => c?.name === "log" && typeof c.send === "function");
      if (logCh) built.email = wrapLegacyChannelAsTransport(logCh);
    }
  }

  return built;
}

// Resuelve el manifiesto de canales requeridos para un evento al materializar.
async function resolveEventManifest({ userId, transports, repo }) {
  const channels = [];
  if (transports?.email) channels.push("email");
  if (transports?.web_push) {
    const hasPush = await repo.hasActivePushSubscriptions(userId);
    if (hasPush || channels.length === 0) {
      channels.push("web_push");
    }
  }
  if (channels.length === 0) {
    throw new Error("No hay canales configurados para materializar entregas de Classroom");
  }
  return channels;
}

// Orquesta materialización de eventos nuevos + procesamiento de la cola del ledger.
// Incluye también los contadores { procesados, enviados, fallidos, omitidos }
// compatibles con el contrato de despacho del worker, y aplica la lista
// permitida de usuarios (allowedUsers) tanto antes de materializar como antes de
// iniciar cualquier envío en beginSend.
async function processClassroomDeliveries({
  repo,
  transports,
  secret,
  allowedUsers,
  logger,
  now = () => Date.now(),
  randomFn = Math.random,
  maxEvents = 100,
  maxClaims = 200,
  leaseSeconds = DEFAULT_LEASE_SECONDS,
  sendDeadlineSeconds = DEFAULT_SEND_DEADLINE_SECONDS,
  maxAttempts = DEFAULT_MAX_ATTEMPTS,
  policyVersion = "v1",
  templateVersion = "v1",
} = {}) {
  if (!repo) throw new Error("processClassroomDeliveries requiere repo");
  if (!transports || (!transports.email && !transports.web_push)) {
    throw new Error("processClassroomDeliveries requiere al menos un transporte (email o web_push)");
  }
  if (typeof secret !== "string" || secret.length < 16) {
    throw new Error("processClassroomDeliveries requiere secret para recipient_fingerprint");
  }

  const enforceAllowlist = allowedUsers !== undefined && allowedUsers !== null;
  const normalizedAllowlist = enforceAllowlist ? parseClassroomDispatchAllowedUsers(allowedUsers) : null;

  const counters = {
    materialized: 0,
    existing: 0,
    claimed: 0,
    sent: 0,
    retryWait: 0,
    unknown: 0,
    dead: 0,
    blocked: 0,
    cancelled: 0,
    skippedAllowlist: 0,
    eventsDelivered: 0,
    procesados: 0,
    enviados: 0,
    fallidos: 0,
    omitidos: 0,
  };

  // 1) Materializar planes para eventos pendientes en classroom_task_events.
  const events = await repo.listUndeliveredEvents(maxEvents);
  counters.procesados = events.length;
  for (const event of events) {
    if (enforceAllowlist) {
      const auth = await repo.getAuthorizationRecipient(event.user_id);
      const allowed = isClassroomUserAllowed(
        {
          userId: event.user_id,
          googleId: auth?.google_id,
          email: auth?.email,
        },
        normalizedAllowlist,
      );
      if (!allowed) {
        counters.skippedAllowlist += 1;
        counters.omitidos += 1;
        continue;
      }
    }

    const channels = await resolveEventManifest({
      userId: event.user_id,
      transports,
      repo,
    });
    const plan = await repo.materializeEvent({
      eventId: event.id,
      channels,
      policyVersion,
    });
    if (plan.status === "materialized") counters.materialized += 1;
    else if (plan.status === "existing") counters.existing += 1;
    else if (plan.status === "blocked") {
      counters.blocked += 1;
      counters.omitidos += 1;
    } else if (plan.status === "cancelled") {
      counters.cancelled += 1;
      counters.omitidos += 1;
    }
  }

  // 2) Reclamar atómicamente y despachar entregas elegibles.
  for (let i = 0; i < maxClaims; i += 1) {
    const claimed = await repo.claimNextDelivery({ leaseSeconds, maxAttempts });
    if (!claimed) break;
    counters.claimed += 1;

    const auth = await repo.getAuthorizationRecipient(claimed.user_id);
    if (enforceAllowlist) {
      const allowed = isClassroomUserAllowed(
        {
          userId: claimed.user_id,
          googleId: auth?.google_id,
          email: auth?.email,
        },
        normalizedAllowlist,
      );
      if (!allowed) {
        await repo.ackDelivery({
          deliveryId: claimed.id,
          claimToken: claimed.claim_token,
          outcome: "cancelled",
          errorCode: "user_not_allowed",
          maxAttempts,
        });
        counters.cancelled += 1;
        counters.skippedAllowlist += 1;
        counters.omitidos += 1;
        continue;
      }
    }

    const transport = transports[claimed.channel];
    if (!transport) {
      await repo.ackDelivery({
        deliveryId: claimed.id,
        claimToken: claimed.claim_token,
        outcome: "blocked",
        errorCode: "channel_unconfigured",
        maxAttempts,
      });
      counters.blocked += 1;
      continue;
    }

    const fingerprint = computeRecipientFingerprint({
      channel: claimed.channel,
      email: auth?.email,
      userId: claimed.user_id,
      googleId: auth?.google_id,
      secret,
    });

    const permission = await repo.beginSend({
      deliveryId: claimed.id,
      claimToken: claimed.claim_token,
      sendDeadlineSeconds,
      maxAttempts,
      recipientFingerprint: fingerprint,
      templateVersion,
    });

    if (!permission.allowed) {
      if (permission.state === "cancelled") counters.cancelled += 1;
      else if (permission.state === "blocked") counters.blocked += 1;
      else if (permission.state === "dead") {
        counters.dead += 1;
        counters.fallidos += 1;
      }
      logger?.info?.("classroom_entrega_no_autorizada", {
        delivery_id: claimed.id,
        channel: claimed.channel,
        reason_code: sanitizeErrorCode(permission.reason_code, "authorization_revoked"),
      });
      continue;
    }

    const message = formatClassroomTaskMessage(permission.payload);
    const transportResult = await invokeTransportSafely(transport, message, permission, { now });

    let ackOutcome;
    let errorCode = null;
    let providerReference = null;
    let retryDelaySeconds = BACKOFF_BASE_SECONDS;

    if (transportResult.status === "accepted") {
      ackOutcome = "sent";
      providerReference = sanitizeProviderRef(transportResult.providerReference);
    } else if (transportResult.status === "blocked") {
      ackOutcome = "blocked";
      errorCode = sanitizeErrorCode(transportResult.errorCode, "push_no_subscriptions");
    } else if (transportResult.status === "not_accepted") {
      errorCode = sanitizeErrorCode(transportResult.errorCode, "resend_rejected_4xx");
      if (transportResult.permanent) {
        ackOutcome = "dead";
      } else {
        ackOutcome = "retry_wait";
        retryDelaySeconds = computeBackoffSeconds(permission.attempts, randomFn);
      }
    } else {
      ackOutcome = "unknown";
      errorCode = sanitizeErrorCode(transportResult.errorCode, "untyped_transport_error");
    }

    const ack = await repo.ackDelivery({
      deliveryId: claimed.id,
      claimToken: claimed.claim_token,
      outcome: ackOutcome,
      providerReference,
      errorCode,
      retryDelaySeconds,
      maxAttempts,
    });

    if (ack.state === "sent") {
      counters.sent += 1;
      if (ack.event_delivered) {
        counters.eventsDelivered += 1;
        counters.enviados += 1;
      }
      logger?.info?.("notificacion_enviada", {
        classroom_task_event_id: claimed.event_id,
        delivery_id: claimed.id,
        channel: claimed.channel,
        attempts: permission.attempts,
      });
    } else {
      if (ack.state === "retry_wait") {
        counters.retryWait += 1;
        counters.fallidos += 1;
      } else if (ack.state === "unknown") {
        counters.unknown += 1;
        counters.fallidos += 1;
      } else if (ack.state === "dead") {
        counters.dead += 1;
        counters.fallidos += 1;
      } else if (ack.state === "blocked") {
        counters.blocked += 1;
      } else if (ack.state === "cancelled") {
        counters.cancelled += 1;
      }

      logger?.warn?.("notificacion_fallida", {
        classroom_task_event_id: claimed.event_id,
        delivery_id: claimed.id,
        channel: claimed.channel,
        attempts: permission.attempts,
        error_code: errorCode,
      });
    }
  }

  return counters;
}

module.exports = {
  processClassroomDeliveries,
  createClassroomEmailTransport,
  createClassroomWebPushTransport,
  buildClassroomTransports,
  parseClassroomDispatchFlag,
  parseClassroomDispatchAllowedUsers,
  isClassroomUserAllowed,
  loadClassroomDispatchConfig,
  DEFAULT_CLASSROOM_DISPATCH_ALLOWED_USERS,
  computeRecipientFingerprint,
  computeBackoffSeconds,
  formatClassroomTaskMessage,
  toClassroomDeliveryNotif,
  sanitizeErrorCode,
  sanitizeProviderRef,
  resolveEventManifest,
  CLASSROOM_NOTIF_TYPE,
  ERROR_CODE_WHITELIST,
  RESEND_IDEMPOTENCY_TTL_MS,
  DEFAULT_MAX_ATTEMPTS,
};
