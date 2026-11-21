const { test } = require('node:test');
const assert = require('node:assert/strict');
const request = require('supertest');
const { createApp } = require('../../src/app');
const { createCoursesService } = require('../../src/services/classroomCourses');
const { saveGoogleAuthorization, CLASSROOM_SCOPE, CLASSROOM_WORK_SCOPE } = require('../../src/services/googleAuthService');
const { encrypt } = require('../../src/utils/secureToken');
const { createFakeSupabase } = require('../helpers/fakeSupabase');
const { API_KEY, CREDENTIALS_KEY } = require('../helpers/payloads');
const secret = 'synthetic-secret-'.repeat(4);
const identity = { userId: 'student-a', googleId: 'google-a' };
const json = (body, status = 200) => new Response(JSON.stringify(body), { status });
const token = () => json({ access_token: 'synthetic-access', token_type: 'Bearer', expires_in: 3600 });
function setup(responses = []) {
  const db = createFakeSupabase();
  const config = { internalApiKey: API_KEY, credentialsEncryptionKey: CREDENTIALS_KEY,
    googleAuthSecret: secret, googleOAuth: { enabled: true, clientId: 'synthetic-id', clientSecret: 'synthetic-secret' } };
  db.tables.google_authorizations.push({ user_id: identity.userId, google_id: identity.googleId,
    scope: `${CLASSROOM_SCOPE} ${CLASSROOM_WORK_SCOPE}`, status: 'active', refresh_token: encrypt({ token: 'synthetic-refresh' }, secret, 'google-refresh') });
  const calls = [], logs = [];
  const classroomFetch = async (...args) => {
    calls.push(args); assert.ok(responses.length, 'Unexpected request'); return responses.shift();
  };
  const app = createApp({ config, supabase: db.client, classroomFetch, channels: [],
    logger: { error: (...args) => logs.push(args), info: (...args) => logs.push(args), warn() {} } });
  return { db, config, app, calls, logs,
    service: createCoursesService({ config, supabase: db.client, fetchImpl: classroomFetch }),
    read: (body = identity) => request(app).post('/internal/classroom/read').set('x-api-key', API_KEY).send(body) };
}

test('sync opt in persists backend metadata and exposes only counts', async () => {
  const s = setup([token(), json({ courses: [{ id: '1', name: 'PRIVATE COURSE', ownerId: 'PRIVATE' }] }),
    json({ courseWork: [{ id: '2', courseId: '1', title: 'PRIVATE TITLE', creatorUserId: 'PRIVATE',
      description: 'PRIVATE', state: 'PUBLISHED' }] })]);
  const userId = '00000000-0000-4000-8000-000000000001';
  s.db.tables.google_authorizations[0].user_id = userId;
  let writes = 0;
  s.db.client.rpc = async (name, args) => {
    writes++;
    assert.equal(args.p_user_id, userId);
    assert.equal(args.p_google_id, identity.googleId);
    assert.equal(args.p_courses[0].name, 'PRIVATE COURSE');
    assert.equal(args.p_courses[0].coursework[0].title, 'PRIVATE TITLE');
    assert.doesNotMatch(JSON.stringify(args), /creator|owner|description|refresh|access_token/);
    return { data: { courses: 1, coursework: 1, newTasks: 0 } };
  };
  const res = await s.read({ userId, googleId: identity.googleId, sync: true, courses: [{ id: 'attacker' }] });
  assert.equal(res.status, 200);
  assert.deepEqual(res.body, { sync: { courses: 1, coursework: 1, newTasks: 0 } });
  assert.doesNotMatch(JSON.stringify([res.body, s.logs]), /PRIVATE|synthetic|refresh/);
  assert.equal(writes, 1);
});

test('sync failure after a partial Google read performs no writes', async () => {
  const s = setup([token(), json({ courses: [{ id: '1', name: 'PRIVATE' }, { id: '3', name: 'PRIVATE' }] }),
    json({ courseWork: [{ id: '2', courseId: '1', title: 'PRIVATE' }] }), json({}, 503)]);
  const userId = '00000000-0000-4000-8000-000000000001';
  s.db.tables.google_authorizations[0].user_id = userId;
  s.db.client.rpc = () => { assert.fail('Partial snapshots must not persist'); };
  assert.equal((await s.read({ userId, googleId: identity.googleId, sync: true })).status, 503);
});

