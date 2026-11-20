// ITN-50 - Repo del despacho de tareas nuevas de Classroom.
// Lee el outbox classroom_task_events (016) y registra cada envío en el ledger
// notifications_log (002), igual que los avisos de iVirtual.
//
// Llave de idempotencia sin migración: notifications_log.grade_change_id es una
// llave foránea a grade_changes, así que no puede llevar el id del evento. En su
// lugar, el id de la fila del ledger se deriva del evento y el canal
// (classroomNotificationId) y el reclamo es el mismo de claimNotification
// (upsert con ignoreDuplicates y, si ya existía, lectura de la fila), pero
// contra la llave primaria. Dos corridas del mismo evento y canal caen siempre en
// la misma fila: la base garantiza que no hay dos avisos.
const crypto = require("crypto");
const { check } = require("../utils/errors");

const LOG_COLUMNS = "id,user_id,grade_change_id,channel,payload,status,attempts";

// Eventos por corrida; el resto queda para la siguiente.
const DISPATCH_LIMIT = 100;

// UUID estable (formato v5: versión 5, variante RFC 4122) a partir del evento y
// el canal. Nunca choca con los gen_random_uuid() (versión 4) del resto del ledger.
function classroomNotificationId(eventId, channel) {
  const h = crypto
    .createHash("sha256")
    .update(`itson-notify:classroom-task-event:${eventId}:${channel}`, "utf8")
    .digest();
  h[6] = (h[6] & 0x0f) | 0x50;
  h[8] = (h[8] & 0x3f) | 0x80;
  const hex = h.subarray(0, 16).toString("hex");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

function createClassroomDispatchRepository(supabase) {
  // Pendientes más antiguos primero.
  async function listPendingEvents(limit = DISPATCH_LIMIT) {
    return check(
      "classroom_task_events",
      await supabase
        .from("classroom_task_events")
        .select("id,user_id,coursework_id,created_at")
        .is("delivered_at", null)
        .order("created_at", { ascending: true })
        .limit(limit),
    );
  }

  // Tarea y curso de cada evento, con una consulta por tabla.
  // Devuelve Map(coursework_id -> { userId, title, dueAt, state, courseName, baselineAt }).
  // coursework_baseline_at es de la 017: sin ella la consulta falla con 42703.
  async function getEventContext(events) {
    const context = new Map();
    const ids = [...new Set(events.map((e) => e.coursework_id))];
    if (ids.length === 0) return context;
    const works = check(
      "classroom_coursework",
      await supabase.from("classroom_coursework").select("id,user_id,course_id,title,due_at,state").in("id", ids),
    );
    const courseIds = [...new Set(works.map((w) => w.course_id))];
    const courses = courseIds.length
      ? check(
          "classroom_courses",
          await supabase
            .from("classroom_courses")
            .select("id,user_id,name,coursework_baseline_at")
            .in("id", courseIds),
        )
      : [];
    const porId = new Map(courses.map((c) => [c.id, c]));
    for (const w of works) {
      const course = porId.get(w.course_id);
      if (!course || course.user_id !== w.user_id) continue;
      context.set(w.id, {
        userId: w.user_id,
        title: w.title,
        dueAt: w.due_at ?? null,
        state: w.state,
        courseName: course.name,
        baselineAt: course.coursework_baseline_at ?? null,
      });
    }
    return context;
  }

  // Solo marca si sigue pendiente: una segunda corrida no reescribe la fecha.
  async function markDelivered(eventId, deliveredAt) {
    check(
      "classroom_task_events",
      await supabase
        .from("classroom_task_events")
        .update({ delivered_at: deliveredAt })
        .eq("id", eventId)
        .is("delivered_at", null),
    );
  }

  // row: { event_id, user_id, channel, payload }.
  async function claimNotification({ event_id, user_id, channel, payload }) {
    const id = classroomNotificationId(event_id, channel);
    const inserted = check(
      "notifications_log",
      await supabase
        .from("notifications_log")
        .upsert(
          { id, user_id, grade_change_id: null, channel, payload, status: "pending", attempts: 0 },
          { onConflict: "id", ignoreDuplicates: true },
        )
        .select(LOG_COLUMNS),
    );
    if (inserted.length === 1) return inserted[0];
    return check(
      "notifications_log",
      await supabase.from("notifications_log").select(LOG_COLUMNS).eq("id", id).eq("user_id", user_id).single(),
    );
  }

  async function updateNotification(id, patch) {
    check("notifications_log", await supabase.from("notifications_log").update(patch).eq("id", id));
  }

  return { listPendingEvents, getEventContext, markDelivered, claimNotification, updateNotification };
}

module.exports = { createClassroomDispatchRepository, classroomNotificationId, DISPATCH_LIMIT };
