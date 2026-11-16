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
const PAGE = 1000;

// Códigos de Postgres cuando una migración opcional aún no está aplicada.
const UNDEFINED_COLUMN = "42703";
const UNDEFINED_TABLE = "42P01";

const SNAPSHOT_GRADE_COLS = "id,snapshot_id,subject_id,external_item_id,grade_label,grade_value,grade_text,raw_payload";
const SNAPSHOT_GRADE_COLS_WITH_DUE = `${SNAPSHOT_GRADE_COLS},due_at`;

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
    const filas = [];
    for (const parte of trozos(ids, IDS_PER_QUERY)) {
      filas.push(
        ...check(
          "subjects",
          await supabase.from("subjects").select("id,name").eq("user_id", userId).in("id", parte),
        ),
      );
    }
    return filas;
  }

  // ITN-57 - Una materia por id, solo si pertenece al alumno de la sesión.
  async function getSubject(userId, subjectId) {
    return check(
      "subjects",
      await supabase.from("subjects").select("id,name,period").eq("user_id", userId).eq("id", subjectId).maybeSingle(),
    );
  }

  // ITN-57 - Último snapshot de iVirtual del alumno, o null si aún no hay corrida.
  async function getLatestIvirtualSnapshot(userId) {
    const filas = check(
      "grade_snapshots",
      await supabase
        .from("grade_snapshots")
        .select("id,source,captured_at")
        .eq("user_id", userId)
        .eq("source", "ivirtual")
        .order("captured_at", { ascending: false })
        .order("id", { ascending: false })
        .limit(1),
    );
    return filas[0] ? { ...filas[0], period: null } : null;
  }

  // ITN-57 - Último snapshot de iVirtual y último snapshot por semestre (period) de
  // itson_api del alumno. Si falta la migración 012 (42703 al leer period), cae a
  // period null sin romper la lectura.
  async function listLatestSnapshots(userId) {
    const ivirtual = await getLatestIvirtualSnapshot(userId);

    const consultarItson = (cols) =>
      supabase
        .from("grade_snapshots")
        .select(cols)
        .eq("user_id", userId)
        .eq("source", "itson_api")
        .order("captured_at", { ascending: false })
        .order("id", { ascending: false })
        .limit(PAGE);

    let res = await consultarItson("id,source,period,captured_at");
    let sinPeriodo = false;
    if (res.error?.code === UNDEFINED_COLUMN) {
      sinPeriodo = true;
      res = await consultarItson("id,source,captured_at");
    }
    const filasItson = check("grade_snapshots", res);

    const vistos = new Set();
    const itsonPorPeriodo = [];
    for (const fila of filasItson) {
      const period = sinPeriodo ? null : fila.period ?? null;
      const llave = period ?? "";
      if (vistos.has(llave)) continue;
      vistos.add(llave);
      itsonPorPeriodo.push({ ...fila, period });
    }

    return [...(ivirtual ? [ivirtual] : []), ...itsonPorPeriodo];
  }

  // ITN-57 - Filas de snapshot_grades de uno o varios snapshots. Si falta la
  // migración 013 (42703 al leer due_at), vuelve a consultar sin due_at y lo deja
  // en null.
  async function listSnapshotGrades(snapshotIds, { subjectId = null } = {}) {
    if (snapshotIds.length === 0) return [];
    const filas = [];
    let conFecha = true;

    for (let from = 0; ; from += PAGE) {
      const armar = (cols) => {
        let q = supabase
          .from("snapshot_grades")
          .select(cols)
          .in("snapshot_id", snapshotIds)
          .order("id", { ascending: true })
          .range(from, from + PAGE - 1);
        if (subjectId) q = q.eq("subject_id", subjectId);
        return q;
      };

      let res = await armar(conFecha ? SNAPSHOT_GRADE_COLS_WITH_DUE : SNAPSHOT_GRADE_COLS);
      if (conFecha && res.error?.code === UNDEFINED_COLUMN) {
        conFecha = false;
        res = await armar(SNAPSHOT_GRADE_COLS);
      }
      const pagina = check("snapshot_grades", res);
      filas.push(...pagina.map((r) => (conFecha ? r : { ...r, due_at: null })));
      if (pagina.length < PAGE) return filas;
    }
  }

  // ITN-57 - Cursos de Google Classroom del alumno (migración 006). Si la tabla no
  // existe (42P01), devuelve lista vacía.
  async function listClassroomCourses(userId) {
    const res = await supabase
      .from("classroom_courses")
      .select("id,name,section,last_seen_at,updated_at,created_at")
      .eq("user_id", userId)
      .order("id", { ascending: true });
    if (res.error?.code === UNDEFINED_TABLE) return [];
    return check("classroom_courses", res);
  }

  async function getClassroomCourse(userId, courseId) {
    const res = await supabase
      .from("classroom_courses")
      .select("id,name,section,last_seen_at,updated_at,created_at")
      .eq("user_id", userId)
      .eq("id", courseId)
      .maybeSingle();
    if (res.error?.code === UNDEFINED_TABLE) return null;
    return check("classroom_courses", res);
  }

  async function listClassroomCoursework(userId, courseId) {
    const res = await supabase
      .from("classroom_coursework")
      .select("id,title,due_at,max_points")
      .eq("user_id", userId)
      .eq("course_id", courseId)
      .order("id", { ascending: true });
    if (res.error?.code === UNDEFINED_TABLE) return [];
    return check("classroom_coursework", res);
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

  return {
    getProfile,
    listNotifications,
    getGradeChanges,
    getSubjects,
    getSubject,
    getLatestIvirtualSnapshot,
    listLatestSnapshots,
    listSnapshotGrades,
    listClassroomCourses,
    getClassroomCourse,
    listClassroomCoursework,
    markRead,
    markAllRead,
  };
}

module.exports = { createStudentRepository, NOTIFICATION_CHANNEL, NOTIFICATIONS_LIMIT };
