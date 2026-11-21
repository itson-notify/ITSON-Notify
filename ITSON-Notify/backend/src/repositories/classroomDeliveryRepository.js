// ITN-50 / ITN-44 - Repositorio del ledger aditivo de entregas de notificaciones
// de Google Classroom (classroom_notification_deliveries, migración 019).
//
// Aislado de notifications_log y grade_changes. Todas las transiciones de estado
// pasan por las RPC transaccionales de la migración 019 (materialize, claim,
// beginSend, ack). Los errores SQL/ACL reales se propagan como fallos de
// infraestructura (500) sin exponer mensajes crudos; las migraciones faltantes se
// reportan como 503.
const { createNotificationRepository } = require("./notificationRepository");

const DISPATCH_EVENT_LIMIT = 100;
const STUDENT_INBOX_LIMIT = 50;

const MISSING_MIGRATION_CODES = new Set(["42883", "PGRST202", "42P01", "PGRST205", "42703"]);

class ClassroomLedgerError extends Error {
  constructor(status, code, step, pgCode = null) {
    super(code);
    this.name = "ClassroomLedgerError";
    this.status = status;
    this.code = code;
    this.step = step;
    this.pgCode = pgCode;
  }
}

function mapSqlError(step, error) {
  const pgCode = error?.code ?? null;
  if (pgCode === "42501" && error?.message === "classroom_authorization_required") {
    return new ClassroomLedgerError(409, "classroom_requiere_autorizacion", step, pgCode);
  }
  if (MISSING_MIGRATION_CODES.has(pgCode)) {
    return new ClassroomLedgerError(503, "classroom_migracion_requerida", step, pgCode);
  }
  if (pgCode === "22023") {
    return new ClassroomLedgerError(400, "parametros_invalidos", step, pgCode);
  }
  return new ClassroomLedgerError(500, "error_interno", step, pgCode);
}

function unwrap(step, { data, error }) {
  if (error) throw mapSqlError(step, error);
  return data;
}

