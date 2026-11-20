// ITN-43c - Autorización opcional de tareas de Classroom (CLASSROOM_WORK_SCOPE).
// El login sigue pidiendo solo cursos; el alumno activa las tareas desde Ajustes con
// autorización incremental y puede desactivarlas. Nunca se persiste el access token.
// Ni este módulo ni sus llamadores registran tokens, scopes ni datos académicos.
const { encrypt } = require("../utils/secureToken");
const {
  CLASSROOM_SCOPE, CLASSROOM_WORK_SCOPE, hasScope, withoutScope, unionScopes,
} = require("./googleAuthService");
const { isMissingAuthorizationStatus } = require("./googleAuthorizationSchema");

class TasksAuthorizationError extends Error {
  constructor(code) {
    super(code);
    this.code = code;
  }
}

// Función de la migración 018 (opcional). Sin ella se usa el orden seguro en JS.
const DISABLE_RPC = "disable_classroom_tasks";
const MISSING_FUNCTION = new Set(["PGRST202", "42883"]);

async function loadGrant(supabase, { userId, googleId }) {
  const load = columns => supabase.from("google_authorizations").select(columns)
    .eq("user_id", userId).eq("google_id", googleId).maybeSingle();
  let { data, error } = await load("user_id, google_id, scope, status");
  if (isMissingAuthorizationStatus(error)) ({ data, error } = await load("user_id, google_id, scope"));
  if (error) throw error;
  return data && data.user_id === userId && data.google_id === googleId ? data : null;
}

// Un grant utilizable para pedir tareas: mismo alumno y google_id, sin needs_relink y
// con el scope de cursos del login.
function isUsableGrant(grant) {
  return Boolean(grant) && grant.status !== "needs_relink" && hasScope(grant.scope, CLASSROOM_SCOPE);
}

async function getTasksAuthorization(supabase, identity) {
  const grant = await loadGrant(supabase, identity);
  const needsRelink = grant?.status === "needs_relink";
  return {
    granted: Boolean(grant) && !needsRelink && hasScope(grant.scope, CLASSROOM_WORK_SCOPE),
    needsRelink,
  };
}

// Une el scope de tareas al grant guardado (sin quitar el de cursos). `grantedScope`
// es el scope que informó el endpoint de tokens de Google; `refreshToken`, el nuevo si
// Google mandó uno (si no, se conserva el anterior).
async function activateTasks({ supabase, identity, grantedScope, refreshToken, secret }) {
  if (!hasScope(grantedScope, CLASSROOM_WORK_SCOPE)) throw new TasksAuthorizationError("tareas_no_concedidas");
  // Un refresh token nuevo sustituye al anterior: debe seguir cubriendo los cursos.
  if (refreshToken && !hasScope(grantedScope, CLASSROOM_SCOPE)) {
    throw new TasksAuthorizationError("cursos_no_incluidos");
  }
  const grant = await loadGrant(supabase, identity);
  if (!isUsableGrant(grant)) throw new TasksAuthorizationError("autorizacion_no_activa");
  const { userId, googleId } = identity;

  // Si las tareas no estaban activas, la primera sync con tareas debe ser baseline
  // silencioso: se limpia antes de ampliar el scope, así ninguna sync intermedia lee
  // tareas. Requiere la 017 (coursework_baseline_at); sin ella falla sin tocar el grant.
  if (!hasScope(grant.scope, CLASSROOM_WORK_SCOPE)) {
    const { error } = await supabase.from("classroom_courses")
      .update({ coursework_baseline_at: null }).eq("user_id", userId);
    if (error) throw error;
  }

  const row = { scope: unionScopes(grant.scope, grantedScope, CLASSROOM_WORK_SCOPE), updated_at: new Date().toISOString() };
  if (refreshToken) {
    row.refresh_token = encrypt({ token: refreshToken }, secret, "google-refresh");
    row.status = "active";
  }
  const save = value => supabase.from("google_authorizations").update(value)
    .eq("user_id", userId).eq("google_id", googleId);
  let { error } = await save(row);
  if (row.status && isMissingAuthorizationStatus(error)) {
    const { status: _status, ...legacy } = row;
    ({ error } = await save(legacy));
  }
  if (error) throw error;
}

// Desactiva las tareas: quita el scope, borra tareas y eventos del alumno y deja
// coursework_baseline_at en null para que una reactivación sea baseline silencioso.
// Con la migración 018 todo ocurre en una transacción; sin ella, en este orden:
// 1) scope (la sync deja de leer tareas), 2) eventos, 3) tareas, 4) baseline.
// Cada paso es idempotente: si uno falla, repetir el DELETE completa la limpieza.
// Autorización (igual que la 018): debe existir el grant de ese user_id y google_id, con
// cualquier status (needs_relink también desactiva: el alumno puede borrar sus datos aunque
// su token esté roto). Sin grant no se borra nada y se lanza DISABLE_REQUIRES_AUTHORIZATION.
const DISABLE_REQUIRES_AUTHORIZATION = "classroom_requiere_autorizacion";
const isAuthorizationRequired = error => error?.code === "42501" && error?.message === "classroom_authorization_required";

async function disableTasks(supabase, { userId, googleId }) {
  const { error: rpcError } = await supabase.rpc(DISABLE_RPC, { p_user_id: userId, p_google_id: googleId });
  if (!rpcError) return;
  if (isAuthorizationRequired(rpcError)) throw new TasksAuthorizationError(DISABLE_REQUIRES_AUTHORIZATION);
  if (!MISSING_FUNCTION.has(rpcError.code)) throw rpcError;

  const grant = await loadGrant(supabase, { userId, googleId });
  if (!grant) throw new TasksAuthorizationError(DISABLE_REQUIRES_AUTHORIZATION);
  if (hasScope(grant.scope, CLASSROOM_WORK_SCOPE)) {
    const { error } = await supabase.from("google_authorizations")
      .update({ scope: withoutScope(grant.scope, CLASSROOM_WORK_SCOPE), updated_at: new Date().toISOString() })
      .eq("user_id", userId).eq("google_id", googleId);
    if (error) throw error;
  }
  const steps = [
    () => supabase.from("classroom_task_events").delete().eq("user_id", userId),
    () => supabase.from("classroom_coursework").delete().eq("user_id", userId),
    () => supabase.from("classroom_courses").update({ coursework_baseline_at: null }).eq("user_id", userId),
  ];
  for (const step of steps) {
    const { error } = await step();
    if (error) throw error;
  }
}

module.exports = {
  TasksAuthorizationError, getTasksAuthorization, activateTasks, disableTasks, isUsableGrant, loadGrant,
  DISABLE_REQUIRES_AUTHORIZATION,
};
