// ITN-59: consumes only the authenticated internal backend endpoint.
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
        method: body ? 'POST' : 'GET', redirect: 'error', signal: AbortSignal.timeout(body?.sync ? syncTimeoutMs : timeoutMs),
        headers: { 'x-api-key': apiKey, ...(body ? { 'Content-Type': 'application/json' } : {}) },
        ...(body ? { body: JSON.stringify(body) } : {}),
      });
      if (!response.ok) return { ok: false, status: response.status, needsRelink: response.status === 409 };
      const data = await response.json();
      const valid = body?.sync === true
        ? data?.sync && ['courses', 'coursework', 'newTasks'].every(key => Number.isSafeInteger(data.sync[key]) && data.sync[key] >= 0)
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
  };
}
module.exports = { createClassroomWorkerClient };
