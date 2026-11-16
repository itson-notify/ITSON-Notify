const { test, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const request = require('supertest');
const { createApp } = require('../../src/app');
const { createCoursesService } = require('../../src/services/classroomCourses');
const { encrypt } = require('../../src/utils/secureToken');
const { sessionHash } = require('../../src/middleware/studentSession');
const { CLASSROOM_SCOPE } = require('../../src/services/googleAuthService');
const { createFakeSupabase } = require('../helpers/fakeSupabase');
const { API_KEY, CREDENTIALS_KEY } = require('../helpers/payloads');

const SECRET = 'synthetic-classroom-secret-'.repeat(2);
const NOW = Date.parse('2026-11-15T12:00:00Z');
const student = { userId: 'student-a', googleId: 'google-a', sessionId: 'session-a', exp: NOW + 60000 };
const json = (body, status = 200) => new Response(JSON.stringify(body), { status });
const token = () => json({ access_token: 'synthetic-access', token_type: 'Bearer', expires_in: 3600 });
beforeEach(t => {
  t.mock.method(globalThis, 'fetch', () => { assert.fail('External fetch forbidden'); });
  t.mock.method(require('node:https'), 'request', () => { assert.fail('External HTTPS forbidden'); });
});

function setup(responses = []) {
  const db = createFakeSupabase();
  const config = { internalApiKey: API_KEY, credentialsEncryptionKey: CREDENTIALS_KEY,
    googleAuthSecret: SECRET, googleOAuth: { enabled: true, clientId: 'synthetic-client', clientSecret: 'synthetic-secret' } };
  db.tables.google_app_sessions.push({ id: sessionHash(student.sessionId), user_id: student.userId,
    google_id: student.googleId, expires_at: new Date(NOW + 60000).toISOString() });
  db.tables.google_authorizations.push({ user_id: student.userId, google_id: student.googleId,
    scope: CLASSROOM_SCOPE, refresh_token: encrypt({ token: 'synthetic-refresh' }, SECRET, 'google-refresh') });
  const calls = [], logs = [];
  const fetchImpl = async (...args) => {
    calls.push(args);
    assert.ok(responses.length, 'Unexpected HTTP request');
    const value = responses.shift();
    if (value instanceof Error) throw value;
    return value;
  };
  const app = createApp({ config, supabase: db.client, classroomFetch: fetchImpl, now: () => NOW,
    channels: [], logger: { error: (...args) => logs.push(args), info() {}, warn() {} } });
  const cookie = value => `itn41_google_session=${encrypt(value, SECRET, 'google-session')}`;
  const get = (value = student) => request(app).get('/api/classroom/courses?userId=student-b&googleId=google-b')
    .set('Cookie', cookie(value));
  return { db, calls, logs, app, get, config,
    service: createCoursesService({ config, supabase: db.client, fetchImpl }) };
}

test('service: paginates as the current student, minimizes output and never writes tokens', async () => {
  const s = setup([token(), json({ courses: [{ id: '001', name: 'A', section: '1', ownerId: 'private', enrollmentCode: 'private' }], nextPageToken: 'next' }),
    json({ courses: [{ id: '002', name: 'B', courseState: 'ACTIVE' }] })]);
  const before = JSON.stringify(s.db.tables);
  assert.deepEqual(await s.service(student), { courses: [{ id: '001', name: 'A', section: '1' }, { id: '002', name: 'B', courseState: 'ACTIVE' }] });
  assert.equal(JSON.stringify(s.db.tables), before);
  assert.equal(s.calls.length, 3);
  const [url, init] = s.calls[0];
  assert.equal(url, 'https://oauth2.googleapis.com/token');
  assert.equal(init.method, 'POST');
  assert.equal(init.redirect, 'error');
  assert.ok(init.signal instanceof AbortSignal);
  const body = new URLSearchParams(init.body);
  assert.equal(body.get('refresh_token'), 'synthetic-refresh');
  assert.equal(body.get('grant_type'), 'refresh_token');
  assert.equal(body.get('client_secret'), 'synthetic-secret');
  for (const [url, init] of s.calls.slice(1)) {
    assert.equal(new URL(url).searchParams.get('studentId'), 'me');
    assert.equal(init.headers.Authorization, 'Bearer synthetic-access');
  }
  assert.equal(new URL(s.calls[2][0]).searchParams.get('pageToken'), 'next');
});

test('API: authenticated empty list and no-store', async () => {
  const s = setup([token(), json({})]);
  const res = await s.get();
  assert.equal(res.status, 200);
  assert.deepEqual(res.body, { courses: [] });
  assert.equal(res.headers['cache-control'], 'no-store');
});

for (const mode of ['missing', 'tampered', 'expired', 'revoked', 'deleted', 'wrong-owner', 'wrong-google', 'db-expired']) {
  test(`API: session ${mode} rejects before Google`, async () => {
    const s = setup();
    let value = student;
    if (mode === 'expired') value = { ...student, exp: NOW - 1 };
    if (mode === 'revoked') s.db.tables.google_app_sessions[0].revoked_at = new Date(NOW).toISOString();
    if (mode === 'deleted') s.db.tables.google_app_sessions = [];
    if (mode === 'wrong-owner') s.db.tables.google_app_sessions[0].user_id = 'student-b';
    if (mode === 'wrong-google') s.db.tables.google_app_sessions[0].google_id = 'google-b';
    if (mode === 'db-expired') s.db.tables.google_app_sessions[0].expires_at = new Date(NOW - 1).toISOString();
    const res = mode === 'missing' ? await request(s.app).get('/api/classroom/courses') :
      mode === 'tampered' ? await request(s.app).get('/api/classroom/courses').set('Cookie', 'itn41_google_session=a.b.c') : await s.get(value);
    assert.equal(res.status, 401);
    assert.equal(s.calls.length, 0);
  });
}

for (const mode of ['missing', 'owner', 'google', 'ciphertext', 'purpose', 'scope']) {
  test(`API: authorization ${mode} cannot use another student's token`, async () => {
    const s = setup();
    const row = s.db.tables.google_authorizations[0];
    if (mode === 'missing') s.db.tables.google_authorizations = [];
    if (mode === 'owner') row.user_id = 'student-b';
    if (mode === 'google') row.google_id = 'google-b';
    if (mode === 'ciphertext') row.refresh_token = 'invalid';
    if (mode === 'purpose') row.refresh_token = encrypt({ token: 'synthetic-refresh' }, SECRET, 'google-session');
    if (mode === 'scope') row.scope = 'openid';
    const res = await s.get();
    assert.equal(res.status, mode === 'scope' ? 403 : 409);
    assert.equal(s.calls.length, 0);
  });
}

for (const [name, responses, expected] of [
  ['revoked refresh', [json({ error: 'invalid_grant', secret: 'synthetic-refresh' }, 400)], 409],
  ['client failure', [json({ error: 'invalid_client' }, 401)], 502],
  ['refresh HTTP', [json({}, 503)], 503],
  ['refresh rate limit', [json({}, 429)], 503],
  ['refresh network', [new Error('synthetic-refresh')], 503],
  ['refresh timeout', [Object.assign(new Error('synthetic-secret'), { name: 'TimeoutError' })], 503],
  ['refresh malformed', [json({ access_token: 'synthetic-access' })], 502],
  ['refresh expired', [json({ access_token: 'synthetic-access', token_type: 'Bearer', expires_in: 0 })], 502],
  ['refresh scope', [json({ access_token: 'synthetic-access', token_type: 'Bearer', expires_in: 3600, scope: 'openid' })], 403],
  ['courses expired token', [token(), json({}, 401)], 409],
  ['courses permissions', [token(), json({}, 403)], 403],
  ['courses HTTP', [token(), json({}, 404)], 502],
  ['courses rate limit', [token(), json({}, 429)], 503],
  ['courses server', [token(), json({}, 500)], 503],
  ['courses network', [token(), new Error('synthetic-access')], 503],
  ['courses malformed', [token(), json({ courses: [null] })], 502],
  ['later page fails', [token(), json({ courses: [{ id: '1', name: 'A' }], nextPageToken: 'next' }), json({}, 503)], 503],
]) {
  test(`API: ${name} returns sanitized error without partial data`, async () => {
    const s = setup(responses);
    const res = await s.get();
    assert.equal(res.status, expected);
    assert.deepEqual(Object.keys(res.body), ['error']);
    assert.equal(res.headers['cache-control'], 'no-store');
    assert.doesNotMatch(JSON.stringify([res.body, s.logs]), /synthetic-(access|refresh|secret)|private/);
    assert.equal(responses.length, 0);
  });
}

test('API: disabled OAuth does not call Google', async () => {
  const s = setup();
  s.config.googleOAuth.enabled = false;
  assert.equal((await s.get()).status, 503);
  assert.equal(s.calls.length, 0);
});

test('API: Supabase failure closes access without exposing details', async () => {
  const s = setup();
  const from = s.db.client.from.bind(s.db.client);
  s.db.client.from = table => table === 'google_authorizations' ? {
    select() { return this; }, eq() { return this; },
    maybeSingle: async () => ({ error: { code: 'synthetic-refresh', message: 'synthetic-secret' } }),
  } : from(table);
  const res = await s.get();
  assert.equal(res.status, 500);
  assert.deepEqual(res.body, { error: 'error_interno' });
  assert.deepEqual(s.logs, []);
  assert.equal(s.calls.length, 0);
});
