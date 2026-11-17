const { test } = require('node:test');
const assert = require('node:assert/strict');
const request = require('supertest');
const { createApp } = require('../../src/app');
const { createCoursesService } = require('../../src/services/classroomCourses');
const { saveGoogleAuthorization, CLASSROOM_SCOPE } = require('../../src/services/googleAuthService');
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
    scope: CLASSROOM_SCOPE, status: 'active', refresh_token: encrypt({ token: 'synthetic-refresh' }, secret, 'google-refresh') });
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