function createClassroomDeliveryRepository(supabase, { pushRepo } = {}) {
  const basePushRepo = pushRepo ?? createNotificationRepository(supabase);

  // Eventos del outbox classroom_task_events aún sin delivered_at.
  async function listUndeliveredEvents(limit = DISPATCH_EVENT_LIMIT) {
    const data = unwrap(
      "list_undelivered_events",
      await supabase
        .from("classroom_task_events")
        .select("id,user_id,coursework_id,event_type,created_at,delivered_at")
        .is("delivered_at", null)
        .order("created_at", { ascending: true })
        .limit(limit),
    );
    return data ?? [];
  }

  // Semilla del destinatario desde google_authorizations para calcular
  // recipient_fingerprint antes de beginSend.
  async function getAuthorizationRecipient(userId) {
    const data = unwrap(
      "get_authorization_recipient",
      await supabase
        .from("google_authorizations")
        .select("user_id,google_id,email,status,scope,created_at")
        .eq("user_id", userId)
        .maybeSingle(),
    );
    return data ?? null;
  }

  // Purga suscripciones de sesiones revocadas (ITN-54) y devuelve si el alumno
  // tiene al menos una suscripción Web Push activa.
  async function hasActivePushSubscriptions(userId) {
    await basePushRepo.purgeRevokedPushSubscriptions(userId);
    const subs = await basePushRepo.listPushSubscriptions(userId);
    return Array.isArray(subs) && subs.length > 0;
  }

  async function materializeEvent({ eventId, channels, policyVersion = "v1" }) {
    const data = unwrap(
      "materialize_classroom_deliveries",
      await supabase.rpc("materialize_classroom_deliveries", {
        p_event_id: eventId,
        p_channels: channels,
        p_policy_version: policyVersion,
      }),
    );
    if (!data || typeof data.status !== "string" || !Array.isArray(data.deliveries)) {
      throw new ClassroomLedgerError(500, "error_interno", "materialize_classroom_deliveries");
    }
    return data;
  }

  async function claimNextDelivery({ leaseSeconds = 60, maxAttempts = 5 } = {}) {
    const data = unwrap(
      "claim_classroom_delivery",
      await supabase.rpc("claim_classroom_delivery", {
        p_lease_seconds: leaseSeconds,
        p_max_attempts: maxAttempts,
      }),
    );
    return data ?? null;
  }

  async function beginSend({
    deliveryId,
    claimToken,
    sendDeadlineSeconds = 30,
    maxAttempts = 5,
    recipientFingerprint = null,
    templateVersion = "v1",
  }) {
    const data = unwrap(
      "begin_classroom_delivery_send",
      await supabase.rpc("begin_classroom_delivery_send", {
        p_delivery_id: deliveryId,
        p_claim_token: claimToken,
        p_send_deadline_seconds: sendDeadlineSeconds,
        p_max_attempts: maxAttempts,
        p_recipient_fingerprint: recipientFingerprint,
        p_template_version: templateVersion,
      }),
    );
    if (!data || typeof data.allowed !== "boolean") {
      throw new ClassroomLedgerError(500, "error_interno", "begin_classroom_delivery_send");
    }
    return data;
  }

  async function ackDelivery({
    deliveryId,
    claimToken,
    outcome,
    providerReference = null,
    errorCode = null,
    retryDelaySeconds = 60,
    maxAttempts = 5,
  }) {
    const data = unwrap(
      "ack_classroom_delivery",
      await supabase.rpc("ack_classroom_delivery", {
        p_delivery_id: deliveryId,
        p_claim_token: claimToken,
        p_outcome: outcome,
        p_provider_reference: providerReference,
        p_error_code: errorCode,
        p_retry_delay_seconds: retryDelaySeconds,
        p_max_attempts: maxAttempts,
      }),
    );
    if (!data || typeof data.acknowledged !== "boolean") {
      throw new ClassroomLedgerError(500, "error_interno", "ack_classroom_delivery");
    }
    return data;
  }

  // Lector aditivo para la bandeja de la app (GET /api/notifications): devuelve
  // una entrada por event_id que ya haya sido entregada (state = 'sent') al alumno.
  async function listStudentDeliveredEvents(userId, limit = STUDENT_INBOX_LIMIT) {
    let queryResult;
    try {
      queryResult = await supabase
        .from("classroom_notification_deliveries")
        .select("id,user_id,event_id,channel,payload,state,sent_at,read_at,created_at")
        .eq("user_id", userId)
        .eq("state", "sent")
        .order("created_at", { ascending: false })
        .limit(limit * 2);
    } catch (err) {
      if (/Tabla desconocida en el fake/.test(err?.message ?? "")) return [];
      throw err;
    }
    const { data, error } = queryResult;

    if (error) {
      // Si la migración 019 aún no está aplicada, la bandeja de calificaciones sigue funcionando.
      if (MISSING_MIGRATION_CODES.has(error.code)) return [];
      throw mapSqlError("list_student_delivered_events", error);
    }

    const byEvent = new Map();
    for (const row of data ?? []) {
      const prev = byEvent.get(row.event_id);
      if (!prev) {
        byEvent.set(row.event_id, row);
      } else if (row.read_at && !prev.read_at) {
        prev.read_at = row.read_at;
      }
    }
    return [...byEvent.values()].slice(0, limit);
  }

  async function markDeliveryRead(userId, idOrEventId, readAt) {
    let byEventRes;
    try {
      byEventRes = await supabase
        .from("classroom_notification_deliveries")
        .select("id,event_id,read_at")
        .eq("user_id", userId)
        .eq("state", "sent")
        .eq("event_id", idOrEventId);
    } catch (err) {
      if (/Tabla desconocida en el fake/.test(err?.message ?? "")) return false;
      throw err;
    }

    if (byEventRes.error) {
      if (MISSING_MIGRATION_CODES.has(byEventRes.error.code)) return false;
      throw mapSqlError("mark_delivery_read_select", byEventRes.error);
    }

    let rows = byEventRes.data ?? [];
    if (rows.length === 0) {
      const byIdRes = await supabase
        .from("classroom_notification_deliveries")
        .select("id,event_id,read_at")
        .eq("user_id", userId)
        .eq("state", "sent")
        .eq("id", idOrEventId);
      if (byIdRes.error) {
        if (MISSING_MIGRATION_CODES.has(byIdRes.error.code)) return false;
        throw mapSqlError("mark_delivery_read_select", byIdRes.error);
      }
      rows = byIdRes.data ?? [];
    }

    if (rows.length === 0) return false;

    const eventId = rows[0].event_id;
    const pendientes = rows.some((r) => r.read_at == null);
    if (pendientes) {
      unwrap(
        "mark_delivery_read_update",
        await supabase
          .from("classroom_notification_deliveries")
          .update({ read_at: readAt, updated_at: readAt })
          .eq("user_id", userId)
          .eq("event_id", eventId)
          .is("read_at", null),
      );
    }
    return true;
  }

  async function markAllDeliveriesRead(userId, readAt) {
    let res;
    try {
      res = await supabase
        .from("classroom_notification_deliveries")
        .update({ read_at: readAt, updated_at: readAt })
        .eq("user_id", userId)
        .eq("state", "sent")
        .is("read_at", null);
    } catch (err) {
      if (/Tabla desconocida en el fake/.test(err?.message ?? "")) return;
      throw err;
    }

    if (res?.error && !MISSING_MIGRATION_CODES.has(res.error.code)) {
      throw mapSqlError("mark_all_deliveries_read", res.error);
    }
  }

  return {
    listUndeliveredEvents,
    getAuthorizationRecipient,
    hasActivePushSubscriptions,
    materializeEvent,
    claimNextDelivery,
    beginSend,
    ackDelivery,
    listStudentDeliveredEvents,
    markDeliveryRead,
    markAllDeliveriesRead,
    pushRepo: basePushRepo,
  };
}

module.exports = {
  createClassroomDeliveryRepository,
  ClassroomLedgerError,
  DISPATCH_EVENT_LIMIT,
  MISSING_MIGRATION_CODES,
};
