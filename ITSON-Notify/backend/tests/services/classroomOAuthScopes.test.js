// Characterization only: no equivalence is assumed and no Google calls are made.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const express = require('express');
const request = require('supertest');
const { loadConfig } = require('../../src/config/env');
const { CLASSROOM_SCOPE, CLASSROOM_WORK_SCOPE, generateAuthUrl, exchangeCodeForTokens,
  saveGoogleAuthorization } = require('../../src/services/googleAuthService');
const { createCoursesService } = require('../../src/services/classroomCourses');
const { authGoogleRouter } = require('../../src/routes/authGoogle');
const { encrypt } = require('../../src/utils/secureToken');
const { createFakeSupabase } = require('../helpers/fakeSupabase');

const alternate = 'https://www.googleapis.com/auth/classroom.student-submissions.me.readonly';
const secret = 'synthetic-scope-test-secret-'.repeat(3);
const scopes = work => `${CLASSROOM_SCOPE} ${work}`;
const identity = { userId: '00000000-0000-4000-8000-000000000001', googleId: 'synthetic-google' };
const config = { googleAuthSecret: secret, frontendUrl: 'http://localhost:5173',
  googleOAuth: { enabled: true, clientId: 'synthetic-client', clientSecret: 'synthetic-secret',
    redirectUri: 'http://localhost:3000/auth/google/callback', scopes: [CLASSROOM_SCOPE, CLASSROOM_WORK_SCOPE] } };
const json = value => new Response(JSON.stringify(value));

test('configured request uses literal coursework scope, alternative and write scopes fail allowlist', () => {
  const env = { PORT: '3000', INTERNAL_API_KEY: 'synthetic-internal-'.repeat(3),
    SUPABASE_URL: 'https://synthetic.supabase.test', SUPABASE_SERVICE_ROLE_KEY: 'synthetic-role',
    CREDENTIALS_ENCRYPTION_KEY: Buffer.alloc(32, 7).toString('base64'),
    GOOGLE_OAUTH_ENABLED: 'true', GOOGLE_CLIENT_ID: config.googleOAuth.clientId,
    GOOGLE_CLIENT_SECRET: config.googleOAuth.clientSecret, GOOGLE_REDIRECT_URI: config.googleOAuth.redirectUri,
    GOOGLE_OAUTH_SCOPES: scopes(CLASSROOM_WORK_SCOPE) };
  const oauth = loadConfig(env).googleOAuth;
  const url = new URL(generateAuthUrl({ ...oauth, state: 'synthetic-state', challenge: 'synthetic-challenge' }));
  assert.deepEqual(url.searchParams.get('scope').split(' '), ['openid', 'email', 'profile', CLASSROOM_SCOPE, CLASSROOM_WORK_SCOPE]);
  for (const work of [alternate, 'https://www.googleapis.com/auth/classroom.coursework.me',
    'https://www.googleapis.com/auth/classroom.coursework.students.readonly']) {
    assert.throws(() => loadConfig({ ...env, GOOGLE_OAUTH_SCOPES: scopes(work) }), /GOOGLE_OAUTH_SCOPES/);
  }
});

for (const [name, work] of [['documented', CLASSROOM_WORK_SCOPE], ['alternative', alternate]]) {
  test(`exchange preserves ${name} scope; save requires the configured literal name`, async () => {
    const response = await exchangeCodeForTokens({ code: 'synthetic-code', clientId: 'synthetic-client',
      clientSecret: 'synthetic-secret', redirectUri: config.googleOAuth.redirectUri, verifier: 'synthetic-verifier',
      fetchImpl: async () => json({ id_token: 'synthetic-id', access_token: 'synthetic-access', scope: scopes(work) }) });
    assert.equal(response.scope, scopes(work));
    const db = createFakeSupabase();
    const save = () => saveGoogleAuthorization({ supabase: db.client, googleId: identity.googleId,
      email: 'synthetic@example.test', authoritativeEmail: true, refreshToken: 'synthetic-refresh',
      scope: response.scope, secret, requiredScopes: config.googleOAuth.scopes });
    if (work === alternate) {
      await assert.rejects(save(), /classroom_scope_not_granted/);
      assert.equal(db.calls.length, 0);
    } else {
      await save();
      assert.equal(db.tables.google_authorizations[0].scope, scopes(work));
    }
  });

  test(`signed OAuth callback with ${name} token-response scope`, async () => {
    const db = createFakeSupabase(), logs = [];
    const { privateKey, publicKey } = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
    const jwk = { ...publicKey.export({ format: 'jwk' }), kid: 'synthetic-kid', use: 'sig', alg: 'RS256' };
    let idToken;
    const app = express();
    app.use('/auth/google', authGoogleRouter({ config, supabase: db.client,
      logger: { info() {}, warn: (...args) => logs.push(args) },
      fetchImpl: async url => {
        if (url === 'https://oauth2.googleapis.com/token') return json({ id_token: idToken,
          access_token: 'synthetic-access', refresh_token: 'synthetic-refresh', scope: scopes(work) });
        assert.equal(url, 'https://www.googleapis.com/oauth2/v3/certs');
        return json({ keys: [jwk] });
      } }));
    const agent = request.agent(app);
    const start = await agent.get('/auth/google');
    const nonce = new URL(start.headers.location).searchParams.get('state');
    const encode = value => Buffer.from(JSON.stringify(value)).toString('base64url');
    const message = `${encode({ alg: 'RS256', kid: jwk.kid })}.${encode({
      iss: 'https://accounts.google.com', aud: config.googleOAuth.clientId, sub: identity.googleId,
      email: 'synthetic@example.test', hd: 'example.test', email_verified: true, nonce,
      exp: Math.floor(Date.now() / 1000) + 3600 })}`;
    idToken = `${message}.${crypto.sign('RSA-SHA256', Buffer.from(message), privateKey).toString('base64url')}`;
    // A callback query scope cannot override the token endpoint's scope.
    const queryScope = work === alternate ? CLASSROOM_WORK_SCOPE : alternate;
    const callback = await agent.get('/auth/google/callback').query({ code: 'synthetic-code', state: nonce, scope: scopes(queryScope) });
    assert.equal(callback.status, 302);
    assert.equal(new URL(callback.headers.location).searchParams.get('classroom'), work === alternate ? 'error' : 'auth_success');
    assert.equal(db.tables.google_authorizations.length, work === alternate ? 0 : 1);
    assert.equal(db.tables.google_app_sessions.length, work === alternate ? 0 : 1);
    assert.doesNotMatch(JSON.stringify(logs), /synthetic|refresh|access_token/);
  });
}

