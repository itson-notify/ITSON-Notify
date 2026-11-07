// ITN-41 - Rutas OAuth: cookie HttpOnly, state y sesión verificada.
// Las pruebas originales usaban stateStore y session_token en la URL; fueron
// reemplazados por cookies autenticadas para no exponer credenciales.
const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const express = require('express');
const request = require('supertest');
const { authGoogleRouter } = require('../../src/routes/authGoogle');
const { CLASSROOM_SCOPE } = require('../../src/services/googleAuthService');
const { encrypt, decrypt } = require('../../src/utils/secureToken');

const SECRET = 'clave-de-pruebas-google-'.repeat(3);
const frontend = 'http://localhost:5173';
const config = {
  googleOAuth: { enabled: true, clientId: 'test-client', clientSecret: 'test-secret',
    redirectUri: 'http://localhost:3000/auth/google/callback', scopes: [CLASSROOM_SCOPE] },
  googleAuthSecret: SECRET,
  frontendUrl: frontend,
};
const logger = { info() {}, warn() {}, error() {} };
const b64 = data => Buffer.from(JSON.stringify(data)).toString('base64url');
const testSessionHash = crypto.createHash('sha256').update('test-session').digest('hex');

function makeDb() {
  const users = new Map();
  const grants = new Map();
  const sessions = new Map([[testSessionHash, {
    user_id: 'u1', google_id: 'g1', expires_at: new Date(Date.now() + 60000).toISOString(),
  }]]);
  const pushSubscriptions = new Map();
  let next = 0;
  let deletions = 0;
  return {
    users, grants, sessions, pushSubscriptions, get deletions() { return deletions; },
    from(table) {
      if (table === 'google_app_sessions') return {
        select() { return { eq(field, value) { return { async maybeSingle() {
          return { data: sessions.get(value) || null, error: null };
        } }; } }; },
        async insert(row) { sessions.set(row.id, { ...row }); return { error: null }; },
        delete() {
          const filters = {};
          const query = {
            eq(key, value) { filters[key] = value; return query; },
            then(resolve, reject) {
              for (const [id, row] of sessions) {
                if (Object.entries(filters).every(([key, value]) => (key === 'id' ? id : row[key]) === value)) sessions.delete(id);
              }
              return Promise.resolve({ error: null }).then(resolve, reject);
            },
          };
          return query;
        },
      };
      if (table === 'push_subscriptions') return {
        delete() {
          const filters = {};
          const query = {
            eq(key, value) { filters[key] = value; return query; },
            then(resolve, reject) {
              for (const [endpoint, row] of pushSubscriptions) {
                if (Object.entries(filters).every(([key, value]) => row[key] === value)) pushSubscriptions.delete(endpoint);
              }
              return Promise.resolve({ error: null }).then(resolve, reject);
            },
          };
          return query;
        },
      };
      if (table === 'app_users') return {
        select() { return { eq(field, value) { return { async maybeSingle() {
          return { data: users.get(value) || null, error: null };
        } }; } }; },
        insert(value) { return { select() { return { async single() {
          const user = { ...value, id: `u${++next}` };
          users.set(user.email, user);
          return { data: user, error: null };
        } }; } }; },
      };
      if (table === 'google_authorizations') return {
        select() { return { eq(field, value) { return { async maybeSingle() {
          let row = null;
          if (field === 'google_id') row = grants.get(value) || null;
          if (field === 'user_id') row = [...grants.values()].find(item => item.user_id === value) || null;
          return { data: row, error: null };
        } }; } }; },
        async insert(row) { grants.set(row.google_id, { ...row }); return { error: null }; },
        update(row) { return { async eq(field, value) {
          const previous = grants.get(value);
          if (!previous) return { error: new Error('fila no encontrada') };
          grants.set(value, { ...previous, ...row });
          return { error: null };
        } }; },
        delete() {
          const filters = {};
          const query = {
            eq(key, value) { filters[key] = value; return query; },
            then(resolve, reject) {
              const row = [...grants.values()].find(item => item.user_id === filters.user_id && item.google_id === filters.google_id);
              if (row) { grants.delete(row.google_id); deletions++; }
              return Promise.resolve({ error: null }).then(resolve, reject);
            },
          };
          return query;
        },
      };
      throw new Error(`Tabla inesperada: ${table}`);
    },
  };
}

