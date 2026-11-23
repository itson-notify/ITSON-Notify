// ITN-58f - Fase de estado de entrega de Classroom en el worker: solo habla con el backend,
// nunca cambia el código de salida ni registra datos (solo conteos y status HTTP).
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { ejecutarClassroom, sincronizarEntregas } = require('../classroom-fase');
const { createClassroomWorkerClient } = require('../../rpa/google-classroom');

const base = { CLASSROOM_SYNC_ENABLED: 'true', BACKEND_URL: 'https://backend.test', INTERNAL_API_KEY: 'synthetic' };
const env = { ...base, CLASSROOM_ENTREGAS_ENABLED: 'true' };
const counts = (extra = {}) => ({ courses: 1, items: 2, stored: 2, unknown: 0, invalid: 0, failedCourses: 0, skipped: false, ...extra });
const synced = coursework => ({ ok: true, data: { sync: { courses: 1, coursework, newTasks: 0 } } });

function fase({ students, sync, submissions, env: faseEnv = env }) {
  const calls = { sync: [], submissions: [] };
  const logs = [], errors = [];
  const run = ejecutarClassroom({ env: faseEnv, log: s => logs.push(s), logError: s => errors.push(s), crearCliente: () => ({
    listActive: async () => ({ ok: true, data: { students: students.map(id => ({ userId: id, googleId: id })) } }),
    sync: async s => { calls.sync.push(s.userId); return sync(s.userId); },
    submissions: async s => { calls.submissions.push(s.userId); return submissions(s.userId); },
  }) });
  return { run, calls, logs, errors };
}

test('tras el sync pide entregas solo de cuentas sincronizadas con tareas', async () => {
  const f = fase({ students: ['a', 'b', 'c', 'd'],
    sync: id => (id === 'a' ? synced(3) : id === 'b' ? synced(0) : id === 'c' ? { ok: false, status: 409 } : synced(1)),
    submissions: () => ({ ok: true, data: { submissions: counts() } }) });
  assert.equal(await f.run, 0);
  // b: sin permiso de tareas (sync solo cursos => coursework 0); c: relink.
  assert.deepEqual(f.calls.submissions, ['a', 'd']);
  assert.deepEqual(f.logs, ['Classroom: procesadas=3 omitidas=1 fallidas=0',
    'Classroom entregas: procesadas=2 omitidas=0 fallidas=0 guardadas=4']);
  assert.deepEqual(f.errors, []);
});

test('sin permiso de tareas en ninguna cuenta no llama a submissions ni registra la fase', async () => {
  const f = fase({ students: ['a', 'b'], sync: () => synced(0), submissions: () => assert.fail('no debe llamarse') });
  assert.equal(await f.run, 0);
  assert.deepEqual(f.calls.submissions, []);
  assert.deepEqual(f.logs, ['Classroom: procesadas=2 omitidas=0 fallidas=0']);
});

test('un error por cuenta (o una excepción) no detiene las demás ni cambia el código de salida', async () => {
  const f = fase({ students: ['a', 'b', 'c', 'd', 'e'], sync: () => synced(2),
    submissions: id => {
      if (id === 'a') return { ok: false, status: 503 };
      if (id === 'b') throw Error('PRIVATE-DATA');
      if (id === 'c') return { ok: true, data: { submissions: counts({ failedCourses: 2, stored: 1 }) } };
      if (id === 'd') return { ok: true, data: { submissions: counts({ skipped: true, stored: 0 }) } };
      return { ok: false, status: 409 };
    } });
  assert.equal(await f.run, 0);
  assert.deepEqual(f.calls.submissions, ['a', 'b', 'c', 'd', 'e']);
  assert.deepEqual(f.logs.at(-1), 'Classroom entregas: procesadas=1 omitidas=2 fallidas=2 guardadas=1');
  assert.deepEqual(f.errors, ['Classroom entregas: no disponible (status=503).', 'Classroom entregas: no disponible (status=0).',
    'Classroom entregas: cursos con error=2.']);
  assert.doesNotMatch(JSON.stringify([f.logs, f.errors]), /PRIVATE/);
});

test('401 o 404 (backend sin la fase) detienen la fase sin afectar el sync ni el despacho', async () => {
  for (const status of [401, 404]) {
    const f = fase({ students: ['a', 'b'], sync: () => synced(1), submissions: () => ({ ok: false, status }) });
    assert.equal(await f.run, 0, 'el código de salida depende solo del sync');
    assert.deepEqual(f.calls.submissions, ['a']);
  }
});

test('backend con la fase apagada (404) y worker encendido: una línea informativa, sin errores', async () => {
  const f = fase({ students: ['a', 'b'], sync: () => synced(1), submissions: () => ({ ok: false, status: 404 }) });
  assert.equal(await f.run, 0);
  assert.deepEqual(f.calls.submissions, ['a']);
  assert.deepEqual(f.errors, []);
  assert.deepEqual(f.logs, ['Classroom: procesadas=2 omitidas=0 fallidas=0',
    'Classroom entregas: desactivada en el backend (status=404).']);
});