// ITN-43b: sync only needs the courses scope; tasks only when the task scope is granted.
const scopeSetup = (stored, refreshed) => {
  const s = setup([json({ access_token: 'synthetic-access', token_type: 'Bearer', expires_in: 3600,
    ...(refreshed === undefined ? {} : { scope: refreshed }) }),
  json({ courses: [{ id: 'c1', name: 'PRIVATE' }] }),
  json({ courseWork: [{ id: 'w1', courseId: 'c1', title: 'PRIVATE', state: 'PUBLISHED' }] })]);
  const userId = '00000000-0000-4000-8000-000000000001';
  Object.assign(s.db.tables.google_authorizations[0], { user_id: userId, scope: stored });
  s.rpcArgs = [];
  s.db.client.rpc = async (name, args) => { s.rpcArgs.push(args); return { data: { courses: 1, coursework: 0, newTasks: 0 } }; };
  s.syncRead = () => s.read({ userId, googleId: identity.googleId, sync: true });
  return s;
};
const both = `${CLASSROOM_SCOPE} ${CLASSROOM_WORK_SCOPE}`;
for (const [label, stored, refreshed, withWork] of [
  ['courses-only grant syncs courses and never lists coursework', CLASSROOM_SCOPE, CLASSROOM_SCOPE, false],
  ['courses-only grant with broader refreshed scope stays courses-only', CLASSROOM_SCOPE, both, false],
  ['refreshed token without task scope falls back to courses-only', both, CLASSROOM_SCOPE, false],
  ['both scopes sync courses and tasks', both, both, true],
  ['both stored scopes and refresh without scope field sync tasks', both, undefined, true],
]) test(`sync scopes: ${label}`, async () => {
  const s = scopeSetup(stored, refreshed);
  const res = await s.syncRead();
  assert.equal(res.status, 200);
  assert.deepEqual(res.body, { sync: { courses: 1, coursework: 0, newTasks: 0 } });
  assert.equal(s.calls.length, withWork ? 3 : 2);
  assert.equal(s.calls.some(([url]) => String(url).includes('/courseWork')), withWork);
  assert.equal(s.rpcArgs.length, 1);
  const [course] = s.rpcArgs[0].p_courses;
  if (withWork) assert.equal(course.coursework.length, 1);
  else assert.equal(Object.hasOwn(course, 'coursework'), false);
  assert.doesNotMatch(JSON.stringify([res.body, s.logs]), /PRIVATE|synthetic|refresh_token/);
});

test('sync without the courses scope responds 403 for permissions', async () => {
  const s = scopeSetup(CLASSROOM_WORK_SCOPE, both);
  const res = await s.syncRead();
  assert.equal(res.status, 403);
  assert.deepEqual(res.body, { error: 'classroom_sin_permisos' });
  assert.equal(s.calls.length, 0);
  assert.equal(s.rpcArgs.length, 0);
  const refreshed = scopeSetup(both, CLASSROOM_WORK_SCOPE);
  assert.equal((await refreshed.syncRead()).status, 403);
  assert.equal(refreshed.calls.length, 1);
  assert.equal(refreshed.rpcArgs.length, 0);
});

for (const [label, storedWork, refreshedWork, sync, status, calls] of [
  ['legacy courses-only grant and refresh', false, false, false, 200, 3],
  ['legacy courses-only grant with additional refreshed permission', false, true, false, 200, 3],
  ['legacy refresh keeps only courses', true, false, false, 200, 3],
  ['sync with courses-only stored grant syncs only courses', false, true, true, 200, 2],
  ['sync with courses-only refreshed token syncs only courses', true, false, true, 200, 2],
  ['sync accepts both stored and refreshed scopes', true, true, true, 200, 3],
]) test(`ITN-59 compatibility: ${label}`, async () => {
  const s = setup([json({ access_token: 'synthetic-access', token_type: 'Bearer', expires_in: 3600,
    scope: refreshedWork ? `${CLASSROOM_SCOPE} ${CLASSROOM_WORK_SCOPE}` : CLASSROOM_SCOPE }),
  json({ courses: [{ id: 'c1', name: 'PRIVATE' }] }),
  json({ courseWork: [{ id: 'w1', courseId: 'c1', title: 'PRIVATE', dueDate: { year: 2026, month: 11, day: 20 } }] })]);
  const userId = '00000000-0000-4000-8000-000000000001';
  Object.assign(s.db.tables.google_authorizations[0], { user_id: userId,
    scope: storedWork ? `${CLASSROOM_SCOPE} ${CLASSROOM_WORK_SCOPE}` : CLASSROOM_SCOPE });
  let writes = 0;
  s.db.client.rpc = async () => { writes++; return { data: { courses: 1, coursework: 1, newTasks: 0 } }; };
  const res = await s.read({ userId, googleId: identity.googleId, ...(sync ? { sync: true } : {}) });
  assert.equal(res.status, status);
  assert.equal(s.calls.length, calls);
  assert.equal(writes, sync && status === 200 ? 1 : 0);
  if (status === 200) assert.deepEqual(res.body, sync ? { sync: { courses: 1, coursework: 1, newTasks: 0 } } :
    { courses: [{ id: 'c1', coursework: [{ id: 'w1', dueDate: { year: 2026, month: 11, day: 20 } }] }] });
  else assert.deepEqual(res.body, { error: 'classroom_sin_permisos' });
  assert.doesNotMatch(JSON.stringify([res.body, s.logs]), /PRIVATE|synthetic|refresh_token/);
});

