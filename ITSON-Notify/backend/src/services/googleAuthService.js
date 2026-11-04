// ITN-41 - OAuth de Google y persistencia de la autorización de Classroom.
// La sesión y el estado OAuth utilizan el cifrado compartido de utils/secureToken.
const crypto = require("crypto");
const { encrypt } = require("../utils/secureToken");

const GOOGLE_AUTH_URL = "https://accounts.google.com/o/oauth2/v2/auth";
const GOOGLE_TOKEN_URL = "https://oauth2.googleapis.com/token";
const GOOGLE_JWKS_URL = "https://www.googleapis.com/oauth2/v3/certs";
const CLASSROOM_SCOPE = "https://www.googleapis.com/auth/classroom.courses.readonly";

function createPkcePair() {
  const verifier = crypto.randomBytes(32).toString("base64url");
  const challenge = crypto.createHash("sha256").update(verifier).digest("base64url");
  return { verifier, challenge };
}

function generateAuthUrl({ clientId, redirectUri, state, challenge, scopes = [CLASSROOM_SCOPE] }) {
  const params = new URLSearchParams({
    client_id: clientId,
    redirect_uri: redirectUri,
    response_type: "code",
    scope: ["openid", "email", "profile", ...scopes].join(" "),
    access_type: "offline",
    prompt: "consent",
    code_challenge: challenge,
    code_challenge_method: "S256",
    state,
    nonce: state,
  });
  return `${GOOGLE_AUTH_URL}?${params}`;
}

async function exchangeCodeForTokens({ code, clientId, clientSecret, redirectUri, verifier, fetchImpl = fetch }) {
  const body = new URLSearchParams({
    code, client_id: clientId, client_secret: clientSecret,
    redirect_uri: redirectUri, code_verifier: verifier, grant_type: "authorization_code",
  });
  const response = await fetchImpl(GOOGLE_TOKEN_URL, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: body.toString(),
  });
  // No incluir el cuerpo de error: Google puede devolver detalles sensibles.
  if (!response.ok) throw new Error("google_token_exchange_failed");
  const tokens = await response.json();
  if (!tokens.id_token || !tokens.access_token) throw new Error("google_token_response_incomplete");
  return tokens;
}

// Verifica la FIRMA del JWT usando las claves públicas oficiales de Google.
// Comprobar solo iss/aud/exp tras decodificar base64 NO autentica al alumno.
async function verifyGoogleIdToken(idToken, { clientId, nonce, fetchImpl = fetch, now = Date.now() }) {
  if (typeof idToken !== "string") throw new Error("google_id_token_invalid");
  const parts = idToken.split(".");
  if (parts.length !== 3) throw new Error("google_jwt_format_invalid");

  let header, payload;
  try {
    header = JSON.parse(Buffer.from(parts[0], "base64url").toString("utf8"));
    payload = JSON.parse(Buffer.from(parts[1], "base64url").toString("utf8"));
  } catch {
    throw new Error("google_jwt_format_invalid");
  }
  if (header.alg !== "RS256" || !header.kid) throw new Error("google_jwt_algorithm_invalid");

  const response = await fetchImpl(GOOGLE_JWKS_URL);
  if (!response.ok) throw new Error("google_public_keys_unavailable");
  const jwks = await response.json();
  const jwk = jwks.keys?.find(key =>
    key.kid === header.kid && key.kty === "RSA" &&
    (!key.use || key.use === "sig") && (!key.alg || key.alg === "RS256"));
  if (!jwk) throw new Error("google_signing_key_not_found");

  let signatureValid = false;
  try {
    signatureValid = crypto.verify(
      "RSA-SHA256", Buffer.from(`${parts[0]}.${parts[1]}`),
      crypto.createPublicKey({ key: jwk, format: "jwk" }), Buffer.from(parts[2], "base64url"),
    );
  } catch {
    throw new Error("google_jwt_signature_invalid");
  }
  if (!signatureValid) throw new Error("google_jwt_signature_invalid");

  const validIssuer = payload.iss === "accounts.google.com" || payload.iss === "https://accounts.google.com";
  const currentSeconds = Math.floor(now / 1000);
  if (!validIssuer || payload.aud !== clientId || !Number.isFinite(payload.exp) ||
      payload.exp <= currentSeconds || payload.nonce !== nonce ||
      typeof payload.sub !== "string" || !payload.sub ||
      typeof payload.email !== "string" || !payload.email || payload.email_verified !== true) {
    throw new Error("google_jwt_claims_invalid");
  }
  if (payload.iat && payload.iat > currentSeconds + 60) throw new Error("google_jwt_iat_invalid");
  // Google solo es autoridad del correo en Gmail o Workspace (claim hd).
  // Un email externo con email_verified puede cambiar de propietario.
  const domain = payload.email.split("@")[1]?.toLowerCase();
  const authoritativeEmail = domain === "gmail.com" ||
    (typeof payload.hd === "string" && payload.hd.length > 0);
  return { googleId: payload.sub, email: payload.email, name: payload.name || "", authoritativeEmail };
}

// Conserva el refresh token anterior cuando Google no envía uno nuevo.
// Nunca persiste el access token: ITN-42 podrá obtener uno con el refresh token.
async function saveGoogleAuthorization({ supabase, googleId, email, name, authoritativeEmail, refreshToken, scope, secret }) {
  if (!scope?.split(" ").includes(CLASSROOM_SCOPE)) throw new Error("classroom_scope_not_granted");

  const { data: existing, error: lookupError } = await supabase
    .from("google_authorizations").select("user_id").eq("google_id", googleId).maybeSingle();
  if (lookupError) throw lookupError;
  if (!existing && !refreshToken) throw new Error("google_refresh_token_missing");

  let userId = existing?.user_id;
  if (!userId) {
    // El email procede de un ID token firmado y verificado por Google.
    const { data: user, error } = await supabase.from("app_users")
      .select("id").eq("email", email).maybeSingle();
    if (error) throw error;
    if (user) {
      // No vincular a un usuario existente con un correo que Google no controla.
      // Para cuentas externas hay que verificar la identidad por otro método.
      if (!authoritativeEmail) throw new Error("google_email_link_requires_verification");
      userId = user.id;
    } else {
      const { data: created, error: insertError } = await supabase.from("app_users")
        .insert({ email, full_name: name || null }).select("id").single();
      if (insertError) throw insertError;
      userId = created.id;
    }
  }

  // UPDATE separado: un reconsentimiento sin refresh_token no debe borrar
  // el token anterior (upsert de campos omitidos podría ponerlo en NULL).
  const row = { email, scope, updated_at: new Date().toISOString() };
  if (refreshToken) row.refresh_token = encrypt({ token: refreshToken }, secret, "google-refresh");
  const query = existing
    ? supabase.from("google_authorizations").update(row).eq("google_id", googleId)
    : supabase.from("google_authorizations").insert({
        ...row, user_id: userId, google_id: googleId,
      });
  const { error: saveError } = await query;
  if (saveError) throw saveError;
  return { userId, googleId };
}

module.exports = {
  CLASSROOM_SCOPE, createPkcePair, generateAuthUrl, exchangeCodeForTokens,
  verifyGoogleIdToken, saveGoogleAuthorization,
};
