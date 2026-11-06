// ITN-41 - Pruebas del contrato actual: OAuth seguro y autorización persistente.
// La implementación anterior comprobaba JWT sin verificar su firma; esa prueba
// ya no representa una autenticación válida. Aquí se usan firmas RSA reales.
const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const {
  CLASSROOM_SCOPE, createPkcePair, generateAuthUrl, exchangeCodeForTokens,
  verifyGoogleIdToken, saveGoogleAuthorization,
} = require('../../src/services/googleAuthService');
const { encrypt, decrypt } = require('../../src/utils/secureToken');

const SECRET = 'prueba-local-itn41-'.repeat(4);
const now = Date.now();
const epoch = Math.floor(now / 1000);
const { privateKey, publicKey } = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
const publicJwk = { ...publicKey.export({ format: 'jwk' }), kid: 'kid-itn41', use: 'sig', alg: 'RS256' };
const jwksFetch = async () => ({ ok: true, json: async () => ({ keys: [publicJwk] }) });
const b64 = value => Buffer.from(JSON.stringify(value)).toString('base64url');

function signGoogle(claims = {}, header = {}) {
  const payload = {
    iss: 'https://accounts.google.com', aud: 'test-client', sub: 'google-123',
    email: 'alumno@gmail.com', email_verified: true, nonce: 'nonce-123',
    exp: epoch + 3600, iat: epoch - 10, ...claims,
  };
  const message = `${b64({ alg: 'RS256', kid: 'kid-itn41', ...header })}.${b64(payload)}`;
  const signature = crypto.sign('RSA-SHA256', Buffer.from(message), privateKey).toString('base64url');
  return `${message}.${signature}`;
}

function fakeDatabase(existingUsers = []) {
  const users = new Map(existingUsers.map(user => [user.email, user]));
  const authorizations = new Map();
  let nextUser = users.size;
  const calls = [];
  return {
    users, authorizations, calls,
    from(table) {
      if (table === 'app_users') return {
        select() { return { eq(column, value) { return {
          async maybeSingle() { return { data: users.get(value) || null, error: null }; },
        }; } }; },
        insert(value) { return { select() { return {
          async single() {
            const user = { id: `user-${++nextUser}`, ...value };
            users.set(user.email, user);
            calls.push({ table, operation: 'insert', value });
            return { data: user, error: null };
          },
        }; } }; },
      };
      if (table === 'google_authorizations') return {
        select() { return { eq(column, value) { return {
          async maybeSingle() { return { data: authorizations.get(value) || null, error: null }; },
        }; } }; },
        async insert(value) {
          authorizations.set(value.google_id, { ...value });
          calls.push({ table, operation: 'insert', value });
          return { error: null };
        },
        update(value) { return { async eq(column, googleId) {
          const previous = authorizations.get(googleId);
          if (!previous) return { error: new Error('fila no encontrada') };
          authorizations.set(googleId, { ...previous, ...value });
          calls.push({ table, operation: 'update', value });
          return { error: null };
        } }; },
      };
      throw new Error(`Tabla inesperada: ${table}`);
    },
  };
}

const validGrant = {
  googleId: 'google-123', email: 'alumno@gmail.com', name: 'Alumno',
  authoritativeEmail: true, refreshToken: 'refresh-token-secreto',
  scope: CLASSROOM_SCOPE, secret: SECRET,
};