function appFor({ db = makeDb(), cfg = config, fetchImpl = async () => { throw new Error('No debería consultar Google'); }, now = Date.now } = {}) {
  const app = express();
  app.use('/auth/google', authGoogleRouter({ config: cfg, supabase: db, logger, fetchImpl, now }));
  return { app, db };
}

function sessionCookie({ userId = 'u1', googleId = 'g1', exp = Date.now() + 60000 } = {}) {
  return `itn41_google_session=${encrypt({ userId, googleId, exp, sessionId: 'test-session' }, SECRET, 'google-session')}`;
}

describe('Rutas /auth/google', () => {
  it('rechaza empezar OAuth si falta configuración real', async () => {
    const { app } = appFor({ cfg: { ...config, googleOAuth: { ...config.googleOAuth, clientId: '' } } });
    const res = await request(app).get('/auth/google');
    assert.equal(res.status, 503);
    assert.equal(res.body.error, 'google_oauth_no_configurado');
  });
  it('redirige a Google, genera state por petición y guarda PKCE en cookie HttpOnly', async () => {
    const { app } = appFor();
    const first = await request(app).get('/auth/google');
    const second = await request(app).get('/auth/google');
    assert.equal(first.status, 302);
    const url = new URL(first.headers.location);
    assert.equal(url.hostname, 'accounts.google.com');
    assert.ok(url.searchParams.get('state'));
    assert.equal(url.searchParams.get('code_challenge_method'), 'S256');
    assert.notEqual(url.searchParams.get('state'), new URL(second.headers.location).searchParams.get('state'));
    assert.match(first.headers['set-cookie'].join(';'), /itn41_google_state=/);
    assert.match(first.headers['set-cookie'].join(';'), /HttpOnly/i);
  });
  it('rechaza callback sin cookie de state válida', async () => {
    const { app } = appFor();
    const res = await request(app).get('/auth/google/callback?state=inventado&code=codigo');
    assert.equal(res.status, 400);
    assert.equal(res.body.error, 'oauth_state_invalido');
  });
  it('redirige el rechazo de consentimiento sin completar ninguna autorización', async () => {
    const { app, db } = appFor();
    const agent = request.agent(app);
    const start = await agent.get('/auth/google?from=settings');
    const state = new URL(start.headers.location).searchParams.get('state');
    const callback = await agent.get(`/auth/google/callback?error=access_denied&state=${encodeURIComponent(state)}`);
    assert.equal(callback.status, 302);
    const returnUrl = new URL(callback.headers.location);
    assert.equal(returnUrl.searchParams.get('classroom'), 'error');
    assert.equal(returnUrl.searchParams.get('from'), 'settings');
    assert.equal(db.grants.size, 0);
  });
  it('rechaza /session sin cookie válida o con sesión caducada', async () => {
    const { app } = appFor();
    const none = await request(app).get('/auth/google/session');
    const expired = await request(app).get('/auth/google/session').set('Cookie', sessionCookie({ exp: Date.now() - 1000 }));
    assert.equal(none.status, 401);
    assert.equal(expired.status, 401);
  });
  it('solo muestra conectado si existe autorización del usuario y google_id correspondientes', async () => {
    const db = makeDb();
    db.grants.set('g1', { google_id: 'g1', user_id: 'u1', email: 'alumno@gmail.com' });
    const { app } = appFor({ db });
    const ok = await request(app).get('/auth/google/session').set('Cookie', sessionCookie());
    const mismatch = await request(app).get('/auth/google/session').set('Cookie', sessionCookie({ googleId: 'otro' }));
    assert.equal(ok.status, 200);
    assert.deepEqual(ok.body, { connected: true, email: 'alumno@gmail.com' });
    assert.equal(mismatch.status, 401);
    assert.equal(JSON.stringify(ok.body).includes('refresh_token'), false);
  });
  it('rechaza desconexión desde otro origen sin borrar autorizaciones', async () => {
    const db = makeDb();
    db.grants.set('g1', { google_id: 'g1', user_id: 'u1', email: 'a@gmail.com' });
    const { app } = appFor({ db });
    const res = await request(app).delete('/auth/google/session')
      .set('Origin', 'https://otro-sitio.test').set('Cookie', sessionCookie());
    assert.equal(res.status, 403);
    assert.equal(db.grants.size, 1);
  });
  it('elimina la autorización al desconectar Classroom sin desactivar suscripciones Push', async () => {
    const db = makeDb();
    db.grants.set('g1', { google_id: 'g1', user_id: 'u1', email: 'a@gmail.com' });
    db.pushSubscriptions.set('https://fcm.test/telefono', {
      user_id: 'u1', session_id: 'otra-sesion', endpoint: 'https://fcm.test/telefono',
    });
    const { app } = appFor({ db });
    const res = await request(app).delete('/auth/google/session')
      .set('Origin', frontend).set('Cookie', sessionCookie());
    assert.equal(res.status, 204);
    assert.equal(db.grants.size, 0);
    assert.equal(db.deletions, 1);
    assert.equal(db.pushSubscriptions.size, 1);
    assert.match(res.headers['set-cookie'].join(';'), /itn41_google_session=/);
  });
  it('completa OAuth con ID token firmado y almacena refresh token cifrado', async () => {
    const { privateKey, publicKey } = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
    const jwk = { ...publicKey.export({ format: 'jwk' }), kid: 'kid-ruta', use: 'sig', alg: 'RS256' };
    let idToken;
    let exchangeBody;
    const fetchImpl = async (url, options) => {
      if (url === 'https://oauth2.googleapis.com/token') {
        exchangeBody = new URLSearchParams(options.body);
        return { ok: true, json: async () => ({ id_token: idToken, access_token: 'access', refresh_token: 'refresh-secreto', scope: CLASSROOM_SCOPE }) };
      }
      if (url === 'https://www.googleapis.com/oauth2/v3/certs') {
        return { ok: true, json: async () => ({ keys: [jwk] }) };
      }
      throw new Error('URL Google no esperada');
    };
    const db = makeDb();
    const { app } = appFor({ db, fetchImpl });
    const agent = request.agent(app);
    const started = await agent.get('/auth/google');
    const params = new URL(started.headers.location).searchParams;
    const nonce = params.get('state');
    const seconds = Math.floor(Date.now() / 1000);
    const claims = {
      iss: 'https://accounts.google.com', aud: 'test-client', sub: 'google-id',
      email: 'alumno@gmail.com', email_verified: true, nonce,
      iat: seconds - 5, exp: seconds + 3600,
    };
    const signed = `${b64({ alg: 'RS256', kid: 'kid-ruta' })}.${b64(claims)}`;
    idToken = `${signed}.${crypto.sign('RSA-SHA256', Buffer.from(signed), privateKey).toString('base64url')}`;
    const callback = await agent.get(`/auth/google/callback?code=code&state=${encodeURIComponent(nonce)}`);
    assert.equal(callback.status, 302);
    const returned = new URL(callback.headers.location);
    assert.equal(returned.searchParams.get('classroom'), 'auth_success');
    assert.equal(returned.searchParams.has('session_token'), false);
    assert.ok(exchangeBody.get('code_verifier'));
    assert.equal(crypto.createHash('sha256').update(exchangeBody.get('code_verifier')).digest('base64url'), params.get('code_challenge'));
    assert.equal(db.grants.size, 1);
    const row = db.grants.get('google-id');
    assert.deepEqual(decrypt(row.refresh_token, SECRET, 'google-refresh'), { token: 'refresh-secreto' });
    const session = await agent.get('/auth/google/session');
    assert.equal(session.status, 200);
    assert.deepEqual(session.body, { connected: true, email: 'alumno@gmail.com' });
  });
});


