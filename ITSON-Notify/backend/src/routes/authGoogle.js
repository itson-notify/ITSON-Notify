// ITN-41 - Inicio de OAuth, callback y estado de autorización de Classroom.
const express = require("express");
const crypto = require("crypto");
const { encrypt, decrypt } = require("../utils/secureToken");
const {
  createPkcePair, generateAuthUrl, exchangeCodeForTokens,
  verifyGoogleIdToken, saveGoogleAuthorization,
} = require("../services/googleAuthService");

const STATE_COOKIE = "itn41_google_state";
const SESSION_COOKIE = "itn41_google_session";
const STATE_TTL_MS = 10 * 60 * 1000;
const SESSION_TTL_MS = 24 * 60 * 60 * 1000;

const sessionHash = id => crypto.createHash("sha256").update(id).digest("hex");

async function getGoogleSession(req, { config, supabase, now = Date.now }) {
  const secret = config?.googleAuthSecret;
  if (!secret || secret.length < 32) return null;
  const session = decrypt(cookieValue(req, SESSION_COOKIE), secret, "google-session");
  if (!session || !Number.isFinite(session.exp) || session.exp <= now() ||
      !session.userId || !session.googleId || typeof session.sessionId !== "string") return null;
  const { data, error } = await supabase.from("google_app_sessions")
    .select("user_id, google_id, expires_at").eq("id", sessionHash(session.sessionId)).maybeSingle();
  if (error) throw error;
  return data && data.user_id === session.userId && data.google_id === session.googleId &&
    Date.parse(data.expires_at) > now() ? session : null;
}