describe('googleAuthService - PKCE y autorización', () => {
  it('genera el challenge SHA-256 del verifier', () => {
    const { verifier, challenge } = createPkcePair();
    assert.match(verifier, /^[\w-]{40,}$/);
    assert.equal(challenge, crypto.createHash('sha256').update(verifier).digest('base64url'));
  });
  it('genera valores PKCE diferentes por petición', () => {
    assert.notEqual(createPkcePair().verifier, createPkcePair().verifier);
  });
  it('construye el enlace OAuth con state, nonce, PKCE y lectura de Classroom', () => {
    const url = new URL(generateAuthUrl({
      clientId: 'test-client', redirectUri: 'http://localhost:3000/auth/google/callback',
      state: 'nonce-123', challenge: 'challenge-123',
    }));
    assert.equal(url.hostname, 'accounts.google.com');
    assert.equal(url.searchParams.get('client_id'), 'test-client');
    assert.equal(url.searchParams.get('state'), 'nonce-123');
    assert.equal(url.searchParams.get('nonce'), 'nonce-123');
    assert.equal(url.searchParams.get('code_challenge'), 'challenge-123');
    assert.equal(url.searchParams.get('code_challenge_method'), 'S256');
    assert.equal(url.searchParams.get('access_type'), 'offline');
    assert.ok(url.searchParams.get('scope').includes(CLASSROOM_SCOPE));
    assert.ok(!url.searchParams.get('scope').includes('classroom.coursework.students'));
  });
  it('intercambia el código con POST y code_verifier; no registra secretos', async () => {
    let request;
    const tokens = await exchangeCodeForTokens({
      code: 'code', clientId: 'client', clientSecret: 'secret', redirectUri: 'http://localhost/callback',
      verifier: 'verifier', fetchImpl: async (url, options) => {
        request = { url, options };
        return { ok: true, json: async () => ({ access_token: 'access', refresh_token: 'refresh', id_token: 'id' }) };
      },
    });
    assert.equal(tokens.refresh_token, 'refresh');
    assert.equal(request.options.method, 'POST');
    assert.equal(new URLSearchParams(request.options.body).get('code_verifier'), 'verifier');
    assert.equal(new URLSearchParams(request.options.body).get('grant_type'), 'authorization_code');
  });
  it('rechaza errores de Google y respuestas sin tokens necesarios', async () => {
    const args = { code: 'c', clientId: 'id', clientSecret: 'secret', redirectUri: 'http://localhost', verifier: 'v' };
    await assert.rejects(exchangeCodeForTokens({ ...args, fetchImpl: async () => ({ ok: false }) }), /google_token_exchange_failed/);
    await assert.rejects(exchangeCodeForTokens({ ...args, fetchImpl: async () => ({ ok: true, json: async () => ({ access_token: 'a' }) }) }), /google_token_response_incomplete/);
  });
});

describe('googleAuthService - validación de identidad Google', () => {
  const verify = (token, overrides = {}) => verifyGoogleIdToken(token, {
    clientId: 'test-client', nonce: 'nonce-123', now, fetchImpl: jwksFetch, ...overrides,
  });
  it('acepta un JWT con firma RSA auténtica y claims válidos', async () => {
    const user = await verify(signGoogle());
    assert.equal(user.googleId, 'google-123');
    assert.equal(user.email, 'alumno@gmail.com');
    assert.equal(user.authoritativeEmail, true);
  });
  it('rechaza un token con contenido alterado y firma original', async () => {
    const [header, , signature] = signGoogle().split('.');
    await assert.rejects(verify(`${header}.${b64({ sub: 'otro' })}.${signature}`), /google_jwt_signature_invalid/);
  });
  it('rechaza un token firmado pero caducado', async () => {
    await assert.rejects(verify(signGoogle({ exp: epoch - 1 })), /google_jwt_claims_invalid/);
  });
  it('rechaza audiencia incorrecta', async () => {
    await assert.rejects(verify(signGoogle({ aud: 'otro-cliente' })), /google_jwt_claims_invalid/);
  });
  it('rechaza nonce distinto y no permite reutilizar otra autorización', async () => {
    await assert.rejects(verify(signGoogle({ nonce: 'otra-peticion' })), /google_jwt_claims_invalid/);
  });
  it('rechaza JWT alg none aunque parezca contener claims correctos', async () => {
    await assert.rejects(verify(signGoogle({}, { alg: 'none' })), /google_jwt_algorithm_invalid/);
  });
  it('rechaza token sin identificador Google estable', async () => {
    await assert.rejects(verify(signGoogle({ sub: '' })), /google_jwt_claims_invalid/);
  });
  it('rechaza emisor falso, correo no verificado e identidad emitida en el futuro', async () => {
    await assert.rejects(verify(signGoogle({ iss: 'https://atacante.test' })), /google_jwt_claims_invalid/);
    await assert.rejects(verify(signGoogle({ email_verified: false })), /google_jwt_claims_invalid/);
    await assert.rejects(verify(signGoogle({ iat: epoch + 120 })), /google_jwt_iat_invalid/);
  });
  it('rechaza claves públicas ausentes o un proveedor no disponible', async () => {
    await assert.rejects(verify(signGoogle(), { fetchImpl: async () => ({ ok: false }) }), /google_public_keys_unavailable/);
    await assert.rejects(verify(signGoogle(), { fetchImpl: async () => ({ ok: true, json: async () => ({ keys: [] }) }) }), /google_signing_key_not_found/);
  });
  it('no da por verificado un correo externo sin autoridad de Google', async () => {
    const identity = await verify(signGoogle({ email: 'alumno@externo.test' }));
    assert.equal(identity.authoritativeEmail, false);
  });
});

