// ITN-42: reuse ITN-41 encryption and ITN-49 pagination. No token persistence.
const { decrypt } = require('../utils/secureToken');
const { CLASSROOM_SCOPE } = require('./googleAuthService');
const { createClassroomClient, ClassroomError } = require('./classroomClient');

class CoursesError extends Error {
  constructor(status, code) {
    super(code);
    this.status = status;
    this.code = code;
  }
}
const relink = () => new CoursesError(409, 'classroom_requiere_autorizacion');
const upstream = () => new CoursesError(502, 'classroom_respuesta_invalida');

function createCoursesService({ config, supabase, fetchImpl = globalThis.fetch, timeoutMs = 15000 }) {
  const client = createClassroomClient({ fetchImpl, timeoutMs });

  async function refresh(refreshToken) {
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
          !data.scope.split(' ').includes(CLASSROOM_SCOPE))) {
        throw new CoursesError(403, 'classroom_sin_permisos');
      }
      return data.access_token;
    } catch (error) {
      if (error instanceof CoursesError) throw error;
      if (error instanceof SyntaxError) throw upstream();
      throw new CoursesError(503, 'classroom_no_disponible');
    }
  }

  return async function listCourses({ userId, googleId }) {
    const { data, error } = await supabase.from('google_authorizations')
      .select('user_id,google_id,scope,refresh_token')
      .eq('user_id', userId).eq('google_id', googleId).maybeSingle();
    // Discard all external errors, including potentially sensitive error codes.
    if (error) throw new CoursesError(500, 'error_interno');
    if (!data || data.user_id !== userId || data.google_id !== googleId) throw relink();
    if (typeof data.scope !== 'string' || !data.scope.split(' ').includes(CLASSROOM_SCOPE)) {
      throw new CoursesError(403, 'classroom_sin_permisos');
    }
    const credential = decrypt(data.refresh_token, config.googleAuthSecret, 'google-refresh');
    if (typeof credential?.token !== 'string' || !credential.token) throw relink();
    const accessToken = await refresh(credential.token);
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
  };
}

module.exports = { createCoursesService, CoursesError };
