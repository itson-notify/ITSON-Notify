const { test } = require('node:test');
const assert = require('node:assert/strict');
const { ejecutarClassroom } = require('../classroom-fase');
const { arrancar } = require('../extraccion-cron');
const { createClassroomWorkerClient } = require('../../rpa/google-classroom');
const env = { CLASSROOM_SYNC_ENABLED: 'true', BACKEND_URL: 'https://backend.test', INTERNAL_API_KEY: 'synthetic' };

test('Classroom disabled by default and paused without accessing configuration or network', async () => {
  for (const e of [{}, { ...env, RPA_PAUSADO: 'true' }]) {
    assert.equal(await ejecutarClassroom({ env: e, crearCliente() { throw Error('network'); } }), 0);
  }
});
test('partial failure, thrown failure, relink and duplicate identities do not stop other students or retry', async () => {
  const students = ['a', 'b', 'c', 'd', 'e'].map(id => ({ userId: id, googleId: id }));
  const calls = [], logs = [];
  const code = await ejecutarClassroom({ env, log: s => logs.push(s), crearCliente: () => ({
    listActive: async () => ({ ok: true, data: { students: [...students, students[1]] } }),
    sync: async s => {
      calls.push(s.userId);
      if (s.userId === 'c') throw Error('PRIVATE');
      return s.userId === 'b' ? { ok: false, status: 409, needsRelink: true } :
        s.userId === 'a' ? { ok: false, status: 503 } : { ok: true };
    },
  }) });
  assert.equal(code, 1); assert.deepEqual(calls, ['a', 'b', 'c', 'd', 'e']);
  assert.deepEqual(logs, ['Classroom: procesadas=2 omitidas=1 fallidas=2']);
});
test('invalid enumeration fails closed, 401 stops requests', async () => {
  let calls = 0;
  for (const students of [[{ userId: 'a' }], [{ userId: 'a', googleId: 'a' }, { userId: 'b', googleId: 'b' }]]) {
    assert.equal(await ejecutarClassroom({ env, log() {}, logError() {}, crearCliente: () => ({
      listActive: async () => ({ ok: true, data: { students } }),
      sync: async () => { calls++; return { ok: false, status: 401 }; },
    }) }), 1);
  }
  assert.equal(calls, 1);
});
test('401 always counts as failure and stops subsequent requests even with relink or ok flags', async () => {
  for (const ok of [false, true]) {
    const calls = [], logs = [];
    const students = ['a', 'b'].map(id => ({ userId: id, googleId: id }));
    const code = await ejecutarClassroom({ env, log: s => logs.push(s), crearCliente: () => ({
      listActive: async () => ({ ok: true, data: { students } }),
      sync: async student => {
        calls.push(student.userId);
        return { ok, status: 401, needsRelink: true };
      },
    }) });
    assert.equal(code, 1);
    assert.deepEqual(calls, ['a']);
    assert.deepEqual(logs, ['Classroom: procesadas=0 omitidas=0 fallidas=1']);
  }
});
test('409 remains skipped without retry and allows the next student to succeed', async () => {
  for (const needsRelink of [false, true]) {
    const calls = [], logs = [];
    const students = ['a', 'b'].map(id => ({ userId: id, googleId: id }));
    const code = await ejecutarClassroom({ env, log: s => logs.push(s), crearCliente: () => ({
      listActive: async () => ({ ok: true, data: { students } }),
      sync: async student => {
        calls.push(student.userId);
        return student.userId === 'a' ? { ok: false, status: 409, needsRelink } : { ok: true };
      },
    }) });
    assert.equal(code, 0);
    assert.deepEqual(calls, ['a', 'b']);
    assert.deepEqual(logs, ['Classroom: procesadas=1 omitidas=1 fallidas=0']);
  }
});

test('known OAuth 403 and relink accounts are skipped; infrastructure and unknown errors remain failures', async () => {
  const students = ['permissions', 'relink', 'legacy-relink', 'server', 'unavailable', 'unknown', 'forbidden', 'healthy']
    .map(id => ({ userId: id, googleId: id }));
  const results = [
    { ok: false, status: 403, permissionsMissing: true },
    { ok: false, status: 409 },
    { ok: false, needsRelink: true },
    { ok: false, status: 500, needsRelink: true },
    { ok: true, status: 503, needsRelink: true },
    { ok: false, status: 418, needsRelink: true },
    { ok: false, status: 403, needsRelink: true },
    { ok: true },
  ];
  const calls = [], logs = [];
  const code = await ejecutarClassroom({ env, log: line => logs.push(line), crearCliente: () => ({
    listActive: async () => ({ ok: true, data: { students } }),
    sync: async student => { calls.push(student.userId); return results.shift(); },
  }) });
  assert.equal(code, 1);
  assert.deepEqual(calls, students.map(student => student.userId));
  assert.deepEqual(logs, ['Classroom: procesadas=1 omitidas=3 fallidas=4']);
});