describe('ITN-41 - cifrado y persistencia', () => {
  it('cifra y descifra exclusivamente con la clave y propósito correcto', () => {
    const ciphertext = encrypt({ token: 'secreto' }, SECRET, 'google-refresh');
    assert.ok(!ciphertext.includes('secreto'));
    assert.deepEqual(decrypt(ciphertext, SECRET, 'google-refresh'), { token: 'secreto' });
    assert.equal(decrypt(ciphertext, SECRET, 'google-session'), null);
    assert.equal(decrypt(ciphertext, 'otra-clave-'.repeat(5), 'google-refresh'), null);
  });
  it('rechaza modificación del texto cifrado', () => {
    const parts = encrypt({ token: 'x' }, SECRET, 'google-refresh').split('.');
    const tag = Buffer.from(parts[2], 'base64url'); tag[0] ^= 1;
    parts[2] = tag.toString('base64url');
    assert.equal(decrypt(parts.join('.'), SECRET, 'google-refresh'), null);
  });
  it('crea el usuario y almacena únicamente el refresh token cifrado', async () => {
    const db = fakeDatabase();
    const result = await saveGoogleAuthorization({ supabase: db, ...validGrant });
    assert.ok(result.userId);
    assert.equal(db.users.size, 1);
    const row = db.authorizations.get(validGrant.googleId);
    assert.ok(row);
    assert.ok(!row.refresh_token.includes('refresh-token-secreto'));
    assert.deepEqual(decrypt(row.refresh_token, SECRET, 'google-refresh'), { token: 'refresh-token-secreto' });
    assert.equal('access_token' in row, false);
  });
  it('reutiliza un usuario Gmail ya existente', async () => {
    const db = fakeDatabase([{ id: 'existing-user', email: validGrant.email }]);
    const result = await saveGoogleAuthorization({ supabase: db, ...validGrant });
    assert.equal(result.userId, 'existing-user');
    assert.equal(db.users.size, 1);
  });
  it('no vincula automáticamente un correo externo de un usuario anterior', async () => {
    const db = fakeDatabase([{ id: 'existing-user', email: 'alumno@externo.test' }]);
    await assert.rejects(saveGoogleAuthorization({ supabase: db, ...validGrant,
      email: 'alumno@externo.test', authoritativeEmail: false,
    }), /google_email_link_requires_verification/);
    assert.equal(db.authorizations.size, 0);
  });
  it('preserva el refresh token anterior durante reautorización sin token nuevo', async () => {
    const db = fakeDatabase();
    await saveGoogleAuthorization({ supabase: db, ...validGrant });
    const original = db.authorizations.get(validGrant.googleId).refresh_token;
    await saveGoogleAuthorization({ supabase: db, ...validGrant, refreshToken: undefined });
    assert.equal(db.authorizations.get(validGrant.googleId).refresh_token, original);
    assert.equal(db.calls.filter(call => call.table === 'app_users' && call.operation === 'insert').length, 1);
  });
  it('rechaza una autorización que no concedió Classroom', async () => {
    const db = fakeDatabase();
    await assert.rejects(saveGoogleAuthorization({ supabase: db, ...validGrant, scope: 'openid email' }), /classroom_scope_not_granted/);
    assert.equal(db.authorizations.size, 0);
  });
  it('exige refresh token al guardar la primera autorización', async () => {
    const db = fakeDatabase();
    await assert.rejects(saveGoogleAuthorization({ supabase: db, ...validGrant, refreshToken: undefined }), /google_refresh_token_missing/);
    assert.equal(db.authorizations.size, 0);
  });
});
