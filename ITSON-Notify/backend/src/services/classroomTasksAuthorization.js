// ITN-43c - Autorización opcional de tareas de Classroom (CLASSROOM_WORK_SCOPE).
// El login sigue pidiendo solo cursos; el alumno activa las tareas desde Ajustes con
// autorización incremental y puede desactivarlas. Nunca se persiste el access token.
// Ni este módulo ni sus llamadores registran tokens, scopes ni datos académicos.
const { encrypt } = require("../utils/secureToken");
const {
  CLASSROOM_SCOPE, hasScope, tienePermisoTareas, classroomScopesOnly,
} = require("./googleAuthService");
const { isMissingAuthorizationStatus } = require("./googleAuthorizationSchema");

// `status` es el HTTP que corresponde; `code`, el código fijo que se expone. Nunca lleva el
// mensaje de Supabase.
class TasksAuthorizationError extends Error {
  constructor(code, status = 400) {
    super(code);
    this.code = code;
    this.status = status;
  }
}

// Funciones de la migración 018. Son el ÚNICO camino de escritura: sin ellas no se escribe
// nada por otra vía y se responde MIGRATION_PENDING (503).
const ACTIVATE_RPC = "activate_classroom_tasks";
const DISABLE_RPC = "disable_classroom_tasks";
// PGRST202: PostgREST no encuentra la función; 42883: Postgres no la encuentra (firma vieja).
const MISSING_FUNCTION = new Set(["PGRST202", "42883"]);
const MIGRATION_PENDING = "migracion_pendiente";
const REQUIRES_AUTHORIZATION = "classroom_requiere_autorizacion";
const INTERNAL_ERROR = "error_interno";
// Solo el 42501 de negocio de la 018; un 42501 de infraestructura (permiso de service_role)
// es un fallo del servidor y va como 500.
const isAuthorizationRequired = error => error?.code === "42501" && error?.message === "classroom_authorization_required";

// Traduce el error de la RPC a un código fijo. Nunca reintenta ni escribe por otro camino.
function rpcFailure(error) {
  if (MISSING_FUNCTION.has(error?.code)) return new TasksAuthorizationError(MIGRATION_PENDING, 503);
  if (isAuthorizationRequired(error)) return new TasksAuthorizationError(REQUIRES_AUTHORIZATION, 403);
  return new TasksAuthorizationError(INTERNAL_ERROR, 500);
}

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
    // Cualquiera de los dos nombres del permiso de tareas (ver tienePermisoTareas).
    granted: Boolean(grant) && !needsRelink && tienePermisoTareas(grant.scope),
    needsRelink,
  };
}

// Une el scope de tareas al grant guardado (sin quitar el de cursos) y, si no estaban
// activas, limpia la baseline: todo dentro de activate_classroom_tasks (018), en una
// transacción con el mismo candado que sync_classroom. `grantedScope` es el scope que informó
// el endpoint de tokens de Google; `refreshToken`, el nuevo si Google mandó uno (se cifra aquí;
// si no hay, la función conserva el anterior).
// A la base solo viajan los scopes de Classroom que Google concedió, en el orden de Google y
// sin duplicados. openid, email, profile o cualquier otro se descartan: no deben acabar en el
// scope guardado del grant. El nombre del permiso de tareas viaja tal como lo devolvió Google
// (canónico o alias empírico); la 018 acepta ambos (ver tienePermisoTareas).
async function activateTasks({ supabase, identity, grantedScope, refreshToken, secret }) {
  if (!tienePermisoTareas(grantedScope)) throw new TasksAuthorizationError("tareas_no_concedidas");
  // Un refresh token nuevo sustituye al anterior: debe seguir cubriendo los cursos.
  if (refreshToken && !hasScope(grantedScope, CLASSROOM_SCOPE)) {
    throw new TasksAuthorizationError("cursos_no_incluidos");
  }
  const { error } = await supabase.rpc(ACTIVATE_RPC, {
    p_user_id: identity.userId,
    p_google_id: identity.googleId,
    p_granted_scope: classroomScopesOnly(grantedScope),
    p_refresh_token: refreshToken ? encrypt({ token: refreshToken }, secret, "google-refresh") : null,
  });
  if (error) throw rpcFailure(error);
}

// Desactiva las tareas con disable_classroom_tasks (018): quita el scope, borra tareas y
// eventos del alumno y deja coursework_baseline_at en null, en una transacción. Regla de
// autorización: debe existir el grant de ese user_id y google_id, con cualquier status
// (needs_relink también desactiva); sin él la función lanza 42501 y no borra nada.
async function disableTasks(supabase, { userId, googleId }) {
  const { error } = await supabase.rpc(DISABLE_RPC, { p_user_id: userId, p_google_id: googleId });
  if (error) throw rpcFailure(error);
}

module.exports = {
  TasksAuthorizationError, getTasksAuthorization, activateTasks, disableTasks, isUsableGrant, loadGrant,
  MIGRATION_PENDING, REQUIRES_AUTHORIZATION, INTERNAL_ERROR,
};