test('HTTP client only marks the fixed OAuth 403 as skippable; cron completes other students', async () => {
  for (const [body, skipped] of [[JSON.stringify({ error: 'classroom_sin_permisos', private: 'PRIVATE' }), true],
    [JSON.stringify({ error: 'unknown', private: 'PRIVATE' }), false], ['invalid JSON PRIVATE', false]]) {
    const students = ['a', 'b'].map(id => ({ userId: id, googleId: id }));
    const calls = [], logs = [];
    const client = createClassroomWorkerClient({ baseUrl: env.BACKEND_URL, apiKey: env.INTERNAL_API_KEY,
      fetchImpl: async (url, options) => {
        if (url.endsWith('/active')) return new Response(JSON.stringify({ students }));
        const account = JSON.parse(options.body).userId;
        calls.push(account);
        return account === 'a' ? new Response(body, { status: 403 }) :
          new Response(JSON.stringify({ sync: { courses: 0, coursework: 0, newTasks: 0 } }));
      } });
    const code = await ejecutarClassroom({ env, crearCliente: () => client, log: line => logs.push(line) });
    assert.equal(code, skipped ? 0 : 1);
    assert.deepEqual(calls, ['a', 'b']);
    assert.deepEqual(logs, [`Classroom: procesadas=1 omitidas=${skipped ? 1 : 0} fallidas=${skipped ? 0 : 1}`]);
    assert.doesNotMatch(JSON.stringify(logs), /PRIVATE|unknown|invalid/);
  }
});
test('cron executes Classroom after ITSON, preserves calendar and other phases after exceptions', async () => {
  const order = [];
  const code = await arrancar({ correr: async () => { order.push('ivirtual'); throw new Error(); },
    correrApi: async () => { order.push('itson'); return 0; },
    correrClassroom: async () => { order.push('classroom'); throw new Error('PRIVATE'); },
    correrCalendario: async () => { order.push('calendar'); }, alertar: async () => {}, logError() {} });
  assert.equal(code, 1); assert.deepEqual(order, ['ivirtual', 'itson', 'classroom', 'calendar']);
});
test('HTTP sync sends only identity and opt in, validates counters, no retry on relink', async () => {
  let calls = 0;
  const client = createClassroomWorkerClient({ baseUrl: env.BACKEND_URL, apiKey: env.INTERNAL_API_KEY,
    fetchImpl: async (url, options) => {
      calls++; assert.equal(url, 'https://backend.test/internal/classroom/read');
      assert.deepEqual(JSON.parse(options.body), { userId: 'a', googleId: 'g', sync: true });
      return new Response(JSON.stringify({ sync: { courses: 2, coursework: 3, newTasks: 1 } }));
    } });
  assert.deepEqual(await client.sync({ userId: 'a', googleId: 'g', refreshToken: 'PRIVATE' }),
    { ok: true, data: { sync: { courses: 2, coursework: 3, newTasks: 1 } } });
  assert.equal(calls, 1);
});

// ITN-50 - Fase de despacho de avisos de tareas, después de la sincronización.
const { despacharClassroom, dispatchFlag } = require('../classroom-fase');
const cliente = (dispatch, students = [{ userId: 'a', googleId: 'a' }]) => () => ({
  listActive: async () => ({ ok: true, data: { students } }),
  sync: async () => ({ ok: true }),
  dispatch,
});

test('dispatch flag uses the closed true/false/1/0 list; empty is off', () => {
  for (const [raw, expected] of [[undefined, { valid: true, enabled: false }], ['', { valid: true, enabled: false }],
    ['true', { valid: true, enabled: true }], ['1', { valid: true, enabled: true }], [' TRUE ', { valid: true, enabled: true }],
    ['false', { valid: true, enabled: false }], ['0', { valid: true, enabled: false }],
    ['yes', { valid: false, enabled: false }], ['on', { valid: false, enabled: false }]]) {
    assert.deepEqual(dispatchFlag(raw), expected, String(raw));
  }
});