test('sync validates flag and UUID before reading Google', async () => {
  const s = setup();
  for (const sync of ['true', {}, 1, true]) assert.equal((await s.read({ ...identity, sync })).status, 400);
  assert.equal(s.calls.length, 0);
});

for (const [code, status] of [['42501', 500], ['PGRST202', 503], ['XX000', 500]]) {
  test(`sync RPC failure ${code} returns fixed status without academic data`, async () => {
    const s = setup([token(), json({ courses: [] })]);
    const userId = '00000000-0000-4000-8000-000000000001';
    s.db.tables.google_authorizations[0].user_id = userId;
    s.db.client.rpc = async () => ({ error: { code, message: 'PRIVATE synthetic-refresh' } });
    const res = await s.read({ userId, googleId: identity.googleId, sync: true });
    assert.equal(res.status, status);
    assert.deepEqual(Object.keys(res.body), ['error']);
    assert.doesNotMatch(JSON.stringify([res.body, s.logs]), /PRIVATE|synthetic|refresh/);
  });
}
test('internal authentication precedes JSON parsing and Google access', async () => {
  const s = setup();
  for (const key of ['', 'incorrect']) {
    const res = await request(s.app).post('/internal/classroom/read').set('x-api-key', key)
      .set('Content-Type', 'application/json').send('{');
    assert.equal(res.status, 401);
  }
  assert.equal((await s.read({ userId: [] })).status, 400);
  assert.equal(s.calls.length, 0);
});
test('active list excludes relink accounts and never returns credentials', async () => {
  const s = setup();
  const get = () => request(s.app).get('/internal/classroom/active').set('x-api-key', API_KEY);
  assert.deepEqual((await get()).body, { students: [identity] });
  s.db.tables.google_authorizations[0].status = 'needs_relink';
  assert.deepEqual((await get()).body, { students: [] });
  assert.equal(s.calls.length, 0);
});
test('read paginates courses and work, returns only identifiers and due fields', async () => {
  const s = setup([token(), json({ courses: [{ id: '1', name: 'PRIVATE COURSE' }], nextPageToken: 'next' }),
    json({}), json({ courseWork: [{ id: '2', courseId: '1', title: 'PRIVATE TITLE', dueDate: { year: 2026, month: 11, day: 19 },
      dueTime: { hours: 12 }, creatorUserId: 'private@example.test' }], nextPageToken: 'last' }), json({})]);
  const res = await s.read();
  assert.equal(res.status, 200);
  assert.equal(res.headers['cache-control'], 'no-store');
  assert.deepEqual(res.body, { courses: [{ id: '1', coursework: [{ id: '2',
    dueDate: { year: 2026, month: 11, day: 19 }, dueTime: { hours: 12 } }] }] });
  assert.equal(s.calls.length, 5);
  assert.doesNotMatch(JSON.stringify([res.body, s.logs]), /synthetic|PRIVATE|example|refresh|access_token/);
});
test('invalid_grant persists needs_relink and suppresses subsequent refreshes on both APIs', async () => {
  const s = setup([json({ error: 'invalid_grant', description: 'synthetic-refresh' }, 400)]);
  assert.equal((await s.read()).status, 409);
  assert.equal(s.db.tables.google_authorizations[0].status, 'needs_relink');
  assert.equal((await s.read()).status, 409);
  await assert.rejects(s.service(identity), { status: 409 });
  assert.equal(s.calls.length, 1);
  assert.deepEqual(s.logs, []);
});
for (const status of [403, 429, 500]) test(`upstream ${status} discards partial data and preserves active authorization`, async () => {
  const s = setup([token(), json({ courses: [{ id: '1', name: 'PRIVATE' }] }), json({ secret: 'synthetic-access' }, status)]);
  const res = await s.read();
  assert.equal(res.status, status === 403 ? 403 : 503);
  assert.deepEqual(Object.keys(res.body), ['error']);
  assert.equal(s.db.tables.google_authorizations[0].status, 'active');
});
test('wrong identity cannot refresh another account', async () => {
  const s = setup();
  assert.equal((await s.read({ ...identity, userId: 'student-b' })).status, 409);
  assert.equal(s.calls.length, 0);
});
test('reconsent only clears relink with a new refresh token', async () => {
  const s = setup();
  const row = s.db.tables.google_authorizations[0]; row.status = 'needs_relink';
  const args = { supabase: s.db.client, googleId: identity.googleId, email: 'synthetic@example.test',
    scope: CLASSROOM_SCOPE, secret };
  await saveGoogleAuthorization(args);
  assert.equal(row.status, 'needs_relink');
  await saveGoogleAuthorization({ ...args, refreshToken: 'synthetic-new' });
  assert.equal(row.status, 'active');
});

