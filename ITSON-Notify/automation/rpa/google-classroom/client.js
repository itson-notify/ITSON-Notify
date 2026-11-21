// ITN-59: consumes only the authenticated internal backend endpoint.
const SUBMISSION_COUNTS = ['courses', 'items', 'stored', 'unknown', 'invalid', 'failedCourses'];
function createClassroomWorkerClient({ baseUrl, apiKey, fetchImpl = globalThis.fetch, timeoutMs = 15000, syncTimeoutMs = 120000 }) {
  const base = new URL(baseUrl);
  if (base.username || base.password || base.search || base.hash || base.pathname !== '/' ||
      !(base.protocol === 'https:' || (base.protocol === 'http:' && ['localhost', '127.0.0.1'].includes(base.hostname)))) {
    throw new TypeError('classroom_config_invalida');
  }
  if (typeof apiKey !== 'string' || !apiKey.trim()) throw new TypeError('classroom_config_invalida');
  async function call(path, body) {
    try {
      const response = await fetchImpl(new URL('/internal/classroom/' + path, base).href, {
        method: body ? 'POST' : 'GET', redirect: 'error',
        signal: AbortSignal.timeout(body?.sync || path === 'dispatch' || path === 'submissions' ? syncTimeoutMs : timeoutMs),
        headers: { 'x-api-key': apiKey, ...(body ? { 'Content-Type': 'application/json' } : {}) },
        ...(body ? { body: JSON.stringify(body) } : {}),
      });
      if (!response.ok) {
        const failure = { ok: false, status: response.status, needsRelink: response.status === 409 };
        if (response.status === 403) {
          // Only the backend's fixed OAuth error may be skipped; discard all other body data.
          try {
            if ((await response.json())?.error === 'classroom_sin_permisos') failure.permissionsMissing = true;
          } catch { /* An unknown/malformed 403 remains a failure. */ }
        }
        return failure;
      }
      const data = await response.json();
      const counts = (obj, keys) => obj && keys.every(key => Number.isSafeInteger(obj[key]) && obj[key] >= 0);
      const valid = path === 'dispatch'
        ? counts(data, ['procesados', 'enviados', 'fallidos'])
        : path === 'submissions'
          ? counts(data?.submissions, SUBMISSION_COUNTS) && typeof data.submissions.skipped === 'boolean'
        : body?.sync === true
          ? counts(data?.sync, ['courses', 'coursework', 'newTasks'])
          : Array.isArray(data?.[path === 'active' ? 'students' : 'courses']);
      if (!valid) {
        return { ok: false, status: 502, needsRelink: false };
      }
      return { ok: true, data };
    } catch {
      return { ok: false, status: 503, needsRelink: false };
    }
  }
  return {
    listActive: () => call('active'),
    read: ({ userId, googleId }) => call('read', { userId, googleId }),
    sync: ({ userId, googleId }) => call('read', { userId, googleId, sync: true }),
    // ITN-58f: submission status phase (backend reads Google); only counters come back.
    submissions: async ({ userId, googleId }) => {
      const result = await call('submissions', { userId, googleId });
      if (!result.ok) return result;
      const s = result.data.submissions;
      return { ok: true, data: { submissions: { ...Object.fromEntries(SUBMISSION_COUNTS.map(k => [k, s[k]])), skipped: s.skipped } } };
    },
    // ITN-50: only counters come back; any other body data is discarded.
    dispatch: async () => {
      const result = await call('dispatch', {});
      if (!result.ok) return result;
      const { procesados, enviados, fallidos } = result.data;
      return { ok: true, data: { procesados, enviados, fallidos } };
    },
  };
}
module.exports = { createClassroomWorkerClient };