describe('ITN-41 - integración con ITN-40 y sesiones revocables', () => {
  const { loadConfig } = require('../../src/config/env');
  const { createApp } = require('../../src/app');
  const baseEnv = {
    PORT: '3000', INTERNAL_API_KEY: 'interna-de-pruebas-'.repeat(3),
    SUPABASE_URL: 'https://supabase.test', SUPABASE_SERVICE_ROLE_KEY: 'rol-sintetico',
    CREDENTIALS_ENCRYPTION_KEY: crypto.randomBytes(32).toString('base64'),
    GOOGLE_OAUTH_ENABLED: 'true', GOOGLE_CLIENT_ID: 'test-client', GOOGLE_CLIENT_SECRET: 'test-secret',
    GOOGLE_REDIRECT_URI: config.googleOAuth.redirectUri, GOOGLE_OAUTH_SCOPES: CLASSROOM_SCOPE,
    GOOGLE_AUTH_SECRET: SECRET, FRONTEND_URL: frontend,
  };
  it('carga ITN-40 sin duplicados y conecta las rutas reales de la aplicación', async () => {
    const cfg = loadConfig(baseEnv);
    assert.equal(cfg.googleClientId, undefined);
    assert.equal(cfg.googleRedirectUri, undefined);
    assert.equal(cfg.googleOAuth.clientSecret, 'test-secret');
    assert.ok(!JSON.stringify(cfg).includes('test-secret'));
    assert.ok(!JSON.stringify(cfg).includes(SECRET));
    const app = createApp({ config: cfg, supabase: makeDb(), logger });
    const start = await request(app).get('/auth/google');
    assert.equal(start.status, 302);
    const url = new URL(start.headers.location);
    assert.equal(url.searchParams.get('client_id'), cfg.googleOAuth.clientId);
    assert.equal(url.searchParams.get('redirect_uri'), cfg.googleOAuth.redirectUri);
    assert.equal(url.searchParams.get('scope'), `openid email profile ${CLASSROOM_SCOPE}`);
    const preflight = await request(app).options('/auth/google/logout').set('Origin', frontend);
    assert.equal(preflight.status, 204);
    assert.equal(preflight.headers['access-control-allow-origin'], frontend);
    assert.equal(preflight.headers['access-control-allow-credentials'], 'true');
    assert.match(preflight.headers['access-control-allow-methods'], /POST/);
    const logout = await request(app).post('/auth/google/logout').set('Origin', frontend);
    assert.equal(logout.status, 204);
  });
  it('respeta GOOGLE_OAUTH_ENABLED=false aunque existan credenciales', async () => {
    const cfg = loadConfig({ ...baseEnv, GOOGLE_OAUTH_ENABLED: 'false' });
    const { app } = appFor({ cfg });
    assert.equal((await request(app).get('/auth/google')).status, 503);
  });
  it('rechaza configuración insegura sin revelar valores', () => {
    for (const bad of [
      { FRONTEND_URL: 'javascript:alert(1)' },
      { FRONTEND_URL: 'https://usuario:clave@frontend.test' },
      { FRONTEND_URL: 'https://frontend.test/#fragmento' },
      { GOOGLE_COOKIE_SAME_SITE: 'strict' },
      { GOOGLE_COOKIE_SAME_SITE: 'none' },
      { GOOGLE_AUTH_SECRET: 'corta' },
    ]) assert.throws(() => loadConfig({ ...baseEnv, ...bad }), /Variables de entorno inválidas/);
  });
  it('emite cookies HTTPS para sitios distintos y vuelve a la URL configurada', async () => {
    const cfg = loadConfig({ ...baseEnv, FRONTEND_URL: 'https://frontend.test/app',
      GOOGLE_REDIRECT_URI: 'https://backend.test/auth/google/callback', GOOGLE_COOKIE_SAME_SITE: 'none' });
    const { app } = appFor({ cfg });
    const start = await request(app).get('/auth/google?from=settings');
    const cookie = start.headers['set-cookie'][0];
    assert.match(cookie, /Secure/); assert.match(cookie, /HttpOnly/); assert.match(cookie, /SameSite=None/);
    assert.doesNotMatch(cookie, /Domain=/);
    const state = new URL(start.headers.location).searchParams.get('state');
    const result = await request(app).get(`/auth/google/callback?error=access_denied&state=${state}`)
      .set('Cookie', cookie.split(';')[0]);
    const returned = new URL(result.headers.location);
    assert.equal(returned.origin, 'https://frontend.test');
    assert.equal(returned.pathname, '/app');
    assert.equal(returned.searchParams.get('from'), 'settings');
    assert.equal(result.headers['cache-control'], 'no-store');
  });
  it('rechaza state alterado o caducado sin contactar a Google', async () => {
    const { app } = appFor();
    for (const pending of [
      { state: 'original', verifier: 'v', exp: Date.now() + 60000 },
      { state: 'otro', verifier: 'v', exp: Date.now() - 1 },
      { state: 'otro', verifier: 'v' },
    ]) {
      const cookie = encrypt(pending, SECRET, 'google-state');
      const result = await request(app).get('/auth/google/callback?state=otro&code=c')
        .set('Cookie', `itn41_google_state=${cookie}`);
      assert.equal(result.status, 400);
    }
  });
  it('logout invalida la cookie copiada en otra instancia, elimina solo el Push de esa sesión y conserva otros dispositivos', async () => {
    const db = makeDb();
    db.grants.set('g1', { user_id: 'u1', google_id: 'g1', email: 'alumno@gmail.com', refresh_token: 'cifrado' });
    db.pushSubscriptions.set('https://fcm.test/laptop', {
      user_id: 'u1', session_id: testSessionHash, endpoint: 'https://fcm.test/laptop',
    });
    db.pushSubscriptions.set('https://fcm.test/telefono', {
      user_id: 'u1', session_id: 'sesion-telefono', endpoint: 'https://fcm.test/telefono',
    });
    const first = appFor({ db }).app;
    const second = appFor({ db }).app;
    const cookie = sessionCookie();
    assert.equal((await request(first).get('/auth/google/session').set('Cookie', cookie)).status, 200);
    const logout = await request(first).post('/auth/google/logout').set('Origin', frontend).set('Cookie', cookie);
    assert.equal(logout.status, 204);
    assert.equal(db.grants.size, 1);
    assert.equal(db.grants.get('g1').refresh_token, 'cifrado');
    assert.equal(db.sessions.size, 0);
    assert.equal(db.pushSubscriptions.size, 1);
    assert.equal(db.pushSubscriptions.has('https://fcm.test/telefono'), true);
    assert.match(logout.headers['set-cookie'].join(';'), /Max-Age=0|Expires=Thu, 01 Jan 1970/);
    assert.equal((await request(second).get('/auth/google/session').set('Cookie', cookie)).status, 401);
    assert.equal((await request(first).post('/auth/google/logout').set('Origin', frontend).set('Cookie', cookie)).status, 204);
  });
  it('protege logout contra CSRF, incluido Origin ausente', async () => {
    const db = makeDb(); const { app } = appFor({ db });
    for (const origin of [null, 'https://atacante.test', 'null']) {
      const req = request(app).post('/auth/google/logout').set('Cookie', sessionCookie());
      if (origin) req.set('Origin', origin);
      assert.equal((await req).status, 403);
    }
    assert.equal(db.sessions.size, 1);
  });
  it('un fallo del intercambio de Google retorna a Configuración sin guardar permisos ni exponer secretos', async () => {
    const db = makeDb();
    const { app } = appFor({ db, fetchImpl: async () => ({ ok: false, json: async () => ({ error: 'detalle sensible' }) }) });
    const agent = request.agent(app);
    const start = await agent.get('/auth/google?from=settings');
    const state = new URL(start.headers.location).searchParams.get('state');
    const callback = await agent.get(`/auth/google/callback?code=c&state=${state}`);
    assert.equal(callback.status, 302);
    const returned = new URL(callback.headers.location);
    assert.equal(returned.searchParams.get('from'), 'settings');
    assert.equal(returned.searchParams.get('classroom'), 'error');
    assert.equal(db.grants.size, 0);
    assert.equal(callback.headers.location.includes('sensible'), false);
  });
  it('la sesión falla cerrada si la persistencia no está disponible', async () => {
    const db = { from() { throw new Error('detalle privado de base de datos'); } };
    const { app } = appFor({ db });
    for (const method of ['get', 'delete', 'post']) {
      const path = method === 'post' ? '/auth/google/logout' : '/auth/google/session';
      const res = await request(app)[method](path).set('Origin', frontend).set('Cookie', sessionCookie());
      assert.equal(res.status, 500);
      assert.deepEqual(res.body, { error: 'error_interno' });
    }
  });
});