test('mixed user and Google identities never refresh either account', async () => {
  const s = setup();
  s.db.tables.google_authorizations.push({ ...s.db.tables.google_authorizations[0],
    user_id: 'student-b', google_id: 'google-b' });
  for (const body of [{ userId: 'student-a', googleId: 'google-b' },
    { userId: 'student-b', googleId: 'google-a' }]) {
    assert.equal((await s.read(body)).status, 409);
  }
  assert.equal(s.calls.length, 0);
});

test('invalid_grant update failure is sanitized and cannot claim durable relink', async () => {
  const s = setup([json({ error: 'invalid_grant' }, 400)]);
  const from = s.db.client.from.bind(s.db.client);
  s.db.client.from = name => {
    const query = from(name);
    query.update = () => ({ eq() { return this; }, then(resolve) {
      return Promise.resolve({ error: { message: 'synthetic-refresh' } }).then(resolve);
    } });
    return query;
  };
  const res = await s.read();
  assert.equal(res.status, 500);
  assert.deepEqual(res.body, { error: 'error_interno' });
  assert.equal(s.db.tables.google_authorizations[0].status, 'active');
  assert.deepEqual(s.logs, []);
});

test('invalid_grant from an old token cannot block a concurrently replaced authorization', async () => {
  const s = setup();
  const service = createCoursesService({ config: s.config, supabase: s.db.client, fetchImpl: async () => {
    s.db.tables.google_authorizations[0].refresh_token = encrypt({ token: 'synthetic-new' }, secret, 'google-refresh');
    return json({ error: 'invalid_grant' }, 400);
  } });
  await assert.rejects(service.getAccessToken(identity), { status: 409 });
  assert.equal(s.db.tables.google_authorizations[0].status, 'active');
});

test('malformed due fields cannot escape the privacy projection', async () => {
  const s = setup([token(), json({ courses: [{ id: '1', name: 'PRIVATE' }] }),
    json({ courseWork: [{ id: '2', courseId: '1', title: 'PRIVATE', dueDate: { year: 'private@example.test' } }] })]);
  const res = await s.read();
  assert.equal(res.status, 502);
  assert.deepEqual(res.body, { error: 'classroom_respuesta_invalida' });
  assert.deepEqual(s.logs, []);
});

test('active enumeration requires the internal API key', async () => {
  const s = setup();
  assert.equal((await request(s.app).get('/internal/classroom/active')).status, 401);
  assert.equal(s.calls.length, 0);
});

test('before 014: active enumeration fails closed instead of listing unverified grants', async () => {
  const s = setup();
  s.db.withoutColumn('google_authorizations', 'status');
  const res = await request(s.app).get('/internal/classroom/active').set('x-api-key', API_KEY);
  assert.equal(res.status, 503);
  assert.deepEqual(res.body, { error: 'classroom_migracion_requerida' });
  assert.equal(s.calls.length, 0);
});