test('CLASSROOM_ENTREGAS_ENABLED distinto del exacto "true" apaga solo la fase de entregas', async () => {
  for (const flag of [undefined, '', 'false', 'TRUE', 'True', ' true', 'true ', '1', 'yes', 'basura']) {
    const faseEnv = { ...base };
    if (flag !== undefined) faseEnv.CLASSROOM_ENTREGAS_ENABLED = flag;
    const f = fase({ env: faseEnv, students: ['a', 'b'], sync: () => synced(2), submissions: () => assert.fail('no debe llamarse') });
    assert.equal(await f.run, 0, `bandera ${JSON.stringify(flag)}`);
    assert.deepEqual(f.calls.sync, ['a', 'b'], 'el sync normal no cambia');
    assert.deepEqual(f.calls.submissions, []);
    assert.deepEqual(f.logs, ['Classroom: procesadas=2 omitidas=0 fallidas=0']);
    assert.deepEqual(f.errors, []);
  }
  // Un valor inválido nunca lanza ni cambia el código de salida de un sync fallido.
  const fallido = fase({ env: { ...base, CLASSROOM_ENTREGAS_ENABLED: '{}' }, students: ['a'],
    sync: () => ({ ok: false, status: 500 }), submissions: () => assert.fail('no debe llamarse') });
  assert.equal(await fallido.run, 1);
  // Sin env explícito ni variable en process.env: apagada.
  const prev = process.env.CLASSROOM_ENTREGAS_ENABLED;
  delete process.env.CLASSROOM_ENTREGAS_ENABLED;
  try {
    await sincronizarEntregas({ client: { submissions: () => assert.fail('no debe llamarse') },
      accounts: [{ userId: 'a', googleId: 'a' }], log: () => assert.fail(), logError: () => assert.fail() });
  } finally { if (prev !== undefined) process.env.CLASSROOM_ENTREGAS_ENABLED = prev; }
});

test('la bandera de entregas no interfiere con el despacho', async () => {
  const dispatched = [];
  const run = ejecutarClassroom({ env: { ...base, CLASSROOM_DISPATCH_ENABLED: 'true' }, log: () => {}, logError: () => {},
    crearCliente: () => ({
      listActive: async () => ({ ok: true, data: { students: [{ userId: 'a', googleId: 'a' }] } }),
      sync: async () => synced(1),
      submissions: async () => assert.fail('no debe llamarse'),
      dispatch: async () => { dispatched.push(1); return { ok: true, data: { procesados: 0, enviados: 0, fallidos: 0 } }; },
    }) });
  assert.equal(await run, 0);
  assert.equal(dispatched.length, 1);
});

test('una falla del sync mantiene el código 1 y la fase sigue con las cuentas que sí sincronizaron', async () => {
  const f = fase({ students: ['a', 'b'], sync: id => (id === 'a' ? { ok: false, status: 500 } : synced(1)),
    submissions: () => ({ ok: true, data: { submissions: counts() } }) });
  assert.equal(await f.run, 1);
  assert.deepEqual(f.calls.submissions, ['b']);
});

test('sincronizarEntregas tolera un cliente sin la operación y nunca lanza', async () => {
  await sincronizarEntregas({ env, client: {}, accounts: [{ userId: 'a', googleId: 'a' }], log: () => assert.fail(), logError: () => assert.fail() });
  const logs = [];
  await sincronizarEntregas({ env, client: { submissions: async () => ({ ok: true, data: null }) },
    accounts: [{ userId: 'a', googleId: 'a' }], log: s => logs.push(s), logError: s => logs.push(s) });
  assert.match(logs.join('\n'), /Classroom entregas: no disponible \(status=0\)/);
});

test('el cliente llama /internal/classroom/submissions y descarta todo excepto los conteos', async () => {
  const calls = [];
  const client = createClassroomWorkerClient({ baseUrl: 'https://backend.example.test', apiKey: 'synthetic-key',
    fetchImpl: async (...args) => { calls.push(args); return new Response(JSON.stringify({ submissions: { ...counts(), extra: 'PRIVATE' }, other: 'PRIVATE' })); } });
  const result = await client.submissions({ userId: 'u', googleId: 'g' });
  assert.deepEqual(result, { ok: true, data: { submissions: counts() } });
  assert.equal(calls[0][0], 'https://backend.example.test/internal/classroom/submissions');
  assert.equal(calls[0][1].method, 'POST');
  assert.equal(calls[0][1].redirect, 'error');
  assert.deepEqual(JSON.parse(calls[0][1].body), { userId: 'u', googleId: 'g' });

  for (const [body, status] of [[{ submissions: { ...counts(), stored: -1 } }, 200], [{ submissions: { ...counts(), skipped: 'no' } }, 200], [{}, 200], [{ error: 'x' }, 503]]) {
    const c = createClassroomWorkerClient({ baseUrl: 'https://backend.example.test', apiKey: 'synthetic-key',
      fetchImpl: async () => new Response(JSON.stringify(body), { status }) });
    const r = await c.submissions({ userId: 'u', googleId: 'g' });
    assert.equal(r.ok, false);
    assert.equal(r.status, status === 200 ? 502 : status);
  }
});
