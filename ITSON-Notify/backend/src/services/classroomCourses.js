// ITN-42: reuse ITN-41 encryption and ITN-49 pagination. No token persistence.
const { decrypt } = require('../utils/secureToken');
const { CLASSROOM_SCOPE, tienePermisoTareas, cumpleScopes } = require('./googleAuthService');
const { normalizeCourses, persistClassroom } = require('./classroomSync');
const { createClassroomClient, ClassroomError } = require('./classroomClient');
const { isMissingAuthorizationStatus } = require('./googleAuthorizationSchema');
const { normalizeSubmissions, persistSubmissions, SubmissionsSyncError, MISSING_MIGRATION } = require('./classroomSubmissions');

class CoursesError extends Error {
  constructor(status, code) {
    super(code);
    this.status = status;
    this.code = code;
  }
}
const relink = () => new CoursesError(409, 'classroom_requiere_autorizacion');
const upstream = () => new CoursesError(502, 'classroom_respuesta_invalida');
function numericFields(value, keys) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw upstream();
  const result = {};
  for (const key of keys) {
    if (value[key] === undefined) continue;
    if (!Number.isInteger(value[key]) || value[key] < 0) throw upstream();
    result[key] = value[key];
  }
  return result;
}

function createCoursesService({ config, supabase, fetchImpl = globalThis.fetch, timeoutMs = 15000 }) {
  const client = createClassroomClient({ fetchImpl, timeoutMs });

  async function refresh(refreshToken, requiredScopes) {
    const oauth = config.googleOAuth;
    if (!oauth?.enabled || !oauth.clientId || !oauth.clientSecret) {
      throw new CoursesError(503, 'classroom_no_disponible');
    }
    try {
      const response = await fetchImpl('https://oauth2.googleapis.com/token', {
        method: 'POST', redirect: 'error', signal: AbortSignal.timeout(timeoutMs),
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({ grant_type: 'refresh_token', refresh_token: refreshToken,
          client_id: oauth.clientId, client_secret: oauth.clientSecret }).toString(),
      });
      if (!response.ok) {
        if (response.status === 400 || response.status === 401) {
          const data = await response.json();
          if (data?.error === 'invalid_grant') throw relink();
        }
        throw new CoursesError(response.status === 429 || response.status >= 500 ? 503 : 502,
          'classroom_token_no_disponible');
      }
      const data = await response.json();
      if (!data || typeof data.access_token !== 'string' ||
          !/^[A-Za-z0-9._~+\/-]+=*$/.test(data.access_token) ||
          typeof data.token_type !== 'string' || data.token_type.toLowerCase() !== 'bearer' ||
          !Number.isFinite(data.expires_in) || data.expires_in <= 0) throw upstream();
      if (data.scope !== undefined && (typeof data.scope !== 'string' ||
          !cumpleScopes(data.scope, requiredScopes))) {
        throw new CoursesError(403, 'classroom_sin_permisos');
      }
      return { accessToken: data.access_token, scope: data.scope };
    } catch (error) {
      if (error instanceof CoursesError) throw error;
      if (error instanceof SyntaxError) throw upstream();
      throw new CoursesError(503, 'classroom_no_disponible');
    }
  }

  // Returns the access token plus the stored and refreshed scope strings (never logged).
  async function authorize({ userId, googleId }, requiredScopes = [CLASSROOM_SCOPE]) {
    const load = columns => supabase.from('google_authorizations').select(columns)
      .eq('user_id', userId).eq('google_id', googleId).maybeSingle();
    let { data, error } = await load('user_id,google_id,scope,refresh_token,status');
    if (isMissingAuthorizationStatus(error)) {
      ({ data, error } = await load('user_id,google_id,scope,refresh_token'));
    }
    // Discard all external errors, including potentially sensitive error codes.
    if (error) throw new CoursesError(500, 'error_interno');
    if (!data || data.user_id !== userId || data.google_id !== googleId) throw relink();
    if (data.status === 'needs_relink') throw relink();
    if (typeof data.scope !== 'string' || !cumpleScopes(data.scope, requiredScopes)) {
      throw new CoursesError(403, 'classroom_sin_permisos');
    }
    const credential = decrypt(data.refresh_token, config.googleAuthSecret, 'google-refresh');
    if (typeof credential?.token !== 'string' || !credential.token) throw relink();
    try {
      const { accessToken, scope } = await refresh(credential.token, requiredScopes);
      return { accessToken, storedScope: data.scope, refreshedScope: scope };
    } catch (error) {
      if (error instanceof CoursesError && error.status === 409) {
        let { error: saveError } = await supabase.from('google_authorizations')
          .update({ status: 'needs_relink' }).eq('user_id', userId).eq('google_id', googleId)
          .eq('refresh_token', data.refresh_token);
        if (isMissingAuthorizationStatus(saveError)) {
          // Before 014, remove the revoked grant rather than reusing it later.
          // The ciphertext condition preserves a concurrent reconsent.
          ({ error: saveError } = await supabase.from('google_authorizations').delete()
            .eq('user_id', userId).eq('google_id', googleId).eq('refresh_token', data.refresh_token));
        }
        if (saveError) throw new CoursesError(500, 'error_interno');
      }
      throw error;
    }
  }

  async function getAccessToken(identity, requiredScopes = [CLASSROOM_SCOPE]) {
    return (await authorize(identity, requiredScopes)).accessToken;
  }

  async function listCourses(identity) {
    const accessToken = await getAccessToken(identity);
    try {
      const courses = await client.listCourses(accessToken, { studentId: 'me' });
      return { courses: courses.map(({ id, name, section, courseState }) => ({
        id, name,
        ...(typeof section === 'string' ? { section } : {}),
        ...(typeof courseState === 'string' ? { courseState } : {}),
      })) };
    } catch (error) {
      if (!(error instanceof ClassroomError)) throw upstream();
      if (error.code === 'UNAUTHENTICATED') throw relink();
      if (error.code === 'PERMISSION_DENIED') throw new CoursesError(403, 'classroom_sin_permisos');
      throw new CoursesError(error.retryable ? 503 : 502, 'classroom_no_disponible');
    }
  }

  // Internal worker projection: no tokens, course names, titles or email.
  // ITN-43b: sync only requires the courses scope. Tasks are read and persisted only when
  // both the stored grant and the refreshed token (if it reports scopes) include the task
  // scope; otherwise courses are sent WITHOUT the coursework key so SQL leaves tasks untouched.
  async function readForWorker(identity, { sync = false } = {}) {
    const { accessToken, storedScope, refreshedScope } = await authorize(identity, [CLASSROOM_SCOPE]);
    // Cualquiera de los dos nombres del permiso de tareas (canónico o alias empírico) cuenta,
    // en el scope guardado y en el del token refrescado. No es una equivalencia garantizada; la
    // prueba es courseWork.list (un 403 ahí deja el sync en solo cursos).
    let withWork = sync !== true || (tienePermisoTareas(storedScope) &&
      (refreshedScope === undefined || tienePermisoTareas(refreshedScope)));
    try {
      const courses = await client.listCourses(accessToken, { studentId: 'me' });
      const result = [];
      for (const course of courses) {
        if (sync === true && !withWork) {
          const { coursework: _ignored, ...courseOnly } = course;
          result.push(courseOnly);
          continue;
        }
        let work;
        try {
          work = await client.listCourseWork(accessToken, course.id);
        } catch (error) {
          // Sync: un 403 de courseWork.list significa "sin permiso de tareas" (p. ej. el alias
          // no resultó equivalente). Se omiten las tareas de TODOS los cursos (sin la clave
          // coursework, la SQL no las toca) y los cursos se sincronizan igual.
          if (sync !== true || !(error instanceof ClassroomError) || error.code !== 'PERMISSION_DENIED') throw error;
          withWork = false;
          for (let i = 0; i < result.length; i++) {
            const { coursework: _dropped, ...courseOnly } = result[i];
            result[i] = courseOnly;
          }
          const { coursework: _ignored, ...courseOnly } = course;
          result.push(courseOnly);
          continue;
        }
        if (sync === true) {
          result.push({ ...course, coursework: work });
          continue;
        }
        result.push({ id: course.id, coursework: work.map(item => ({
          id: item.id,
          ...(item.dueDate ? { dueDate: numericFields(item.dueDate, ['year', 'month', 'day']) } : {}),
          ...(item.dueTime ? { dueTime: numericFields(item.dueTime, ['hours', 'minutes', 'seconds', 'nanos']) } : {}),
        })) });
      }
      if (sync === true) {
        let normalized;
        try { normalized = normalizeCourses(result); } catch { throw upstream(); }
        try { return await persistClassroom(supabase, identity, normalized); }
        catch (error) {
          throw new CoursesError(error.syncStatus ?? 500,
            error.syncStatus === 409 ? 'classroom_requiere_autorizacion' :
              error.syncStatus === 503 ? 'classroom_migracion_requerida' : 'error_interno');
        }
      }
      return { courses: result };
    } catch (error) {
      if (error instanceof CoursesError) throw error;
      if (!(error instanceof ClassroomError)) throw upstream();
      if (error.code === 'UNAUTHENTICATED') throw relink();
      if (error.code === 'PERMISSION_DENIED') throw new CoursesError(403, 'classroom_sin_permisos');
      throw new CoursesError(error.retryable ? 503 : 502, 'classroom_no_disponible');
    }
  }
  // ITN-58f - Cursos del alumno que ya tienen tareas guardadas: { external_course_id }.
  // Sin las tablas (006 sin aplicar) no hay nada que leer.
  async function coursesWithWork(userId) {
    const PAGE = 1000;
    const withWork = new Set();
    for (let from = 0; ; from += PAGE) {
      const { data, error } = await supabase.from('classroom_coursework').select('course_id')
        .eq('user_id', userId).order('id', { ascending: true }).range(from, from + PAGE - 1);
      if (MISSING_MIGRATION.has(error?.code)) return [];
      if (error || !Array.isArray(data)) throw new CoursesError(500, 'error_interno');
      for (const row of data) withWork.add(row.course_id);
      if (data.length < PAGE) break;
    }
    if (withWork.size === 0) return [];
    const external = [];
    for (let from = 0; ; from += PAGE) {
      const { data, error } = await supabase.from('classroom_courses').select('id,external_course_id')
        .eq('user_id', userId).order('id', { ascending: true }).range(from, from + PAGE - 1);
      if (MISSING_MIGRATION.has(error?.code)) return [];
      if (error || !Array.isArray(data)) throw new CoursesError(500, 'error_interno');
      for (const row of data) {
        if (withWork.has(row.id) && typeof row.external_course_id === 'string') external.push(row.external_course_id);
      }
      if (data.length < PAGE) break;
    }
    return external;
  }

  // ITN-58f - Estado de entrega por tarea (studentSubmissions.list, courseWorkId "-", userId "me")
  // de los cursos que ya tienen tareas. Fase aparte del sync: nunca toca cursos, tareas, eventos
  // ni baselines, y no borra estado previo si falla. Sin permiso de tareas no llama a Google.
  // Un curso que falla se cuenta (solo su código) y no detiene a los demás.
  async function syncSubmissionsForWorker(identity) {
    const empty = { courses: 0, items: 0, stored: 0, unknown: 0, invalid: 0, failedCourses: 0 };
    const { accessToken, storedScope, refreshedScope } = await authorize(identity, [CLASSROOM_SCOPE]);
    if (!tienePermisoTareas(storedScope) || (refreshedScope !== undefined && !tienePermisoTareas(refreshedScope))) {
      return { submissions: { ...empty, skipped: 'sin_permiso_tareas' }, errorCodes: [] };
    }
    const courseIds = await coursesWithWork(identity.userId);
    const summary = { ...empty };
    const errorCodes = new Set();
    const items = [];
    for (const courseId of courseIds) {
      let raw;
      try {
        raw = await client.listStudentSubmissions(accessToken, courseId);
      } catch (error) {
        // Token recién refrescado rechazado: el resto de cursos fallaría igual.
        if (error instanceof ClassroomError && error.code === 'UNAUTHENTICATED') throw relink();
        summary.failedCourses++;
        errorCodes.add(error instanceof ClassroomError ? error.code : 'UNEXPECTED');
        continue;
      }
      summary.courses++;
      const normalized = normalizeSubmissions(raw, courseId);
      summary.invalid += normalized.invalid;
      items.push(...normalized.items);
    }
    summary.items = items.length;
    if (items.length > 0) {
      try {
        const result = await persistSubmissions(supabase, identity, items);
        summary.stored = result.stored;
        summary.unknown = result.unknown;
        if (!result.tasksAllowed) summary.skipped = 'sin_permiso_tareas';
      } catch (error) {
        if (error instanceof SubmissionsSyncError) throw new CoursesError(error.status, error.code);
        throw new CoursesError(500, 'error_interno');
      }
    }
    return { submissions: summary, errorCodes: [...errorCodes].sort() };
  }

  // Preserve the ITN-42 callable API while exposing reusable backend operations.
  return Object.assign(listCourses, { getAccessToken, readForWorker, syncSubmissionsForWorker });
}

module.exports = { createCoursesService, CoursesError };