test('before 014: OAuth insert, reconsent and preservation without a new token work', async () => {
  const s = setup();
  s.db.tables.google_authorizations = [];
  s.db.withoutColumn('google_authorizations', 'status');
  const args = { supabase: s.db.client, googleId: identity.googleId, email: 'synthetic@example.test',
    authoritativeEmail: true, scope: CLASSROOM_SCOPE, secret, refreshToken: 'synthetic-new' };
  const saved = await saveGoogleAuthorization(args);
  assert.ok(saved.userId);
  const original = s.db.tables.google_authorizations[0].refresh_token;
  await saveGoogleAuthorization({ ...args, refreshToken: undefined });
  assert.equal(s.db.tables.google_authorizations[0].refresh_token, original);
  await saveGoogleAuthorization(args);
  assert.notEqual(s.db.tables.google_authorizations[0].refresh_token, original);
  assert.equal(s.db.tables.app_users.length, 1);
});

test('before 014: failure to delete a revoked grant returns 500 and never returns a token', async () => {
  const s = setup([json({ error: 'invalid_grant' }, 400)]);
  s.db.withoutColumn('google_authorizations', 'status');
  s.db.failNext('google_authorizations', 'delete');
  const res = await s.read();
  assert.equal(res.status, 500);
  assert.deepEqual(res.body, { error: 'error_interno' });
  assert.equal(s.db.tables.google_authorizations.length, 1);
  assert.deepEqual(s.logs, []);
});

test('before 014: a revoked old token cannot delete a concurrent new grant', async () => {
  const s = setup();
  s.db.withoutColumn('google_authorizations', 'status');
  const service = createCoursesService({ config: s.config, supabase: s.db.client, fetchImpl: async () => {
    s.db.tables.google_authorizations[0].refresh_token = encrypt({ token: 'synthetic-new' }, secret, 'google-refresh');
    return json({ error: 'invalid_grant' }, 400);
  } });
  await assert.rejects(service.getAccessToken(identity), { status: 409 });
  assert.equal(s.db.tables.google_authorizations.length, 1);
});

test('missing legacy columns and real database errors never fall back to successful responses', async () => {
  for (const code of ['42501', 'XX000', '42703']) {
    const s = setup();
    s.db.failNext('google_authorizations', 'select', code);
    assert.equal((await s.read()).status, 500);
    assert.equal(s.calls.length, 0);
  }
  const s = setup();
  s.db.withoutColumn('google_authorizations', 'status');
  s.db.withoutColumn('google_authorizations', 'refresh_token');
  assert.equal((await s.read()).status, 500);
  assert.equal(s.calls.length, 0);
});

test('OAuth database write failures propagate without dropping status or hiding errors', async () => {
  for (const missingStatus of [false, true]) {
    const s = setup();
    if (missingStatus) s.db.withoutColumn('google_authorizations', 'status');
    s.db.failNext('google_authorizations', 'update', '42501');
    await assert.rejects(saveGoogleAuthorization({ supabase: s.db.client, googleId: identity.googleId,
      email: 'synthetic@example.test', scope: CLASSROOM_SCOPE, secret, refreshToken: 'synthetic-new' }),
    { code: '42501' });
  }
});

// Cross-service contract test only: production artifacts remain independent.
for (const [label, error, status, exitCode] of [
  ['known authorization conflict', { code: '42501', message: 'classroom_authorization_required' }, 409, 0],
  ['missing table privileges', { code: '42501', message: 'permission denied for table app_users PRIVATE' }, 500, 1],
  ['RLS denial', { code: '42501', message: 'new row violates row-level security policy PRIVATE' }, 500, 1],
  ['missing signal', { code: '42501' }, 500, 1],
  ['signal with unknown code', { code: 'XX000', message: 'classroom_authorization_required' }, 500, 1],
  ['nonexact signal', { code: '42501', message: 'classroom_authorization_required PRIVATE' }, 500, 1],
  ['missing RPC', { code: 'PGRST202', message: 'PRIVATE' }, 503, 1],
]) test('SQL failure through backend, HTTP worker and cron: ' + label, async () => {
  const { ejecutarClassroom } = require('../../../automation/schedulers/classroom-fase');
  const { createClassroomWorkerClient } = require('../../../automation/rpa/google-classroom');
  const s = setup([token(), json({ courses: [] })]);
  const userId = '00000000-0000-4000-8000-000000000001';
  s.db.tables.google_authorizations[0].user_id = userId;
  s.db.client.rpc = async () => ({ error: { ...error, details: 'PRIVATE', hint: 'PRIVATE' } });
  const responses = [], bodies = [], logs = [];
  const client = createClassroomWorkerClient({ baseUrl: 'https://synthetic.test', apiKey: API_KEY,
    fetchImpl: async (url, options) => {
      const res = url.endsWith('/active')
        ? await request(s.app).get('/internal/classroom/active').set('x-api-key', API_KEY)
        : await s.read(JSON.parse(options.body));
      if (!url.endsWith('/active')) {
        responses.push(res.status);
        bodies.push(res.body);
      }
      return json(res.body, res.status);
    } });
  const code = await ejecutarClassroom({ env: { CLASSROOM_SYNC_ENABLED: 'true' }, crearCliente: () => client,
    log: line => logs.push(line), logError: line => logs.push(line) });
  assert.equal(code, exitCode);
  assert.deepEqual(responses, [status]);
  assert.deepEqual(bodies, [{ error: status === 409 ? 'classroom_requiere_autorizacion' :
    status === 503 ? 'classroom_migracion_requerida' : 'error_interno' }]);
  assert.deepEqual(logs, [status === 409 ? 'Classroom: procesadas=0 omitidas=1 fallidas=0' :
    'Classroom: procesadas=0 omitidas=0 fallidas=1']);
  assert.doesNotMatch(JSON.stringify([logs, s.logs]), /PRIVATE|permission denied|row-level|classroom_authorization_required/);
});

