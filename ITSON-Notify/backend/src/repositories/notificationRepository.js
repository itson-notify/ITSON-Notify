// ITN-28 - Repo real de notificationService sobre Supabase (notifications_log,
// migración 002, y push_subscriptions, migración 009). Contrato en
// backend/src/services/README.md.
const { check } = require("../utils/errors");

// unique (grade_change_id, channel) de la migración 002.
const NOTIFICATIONS_ON_CONFLICT = "grade_change_id,channel";
const PUSH_SUBSCRIPTIONS_ON_CONFLICT = "user_id,endpoint";

const LOG_COLUMNS = "id,user_id,grade_change_id,channel,payload,status,attempts";
const PUSH_COLUMNS = "id,user_id,endpoint,p256dh,auth,user_agent";

// Tope de pendientes que se reintentan por corrida; el resto queda para la
// siguiente.
const PENDING_LIMIT = 100;

const contextKey = (subjectId, externalItemId) => `${subjectId}\u0000${externalItemId}`;

function createNotificationRepository(supabase) {
  // Inserta la fila en 'pending' ignorando el conflicto. Con ignoreDuplicates,
  // .select() devuelve vacío si ya existía: entonces se lee la existente sin
  // modificarla.
  async function claimNotification(row) {
    const inserted = check(
      "notifications_log",
      await supabase
        .from("notifications_log")
        .upsert(
          { ...row, status: "pending", attempts: 0 },
          { onConflict: NOTIFICATIONS_ON_CONFLICT, ignoreDuplicates: true },
        )
        .select(LOG_COLUMNS),
    );
    if (inserted.length === 1) return inserted[0];

    return check(
      "notifications_log",
      await supabase
        .from("notifications_log")
        .select(LOG_COLUMNS)
        .eq("grade_change_id", row.grade_change_id)
        .eq("channel", row.channel)
        .single(),
    );
  }

  async function updateNotification(id, patch) {
    check("notifications_log", await supabase.from("notifications_log").update(patch).eq("id", id));
  }

  // Filas del usuario que quedaron 'pending' o 'failed' y aún pueden
  // reintentarse. Sin grade_change_id (cambio borrado) no se reintenta.
  async function listPendingNotifications(userId, maxAttempts) {
    return check(
      "notifications_log",
      await supabase
        .from("notifications_log")
        .select(LOG_COLUMNS)
        .eq("user_id", userId)
        .in("status", ["pending", "failed"])
        .lt("attempts", maxAttempts)
        .not("grade_change_id", "is", null)
        .order("created_at", { ascending: true })
        .limit(PENDING_LIMIT),
    );
  }

  // Nombre de la materia y label del ítem para cada grupo, con una consulta
  // por tabla. refs: [{ subjectId, externalItemId, snapshotId }], donde
  // snapshotId es el snapshot donde está el ítem (el anterior si se borró).
  // Devuelve Map(contextKey -> { subjectName?, itemLabel? }). itemLabel null
  // es el total del curso; si no se encontró la fila, queda undefined.
  async function getItemContext(refs) {
    const context = new Map();
    if (refs.length === 0) return context;
    const unicos = (campo) => [...new Set(refs.map((r) => r[campo]).filter((v) => v != null))];

    const subjectIds = unicos("subjectId");
    const subjects = subjectIds.length
      ? check(
          "subjects",
          await supabase.from("subjects").select("id,name").in("id", subjectIds),
        )
      : [];
    const nombres = new Map(subjects.map((s) => [s.id, s.name]));

    const snapshotIds = unicos("snapshotId");
    const grades = snapshotIds.length
      ? check(
          "snapshot_grades",
          await supabase
            .from("snapshot_grades")
            .select("snapshot_id,subject_id,external_item_id,grade_label")
            .in("snapshot_id", snapshotIds)
            .in("subject_id", subjectIds)
            .in("external_item_id", unicos("externalItemId")),
        )
      : [];

    for (const ref of refs) {
      const fila = grades.find(
        (g) =>
          g.snapshot_id === ref.snapshotId &&
          g.subject_id === ref.subjectId &&
          g.external_item_id === ref.externalItemId,
      );
      context.set(contextKey(ref.subjectId, ref.externalItemId), {
        subjectName: nombres.get(ref.subjectId),
        itemLabel: fila ? fila.grade_label : undefined,
      });
    }
    return context;
  }

  // Guarda o actualiza la suscripción Web Push de un dispositivo del alumno.
  async function savePushSubscription({ userId, endpoint, p256dh, auth, userAgent = null }) {
    const rows = check(
      "push_subscriptions",
      await supabase
        .from("push_subscriptions")
        .upsert(
          {
            user_id: userId,
            endpoint,
            p256dh,
            auth,
            user_agent: userAgent,
            updated_at: new Date().toISOString(),
          },
          { onConflict: PUSH_SUBSCRIPTIONS_ON_CONFLICT },
        )
        .select(PUSH_COLUMNS),
    );
    return rows[0] ?? null;
  }

  async function listPushSubscriptions(userId) {
    return check(
      "push_subscriptions",
      await supabase.from("push_subscriptions").select(PUSH_COLUMNS).eq("user_id", userId),
    );
  }

  async function deletePushSubscription(userId, endpoint) {
    check(
      "push_subscriptions",
      await supabase.from("push_subscriptions").delete().eq("user_id", userId).eq("endpoint", endpoint),
    );
  }

  return {
    claimNotification,
    updateNotification,
    listPendingNotifications,
    getItemContext,
    savePushSubscription,
    listPushSubscriptions,
    deletePushSubscription,
  };
}

module.exports = {
  createNotificationRepository,
  contextKey,
  NOTIFICATIONS_ON_CONFLICT,
  PUSH_SUBSCRIPTIONS_ON_CONFLICT,
  PENDING_LIMIT,
};