for (const [name, stored, refreshed, expectedCalls] of [
  ['documented grant and documented refresh', CLASSROOM_WORK_SCOPE, CLASSROOM_WORK_SCOPE, 3],
  ['alternative stored grant', alternate, CLASSROOM_WORK_SCOPE, 0],
  ['write scope cannot substitute for task read scope', 'https://www.googleapis.com/auth/classroom.coursework.me', CLASSROOM_WORK_SCOPE, 0],
  ['broader student scope cannot substitute for personal task scope', 'https://www.googleapis.com/auth/classroom.coursework.students.readonly', CLASSROOM_WORK_SCOPE, 0],
  ['alternative refreshed scope', CLASSROOM_WORK_SCOPE, alternate, 1],
  ['refresh without scope uses the stored grant', CLASSROOM_WORK_SCOPE, undefined, 3],
]) test(`readForWorker sync: ${name}`, async () => {
  const db = createFakeSupabase(), calls = [];
  db.client.rpc = async () => ({ data: { courses: 1, coursework: 1, newTasks: 0 } });
  db.tables.google_authorizations.push({ user_id: identity.userId, google_id: identity.googleId,
    status: 'active', scope: scopes(stored), refresh_token: encrypt({ token: 'synthetic-refresh' }, secret, 'google-refresh') });
  const service = createCoursesService({ config, supabase: db.client, fetchImpl: async url => {
    calls.push(url);
    if (url === 'https://oauth2.googleapis.com/token') return json({ access_token: 'synthetic-access',
      token_type: 'Bearer', expires_in: 3600, ...(refreshed === undefined ? {} : { scope: scopes(refreshed) }) });
    if (new URL(url).pathname === '/v1/courses') return json({ courses: [{ id: 'c1', name: 'Synthetic course' }] });
    assert.equal(new URL(url).pathname, '/v1/courses/c1/courseWork');
    return json({ courseWork: [{ id: 'w1', courseId: 'c1', title: 'Synthetic task' }] });
  } });
  if (expectedCalls === 3) assert.deepEqual(await service.readForWorker(identity, { sync: true }), { sync: { courses: 1, coursework: 1, newTasks: 0 } });
  else await assert.rejects(service.readForWorker(identity, { sync: true }), { status: 403, code: 'classroom_sin_permisos' });
  assert.equal(calls.length, expectedCalls);
  assert.equal(db.tables.google_authorizations[0].status, 'active');
  assert.equal(db.calls.filter(call => call.op !== 'select').length, 0);
});

test('getAccessToken default remains courses-only; explicit task requirements reject the alternative', async () => {
  const db = createFakeSupabase();
  db.tables.google_authorizations.push({ user_id: identity.userId, google_id: identity.googleId,
    status: 'active', scope: scopes(alternate), refresh_token: encrypt({ token: 'synthetic-refresh' }, secret, 'google-refresh') });
  let calls = 0;
  const service = createCoursesService({ config, supabase: db.client, fetchImpl: async () => {
    calls++;
    return json({ access_token: 'synthetic-access', token_type: 'Bearer', expires_in: 3600, scope: scopes(alternate) });
  } });
  assert.equal(typeof await service.getAccessToken(identity), 'string');
  await assert.rejects(service.getAccessToken(identity, config.googleOAuth.scopes), { status: 403 });
  assert.equal(calls, 1);
});

test('courses-only OAuth config can save alternative metadata but does not certify task access', async () => {
  const db = createFakeSupabase();
  await saveGoogleAuthorization({ supabase: db.client, googleId: identity.googleId,
    email: 'synthetic@example.test', authoritativeEmail: true, refreshToken: 'synthetic-refresh',
    scope: scopes(alternate), secret, requiredScopes: [CLASSROOM_SCOPE] });
  const row = db.tables.google_authorizations[0];
  assert.equal(row.scope, scopes(alternate));
  const service = createCoursesService({ config, supabase: db.client,
    fetchImpl: async () => { assert.fail('Task scope must fail before refresh'); } });
  await assert.rejects(service.readForWorker({ userId: row.user_id, googleId: row.google_id }, { sync: true }), { status: 403 });
});