// ITN-43c: el alias es empírico; la prueba real es courseWork.list. Un 403 ahí se trata como
// "sin permiso de tareas": se omiten las tareas de todos los cursos y los cursos se sincronizan.
const ALIAS = 'https://www.googleapis.com/auth/classroom.student-submissions.me.readonly';
test('sync with the alias reads tasks; a 403 from courseWork.list falls back to courses-only', async () => {
  const s = scopeSetup(`${CLASSROOM_SCOPE} ${ALIAS}`, `openid ${CLASSROOM_SCOPE} ${ALIAS}`);
  const res = await s.syncRead();
  assert.equal(res.status, 200);
  assert.equal(s.calls.some(([url]) => String(url).includes('/courseWork')), true);
  assert.equal(s.rpcArgs[0].p_courses[0].coursework.length, 1);

  const denied = setup([json({ access_token: 'synthetic-access', token_type: 'Bearer', expires_in: 3600,
    scope: `${CLASSROOM_SCOPE} ${ALIAS}` }),
  json({ courses: [{ id: 'c1', name: 'PRIVATE' }, { id: 'c2', name: 'PRIVATE' }] }),
  json({ courseWork: [{ id: 'w1', courseId: 'c1', title: 'PRIVATE' }] }),
  json({ error: { status: 'PERMISSION_DENIED' } }, 403)]);
  const userId = '00000000-0000-4000-8000-000000000001';
  Object.assign(denied.db.tables.google_authorizations[0], { user_id: userId, scope: `${CLASSROOM_SCOPE} ${CLASSROOM_WORK_SCOPE}` });
  const rpcArgs = [];
  denied.db.client.rpc = async (name, args) => { rpcArgs.push(args); return { data: { courses: 2, coursework: 0, newTasks: 0 } }; };
  const out = await denied.read({ userId, googleId: identity.googleId, sync: true });
  assert.equal(out.status, 200);
  assert.equal(rpcArgs.length, 1);
  assert.equal(rpcArgs[0].p_courses.length, 2);
  for (const course of rpcArgs[0].p_courses) assert.equal(Object.hasOwn(course, 'coursework'), false);
  assert.equal(denied.db.tables.google_authorizations[0].status, 'active');
  assert.doesNotMatch(JSON.stringify([out.body, denied.logs]), /PRIVATE|synthetic|refresh_token/);
});

test('refresh with neither task name syncs only courses', async () => {
  const s = scopeSetup(`${CLASSROOM_SCOPE} ${ALIAS}`, `openid ${CLASSROOM_SCOPE}`);
  assert.equal((await s.syncRead()).status, 200);
  assert.equal(s.calls.some(([url]) => String(url).includes('/courseWork')), false);
  assert.equal(Object.hasOwn(s.rpcArgs[0].p_courses[0], 'coursework'), false);
});

test('legacy read (no sync) still fails on a courseWork 403', async () => {
  const s = setup([token(), json({ courses: [{ id: 'c1', name: 'PRIVATE' }] }), json({}, 403)]);
  const res = await s.read();
  assert.equal(res.status, 403);
  assert.deepEqual(res.body, { error: 'classroom_sin_permisos' });
});
