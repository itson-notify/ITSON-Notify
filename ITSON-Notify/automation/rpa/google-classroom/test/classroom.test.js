const { test, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { createClassroomClient, ClassroomError, READONLY_SCOPES } = require('..');

const TOKEN = 'synthetic-access-token';
const fixture = (name) => JSON.parse(fs.readFileSync(path.join(__dirname, 'fixtures', `${name}.json`), 'utf8'));
const json = (data, status = 200) => new Response(JSON.stringify(data), { status });
// Cualquier uso accidental del transporte real hace fallar la prueba.
beforeEach((t) => t.mock.method(globalThis, 'fetch', () => { throw new Error('Real network forbidden'); }));
function mock(responses, options = {}) {
  const calls = [];
  const client = createClassroomClient({ ...options, fetchImpl: async (...args) => {
    calls.push(args);
    assert.ok(responses.length, 'Unexpected request');
    const response = responses.shift();
    if (response instanceof Error) throw response;
    return response;
  } });
  return { client, calls };
}

for (const [method, key, file, args, endpoint] of [
  ['listCourses', 'courses', 'courses', [], '/v1/courses'],
  ['listCourseWork', 'courseWork', 'coursework', ['synthetic-course-01'], '/v1/courses/synthetic-course-01/courseWork'],
]) {
  test(`${method}: pagina y preserva recursos oficiales`, async () => {
    const first = fixture(file);
    const second = { ...first[key][0], id: 'synthetic-second' };
    const { client, calls } = mock([json(first), json({ [key]: [second] })]);
    assert.deepEqual(await client[method](TOKEN, ...args, { pageSize: 7 }), [...first[key], second]);
    assert.equal(calls.length, 2);
    for (const [i, [url, init]] of calls.entries()) {
      const parsed = new URL(url);
      assert.equal(parsed.origin, 'https://classroom.googleapis.com');
      assert.equal(parsed.pathname, endpoint);
      assert.equal(parsed.searchParams.get('pageSize'), '7');
      assert.equal(parsed.searchParams.get('pageToken'), i ? first.nextPageToken : null);
      assert.ok(!url.includes(TOKEN));
      assert.equal(init.method, 'GET');
      assert.equal(init.headers.Authorization, `Bearer ${TOKEN}`);
      assert.equal(init.redirect, 'error');
      assert.ok(init.signal instanceof AbortSignal);
      assert.equal(init.body, undefined);
    }
  });
  test(`${method}: lista vacía y página vacía intermedia`, async () => {
    const { client } = mock([json({ nextPageToken: 'empty-page' }), json({})]);
    assert.deepEqual(await client[method](TOKEN, ...args), []);
  });
  test(`${method}: falla posterior no devuelve resultados parciales`, async () => {
    const { client, calls } = mock([json(fixture(file)), json({}, 503)]);
    await assert.rejects(client[method](TOKEN, ...args), { code: 'HTTP_ERROR', status: 503 });
    assert.equal(calls.length, 2);
  });
}

for (const [status, code, retryable, file] of [
  [401, 'UNAUTHENTICATED', false, 'expired-token'],
  [403, 'PERMISSION_DENIED', false, 'insufficient-permissions'],
  [404, 'HTTP_ERROR', false], [429, 'HTTP_ERROR', true], [503, 'HTTP_ERROR', true],
  [302, 'HTTP_ERROR', false],
]) {
  test(`HTTP ${status}: error estable, sin reintentos ni cuerpo externo`, async () => {
    const { client, calls } = mock([json(file ? fixture(file) : { message: TOKEN }, status)]);
    await assert.rejects(client.listCourses(TOKEN), (error) => {
      assert.ok(error instanceof ClassroomError);
      assert.equal(error.code, code);
      assert.equal(error.status, status);
      assert.equal(error.retryable, retryable);
      assert.ok(!`${error.stack}${JSON.stringify(error)}`.includes(TOKEN));
      assert.equal(error.cause, undefined);
      return true;
    });
    assert.equal(calls.length, 1);
  });
}

for (const body of [null, [], 'bad', { error: {} }, { courses: null }, { courses: {} },
  { courses: [null] }, { courses: [{ id: 1, name: 'x' }] }, { courses: [{ id: 'x' }] },
  { nextPageToken: 123 }, { nextPageToken: null }]) {
  test(`respuesta malformada: ${JSON.stringify(body)}`, async () => {
    const { client } = mock([json(body)]);
    await assert.rejects(client.listCourses(TOKEN), { code: 'MALFORMED_RESPONSE' });
  });
}
test('JSON inválido y tarea malformada', async () => {
  const { client } = mock([new Response('<html>'), json({ courseWork: [{ id: 'x', title: 'x' }] })]);
  await assert.rejects(client.listCourses(TOKEN), { code: 'MALFORMED_RESPONSE' });
  await assert.rejects(client.listCourseWork(TOKEN, 'x'), { code: 'MALFORMED_RESPONSE' });
});
for (const name of ['TypeError', 'TimeoutError', 'AbortError']) {
  test(`transporte ${name} no expone secretos`, async () => {
    const error = new Error(TOKEN);
    error.name = name;
    const { client } = mock([error]);
    await assert.rejects(client.listCourses(TOKEN), (result) => {
      assert.equal(result.code, name === 'TypeError' ? 'NETWORK_ERROR' : 'TIMEOUT');
      assert.equal(result.retryable, true);
      assert.ok(!result.stack.includes(TOKEN));
      return true;
    });
  });
}
test('detecta ciclos y limita páginas', async () => {
  for (const [options, responses, code] of [
    [{}, [json({ nextPageToken: 'a' }), json({ nextPageToken: 'b' }), json({ nextPageToken: 'a' })], 'PAGINATION_LOOP'],
    [{ maxPages: 1 }, [json({ nextPageToken: 'a' })], 'PAGE_LIMIT_EXCEEDED'],
  ]) {
    const { client } = mock(responses, options);
    await assert.rejects(client.listCourses(TOKEN), { code });
  }
});
test('valida entradas antes de contactar el transporte', async () => {
  const { client, calls } = mock([]);
  for (const token of ['', null, 'a\r\nb', 'Bearer token']) await assert.rejects(client.listCourses(token), TypeError);
  for (const pageSize of [0, -1, 1.5, '5']) await assert.rejects(client.listCourses(TOKEN, { pageSize }), TypeError);
  for (const id of ['', null, '.', '..']) assert.throws(() => client.listCourseWork(TOKEN, id), TypeError);
  assert.equal(calls.length, 0);
  for (const options of [{ fetchImpl: null }, { maxPages: 0 }, { timeoutMs: 0 }, { timeoutMs: Infinity }]) {
    assert.throws(() => createClassroomClient(options), TypeError);
  }
  assert.ok(READONLY_SCOPES.every((scope) => scope.endsWith('.readonly')));
});
test('codifica alias y recibe un token distinto en cada llamada', async () => {
  const { client, calls } = mock([json({}), json({})]);
  await client.listCourseWork(TOKEN, 'd:synthetic/alias?x=y');
  await client.listCourses('synthetic-other-token');
  assert.equal(new URL(calls[0][0]).pathname, '/v1/courses/d%3Asynthetic%2Falias%3Fx%3Dy/courseWork');
  assert.equal(calls[1][1].headers.Authorization, 'Bearer synthetic-other-token');
  assert.ok(!JSON.stringify(client).includes(TOKEN));
});
