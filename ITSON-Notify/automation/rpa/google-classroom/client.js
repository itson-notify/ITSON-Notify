// ITN-49: cliente REST de solo lectura; el token vive solo durante la llamada.
const BASE_URL = 'https://classroom.googleapis.com/v1';
const READONLY_SCOPES = Object.freeze([
  'https://www.googleapis.com/auth/classroom.courses.readonly',
  'https://www.googleapis.com/auth/classroom.coursework.me.readonly',
]);

class ClassroomError extends Error {
  constructor(code, { status = null, retryable = false } = {}) {
    // No incluir cuerpos, URLs, tokens ni causas externas en los errores.
    super(`Google Classroom: ${code}`);
    this.name = 'ClassroomError';
    this.code = code;
    this.status = status;
    this.retryable = retryable;
  }
}

const object = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);
const invalid = () => new ClassroomError('MALFORMED_RESPONSE');

function createClassroomClient({ fetchImpl = globalThis.fetch, timeoutMs = 15000, maxPages = 1000 } = {}) {
  if (typeof fetchImpl !== 'function' || !Number.isInteger(timeoutMs) || timeoutMs < 1 ||
      timeoutMs > 2147483647 || !Number.isSafeInteger(maxPages) || maxPages < 1) {
    throw new TypeError('Invalid client options');
  }

  async function list(accessToken, path, key, { pageSize = 100 } = {}) {
    if (typeof accessToken !== 'string' || !/^[A-Za-z0-9._~+\/-]+=*$/.test(accessToken)) {
      throw new TypeError('Invalid access token');
    }
    if (!Number.isInteger(pageSize) || pageSize < 1) throw new TypeError('Invalid page size');
    const items = [];
    const seen = new Set();
    let pageToken = '';
    for (let page = 0; page < maxPages; page++) {
      const url = new URL(`${BASE_URL}/${path}`);
      url.searchParams.set('pageSize', String(pageSize));
      if (pageToken) url.searchParams.set('pageToken', pageToken);
      let response;
      let data;
      try {
        response = await fetchImpl(url.toString(), {
          method: 'GET',
          headers: { Authorization: `Bearer ${accessToken}`, Accept: 'application/json' },
          redirect: 'error',
          signal: AbortSignal.timeout(timeoutMs),
        });
      } catch (error) {
        const timeout = error?.name === 'TimeoutError' || error?.name === 'AbortError';
        throw new ClassroomError(timeout ? 'TIMEOUT' : 'NETWORK_ERROR', { retryable: true });
      }
      if (!response || !Number.isInteger(response.status) || response.status < 100 || response.status > 599) throw invalid();
      if (response.status < 200 || response.status >= 300) {
        const status = response.status;
        const code = status === 401 ? 'UNAUTHENTICATED' : status === 403 ? 'PERMISSION_DENIED' : 'HTTP_ERROR';
        throw new ClassroomError(code, { status, retryable: status === 429 || status >= 500 });
      }
      try { data = await response.json(); } catch { throw invalid(); }
      if (!object(data) || Object.hasOwn(data, 'error') ||
          (Object.hasOwn(data, key) && !Array.isArray(data[key])) ||
          (Object.hasOwn(data, 'nextPageToken') && typeof data.nextPageToken !== 'string')) throw invalid();
      const batch = data[key] ?? [];
      if (batch.some((item) => !object(item) || typeof item.id !== 'string' || !item.id.trim() ||
          typeof item[key === 'courses' ? 'name' : 'title'] !== 'string' ||
          (key === 'courseWork' && (typeof item.courseId !== 'string' || !item.courseId.trim())))) throw invalid();
      items.push(...batch);
      pageToken = data.nextPageToken || '';
      if (!pageToken) return items;
      if (seen.has(pageToken)) throw new ClassroomError('PAGINATION_LOOP');
      seen.add(pageToken);
    }
    throw new ClassroomError('PAGE_LIMIT_EXCEEDED');
  }

  return Object.freeze({
    listCourses: (accessToken, options) => list(accessToken, 'courses', 'courses', options),
    listCourseWork(accessToken, courseId, options) {
      // Segmento opaco, nunca interpretar un ID como ruta o consulta.
      if (typeof courseId !== 'string' || !courseId.trim() || courseId === '.' || courseId === '..') {
        throw new TypeError('Invalid course ID');
      }
      return list(accessToken, `courses/${encodeURIComponent(courseId)}/courseWork`, 'courseWork', options);
    },
  });
}

module.exports = { createClassroomClient, ClassroomError, READONLY_SCOPES };