function authGoogleRouter({ config, supabase, logger = console, fetchImpl = fetch, now = Date.now }) {
  const router = express.Router();
  const oauth = config.googleOAuth || {};
  const secret = config.googleAuthSecret;
  const secure = new URL(oauth.redirectUri || "http://localhost:3000/auth/google/callback").protocol === "https:";
  const frontend = new URL(config.frontendUrl || "http://localhost:5173");
  const baseCookieOptions = { httpOnly: true, secure, sameSite: config.googleCookieSameSite || "lax" };
  const stateCookieOptions = { ...baseCookieOptions, path: "/auth/google" };
  const sessionCookieOptions = { ...baseCookieOptions, path: "/" };

  // Las respuestas de sesión y los redirects no se deben almacenar en cachés.
  router.use((req, res, next) => {
    res.setHeader("Cache-Control", "no-store");
    res.setHeader("Referrer-Policy", "no-referrer");
    next();
  });

  // Solo valores elegidos por el servidor; nunca redirigir a una URL arbitraria.
  function returnToFrontend(status, from = "onboarding") {
    const url = new URL(frontend);
    url.searchParams.set("classroom", status);
    url.searchParams.set("from", from);
    return url.toString();
  }

  async function currentSession(req) {
    return getGoogleSession(req, { config, supabase, now });
  }

  router.get("/", (req, res) => {
    if (!oauth.enabled || !oauth.clientId || !oauth.clientSecret || !secret || secret.length < 32) {
      return res.status(503).json({ error: "google_oauth_no_configurado" });
    }
    const { verifier, challenge } = createPkcePair();
    const state = crypto.randomBytes(24).toString("base64url");
    const from = req.query.from === "settings" ? "settings" : "onboarding";
    const pending = encrypt({ state, verifier, from, exp: now() + STATE_TTL_MS }, secret, "google-state");
    res.cookie(STATE_COOKIE, pending, { ...stateCookieOptions, maxAge: STATE_TTL_MS });
    res.redirect(generateAuthUrl({ clientId: oauth.clientId, redirectUri: oauth.redirectUri, state, challenge, scopes: oauth.scopes }));
  });

  router.get("/callback", async (req, res) => {
    const pending = decrypt(cookieValue(req, STATE_COOKIE), secret, "google-state");
    res.clearCookie(STATE_COOKIE, stateCookieOptions);
    if (!pending || !pending.state || !Number.isFinite(pending.exp) || pending.exp <= now() || req.query.state !== pending.state) {
      return res.status(400).json({ error: "oauth_state_invalido" });
    }
    if (req.query.error) return res.redirect(returnToFrontend("error", pending.from));
    if (typeof req.query.code !== "string") return res.status(400).json({ error: "oauth_code_invalido" });

    try {
      const tokens = await exchangeCodeForTokens({
        code: req.query.code, clientId: oauth.clientId,
        clientSecret: oauth.clientSecret, redirectUri: oauth.redirectUri,
        verifier: pending.verifier, fetchImpl,
      });
      const identity = await verifyGoogleIdToken(tokens.id_token, {
        clientId: oauth.clientId, nonce: pending.state, fetchImpl, now: now(),
      });
      const { userId, googleId } = await saveGoogleAuthorization({
        supabase, ...identity, refreshToken: tokens.refresh_token,
        scope: tokens.scope, secret,
      });
      // La sesión va en cookie HttpOnly, nunca en query strings ni localStorage.
      const sessionId = crypto.randomBytes(32).toString("base64url");
      const exp = now() + SESSION_TTL_MS;
      const { error: sessionError } = await supabase.from("google_app_sessions").insert({
        id: sessionHash(sessionId), user_id: userId, google_id: googleId,
        expires_at: new Date(exp).toISOString(),
      });
      if (sessionError) throw sessionError;
      const session = encrypt({ userId, googleId, sessionId, exp }, secret, "google-session");
      res.cookie(SESSION_COOKIE, session, { ...sessionCookieOptions, maxAge: SESSION_TTL_MS });
      logger.info("google_classroom_autorizado", { user_id: userId });
      return res.redirect(returnToFrontend("auth_success", pending.from));
    } catch (error) {
      logger.warn("google_classroom_autorizacion_fallida", { error_code: error.code || "oauth_failed" });
      return res.redirect(returnToFrontend("error", pending.from));
    }
  });

  router.get("/session", async (req, res) => {
    try {
      const session = await currentSession(req);
      if (!session) return res.status(401).json({ error: "no_autenticado" });
      const { data, error } = await supabase.from("google_authorizations")
        .select("email, google_id").eq("user_id", session.userId).maybeSingle();
      if (error) throw error;
      return res.json(data && data.google_id === session.googleId
        ? { connected: true, email: data.email } : { connected: false });
    } catch {
      return res.status(500).json({ error: "error_interno" });
    }
  });

  // El botón «Desconectar» borra solo la autorización de Classroom, sin
  // desactivar las suscripciones Web Push de calificaciones ni de otros dispositivos.
  router.delete("/session", async (req, res) => {
    if (req.get("origin") !== frontend.origin) return res.status(403).json({ error: "origen_no_permitido" });
    try {
      const session = await currentSession(req);
      if (!session) return res.status(401).json({ error: "no_autenticado" });
      const { error } = await supabase.from("google_authorizations")
        .delete().eq("user_id", session.userId).eq("google_id", session.googleId);
      if (error) throw error;
      const { error: sessionsError } = await supabase.from("google_app_sessions")
        .delete().eq("user_id", session.userId).eq("google_id", session.googleId);
      if (sessionsError) throw sessionsError;
      res.clearCookie(SESSION_COOKIE, sessionCookieOptions);
      return res.sendStatus(204);
    } catch {
      return res.status(500).json({ error: "error_interno" });
    }
  });

  // Cierre real de sesión en este dispositivo: invalida únicamente la sesión
  // actual y revoca solo la suscripción Push vinculada a esta sesión (o endpoint
  // indicado), conservando intactas las suscripciones de otros dispositivos del alumno.
  router.post("/logout", express.json({ limit: "16kb" }), async (req, res) => {
    if (req.get("origin") !== frontend.origin) return res.status(403).json({ error: "origen_no_permitido" });
    try {
      const session = await currentSession(req);
      if (session) {
        const currentSessionHash = sessionHash(session.sessionId);
        const { error } = await supabase.from("google_app_sessions").delete()
          .eq("id", currentSessionHash).eq("user_id", session.userId);
        if (error) throw error;

        const { error: pushSessionError } = await supabase.from("push_subscriptions")
          .delete().eq("user_id", session.userId).eq("session_id", currentSessionHash);
        if (pushSessionError) {
          if (pushSessionError.code !== "42P01") throw pushSessionError;
          logger.warn("push_cleanup_table_missing", { error_code: "42P01" });
        }

        const bodyEndpoint = typeof req.body?.endpoint === "string" ? req.body.endpoint.trim() : "";
        if (bodyEndpoint) {
          const { error: pushEndpointError } = await supabase.from("push_subscriptions")
            .delete().eq("user_id", session.userId).eq("endpoint", bodyEndpoint);
          if (pushEndpointError) {
            if (pushEndpointError.code !== "42P01") throw pushEndpointError;
            logger.warn("push_cleanup_table_missing", { error_code: "42P01" });
          }
        }
      }
      res.clearCookie(SESSION_COOKIE, sessionCookieOptions);
      res.clearCookie(STATE_COOKIE, stateCookieOptions);
      return res.sendStatus(204);
    } catch {
      return res.status(500).json({ error: "error_interno" });
    }
  });

  return router;
}

// Express no instala cookie-parser; basta leer las dos cookies propias.
function cookieValue(req, name) {
  const item = (req.headers.cookie || "").split(";").map(value => value.trim())
    .find(value => value.startsWith(`${name}=`));
  return item ? item.slice(name.length + 1) : null;
}

module.exports = { authGoogleRouter, getGoogleSession, sessionHash, SESSION_COOKIE };
