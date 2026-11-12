// ITN-53 - Lecturas y marcas de lectura del alumno para /api. Todas las consultas
// filtran por el user_id de la sesión: un id del cliente nunca basta para llegar
// a una fila de otro alumno.
const { check } = require("../utils/errors");

// Una fila de notifications_log por aviso y canal: el canal log siempre existe,
// así que sus filas dan exactamente una notificación por aviso.
const NOTIFICATION_CHANNEL = "log";
const NOTIFICATIONS_LIMIT = 100;

// Hasta 3 filas de grade_changes por aviso: se parte el .in() para no pasarse del
// largo de URL de PostgREST.
const IDS_PER_QUERY = 100;

function trozos(lista, tamano) {
  const salida = [];
  for (let i = 0; i < lista.length; i += tamano) salida.push(lista.slice(i, i + tamano));
  return salida;
}

function createStudentRepository(supabase) {
  // Solo columnas con datos para mostrar: nunca ciphertext ni tokens.
  async function getProfile(userId) {
    const user = check(
      "app_users",
      await supabase.from("app_users").select("email").eq("id", userId).maybeSingle(),
    );
    if (!user) return null;

    const authorization = check(
      "google_authorizations",
      await supabase.from("google_authorizations").select("google_id").eq("user_id", userId).maybeSingle(),
    );
    const credentials = check(
      "student_credentials",
      await supabase.from("student_credentials").select("status").eq("user_id", userId).eq("portal", "ivirtual"),
    );
    return {
      email: user.email,
      googleId: authorization?.google_id ?? null,
      credentialStatuses: credentials.map((c) => c.status),
    };
  }

  async function listNotifications(userId) {
    return check(
      "notifications_log",
      await supabase
        .from("notifications_log")
        .select("id,grade_change_id,payload,created_at,read_at")
        .eq("user_id", userId)
        .eq("channel", NOTIFICATION_CHANNEL)
        .order("created_at", { ascending: false })
        .order("id", { ascending: false })
        .limit(NOTIFICATIONS_LIMIT),
    );
  }

  async function getGradeChanges(userId, ids) {
    const filas = [];
    for (const parte of trozos(ids, IDS_PER_QUERY)) {
      filas.push(
        ...check(
          "grade_changes",
          await supabase
            .from("grade_changes")
            .select("id,subject_id,field_name,previous_value,current_value,change_type")
            .eq("user_id", userId)
            .in("id", parte),
        ),
      );
    }
    return filas;
  }

  async function getSubjects(userId, ids) {
    if (ids.length === 0) return [];
    return check(
      "subjects",
      await supabase.from("subjects").select("id,name").eq("user_id", userId).in("id", ids),
    );
  }

  // Devuelve false si la notificación no existe o es de otro alumno.
  async function markRead(userId, id, readAt) {
    const filas = check(
      "notifications_log",
      await supabase
        .from("notifications_log")
        .update({ read_at: readAt })
        .eq("id", id)
        .eq("user_id", userId)
        .eq("channel", NOTIFICATION_CHANNEL)
        .select("id"),
    );
    return filas.length > 0;
  }

  async function markAllRead(userId, readAt) {
    check(
      "notifications_log",
      await supabase
        .from("notifications_log")
        .update({ read_at: readAt })
        .eq("user_id", userId)
        .eq("channel", NOTIFICATION_CHANNEL)
        .is("read_at", null),
    );
  }

  return { getProfile, listNotifications, getGradeChanges, getSubjects, markRead, markAllRead };
}

module.exports = { createStudentRepository, NOTIFICATION_CHANNEL, NOTIFICATIONS_LIMIT };