test('dispatch off (default or invalid) never calls the backend route', async () => {
  for (const flag of [undefined, 'false', '0', 'PRIVATE-yes']) {
    let calls = 0; const logs = [], errors = [];
    const code = await ejecutarClassroom({ env: { ...env, CLASSROOM_DISPATCH_ENABLED: flag }, log: s => logs.push(s),
      logError: s => errors.push(s), crearCliente: cliente(async () => { calls++; return { ok: true, data: {} }; }) });
    assert.equal(code, 0); assert.equal(calls, 0);
    assert.deepEqual(logs, ['Classroom: procesadas=1 omitidas=0 fallidas=0']);
    assert.deepEqual(errors, flag === 'PRIVATE-yes' ? ['Classroom despacho: configuracion invalida.'] : []);
  }
});

test('dispatch runs after the sync and logs only counters', async () => {
  const order = [], logs = [];
  const code = await ejecutarClassroom({ env: { ...env, CLASSROOM_DISPATCH_ENABLED: 'true' }, log: s => logs.push(s),
    crearCliente: () => ({
      listActive: async () => ({ ok: true, data: { students: [{ userId: 'a', googleId: 'a' }] } }),
      sync: async () => { order.push('sync'); return { ok: true }; },
      dispatch: async () => { order.push('dispatch'); return { ok: true, data: { procesados: 3, enviados: 2, fallidos: 1 } }; },
    }) });
  assert.equal(code, 0); assert.deepEqual(order, ['sync', 'dispatch']);
  assert.deepEqual(logs, ['Classroom: procesadas=1 omitidas=0 fallidas=0',
    'Classroom despacho: procesados=3 enviados=2 fallidos=1']);
});

test('dispatch failure is non critical: exit code unchanged, logged without details', async () => {
  for (const dispatch of [async () => { throw new Error('PRIVATE'); }, async () => ({ ok: false, status: 500 }),
    async () => ({ ok: false, status: 503 })]) {
    const logs = [], errors = [];
    const code = await ejecutarClassroom({ env: { ...env, CLASSROOM_DISPATCH_ENABLED: '1' }, log: s => logs.push(s),
      logError: s => errors.push(s), crearCliente: cliente(dispatch) });
    assert.equal(code, 0);
    assert.equal(errors.length, 1); assert.match(errors[0], /^Classroom despacho: no disponible \(status=\d+\)\.$/);
    assert.doesNotMatch(JSON.stringify([logs, errors]), /PRIVATE/);
  }
  // A sync failure still returns 1, but dispatch failure does not add to it.
  const code = await ejecutarClassroom({ env: { ...env, CLASSROOM_DISPATCH_ENABLED: 'true' }, log() {}, logError() {},
    crearCliente: () => ({ listActive: async () => ({ ok: true, data: { students: [{ userId: 'a', googleId: 'a' }] } }),
      sync: async () => ({ ok: false, status: 500 }), dispatch: async () => { throw new Error(); } }) });
  assert.equal(code, 1);
});

test('cron keeps exit code 0 when only the dispatch fails', async () => {
  const code = await arrancar({ correr: async () => 0, correrApi: async () => 0,
    correrClassroom: () => ejecutarClassroom({ env: { ...env, CLASSROOM_DISPATCH_ENABLED: 'true' }, log() {}, logError() {},
      crearCliente: cliente(async () => { throw new Error('PRIVATE'); }) }),
    correrCalendario: async () => {}, alertar: async () => {}, logError() {} });
  assert.equal(code, 0);
});

test('HTTP dispatch posts to the internal route with the key and keeps only counters', async () => {
  const calls = [];
  const client = createClassroomWorkerClient({ baseUrl: env.BACKEND_URL, apiKey: env.INTERNAL_API_KEY,
    fetchImpl: async (url, options) => {
      calls.push([url, options.method, options.headers['x-api-key'], options.body]);
      return new Response(JSON.stringify({ procesados: 1, enviados: 1, fallidos: 0, private: 'PRIVATE' }));
    } });
  assert.deepEqual(await client.dispatch(), { ok: true, data: { procesados: 1, enviados: 1, fallidos: 0 } });
  assert.deepEqual(calls, [['https://backend.test/internal/classroom/dispatch', 'POST', 'synthetic', '{}']]);
  for (const body of [JSON.stringify({ procesados: -1, enviados: 0, fallidos: 0 }), JSON.stringify({ error: 'x' })]) {
    const bad = createClassroomWorkerClient({ baseUrl: env.BACKEND_URL, apiKey: env.INTERNAL_API_KEY,
      fetchImpl: async () => new Response(body) });
    assert.deepEqual(await bad.dispatch(), { ok: false, status: 502, needsRelink: false });
  }
  const off = createClassroomWorkerClient({ baseUrl: env.BACKEND_URL, apiKey: env.INTERNAL_API_KEY,
    fetchImpl: async () => new Response(JSON.stringify({ error: 'no_encontrado' }), { status: 404 }) });
  assert.equal((await off.dispatch()).status, 404);
});
