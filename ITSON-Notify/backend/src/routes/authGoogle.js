// ITN-41 - Inicio de OAuth, callback y estado de autorización de Classroom.
const express = require("express");
const crypto = require("crypto");
const { encrypt, decrypt } = require("../utils/secureToken");
const { SESSION_COOKIE, sessionHash, cookieValue, createSessionReader } = require("../middleware/studentSession");
const {
  createPkcePair, generateAuthUrl, exchangeCodeForTokens,
  verifyGoogleIdToken, saveGoogleAuthorization,
} = require("../services/googleAuthService");

const STATE_COOKIE = "itn41_google_state";
const STATE_TTL_MS = 10 * 60 * 1000;
const SESSION_TTL_MS = 24 * 60 * 60 * 1000;

// Envoltura de createSessionReader para quien no construye un lector propio
// (rutas /push). Sin un secreto válido no hay sesión posible.
async function getGoogleSession(req, { config, supabase, now = Date.now }) {
  const secret = config?.googleAuthSecret;
  if (!secret || secret.length < 32) return null;
  return createSessionReader({ secret, supabase, now })(req);
}

function authGoogleRouter({ config, supabase, logger = console, fetchImpl = fetch, now = Date.now }) {
  const router = express.Router();
  const oauth = config.googleOAuth || {};
  const secret = config.googleAuthSecret;
  const secure = new URL(oauth.redirectUri || "http://localhost:3000/auth/google/callback").protocol === "https:";
  const frontend = new URL(config.frontendUrl || "http://localhost:5173");
  const baseCookie = { httpOnly: true, secure, sameSite: config.googleCookieSameSite || "lax" };
  const stateCookieOptions = { ...baseCookie, path: "/auth/google" };
  // La sesión también debe viajar a /api y /push. Para borrarla hay que repetir este path.
  const sessionCookieOptions = { ...baseCookie, path: "/" };
  // Antes de ITN-53 la sesión vivía bajo /auth/google. Esa cookie se enviaría
  // primero y taparía a la nueva, así que se borra al entrar y al salir.
  const clearLegacySessionCookie = res => res.clearCookie(SESSION_COOKIE, stateCookieOptions);
  const clearSessionCookies = res => {
    res.clearCookie(SESSION_COOKIE, sessionCookieOptions);
    clearLegacySessionCookie(res);
  };
  const currentSession = req => getGoogleSession(req, { config, supabase, now });
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
      clearLegacySessionCookie(res);
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
      clearSessionCookies(res);
      return res.sendStatus(204);
    } catch {
      return res.status(500).json({ error: "error_interno" });
    }
  });

  // Limpieza Push del logout. Es secundaria: la sesión ya se invalidó, así que un
  // fallo aquí se registra (solo el código) y no impide terminar el logout.
  // Devuelve true si no quedó nada que limpiar (incluido 42P01: no hay tabla).
  async function cleanupPush(target, query) {
    try {
      const { error } = await query();
      if (!error) return true;
      if (error.code === "42P01") {
        logger.warn("push_cleanup_table_missing", { error_code: "42P01" });
        return true;
      }
      logger.warn("push_cleanup_failed", { error_code: error.code ?? null, target });
    } catch (error) {
      logger.warn("push_cleanup_failed", { error_code: error?.code ?? null, target });
    }
    return false;
  }

  // ITN-54: invalida la sesión marcándola con revoked_at (migración 011). La marca
  // es lo que permite a la purga previa al envío borrar después el Push de esta
  // sesión si su limpieza falla. Sin la 011 (42703) vuelve al borrado anterior:
  // es solo una red de seguridad, la 011 se aplica antes de desplegar.
  // Devuelve true si la sesión quedó marcada.
  async function revokeSession(id, userId) {
    const { error } = await supabase.from("google_app_sessions")
      .update({ revoked_at: new Date(now()).toISOString() })
      .eq("id", id).eq("user_id", userId);
    if (!error) return true;
    if (error.code !== "42703") throw error;
    logger.warn("session_revocation_column_missing", { error_code: "42703" });
    const { error: deleteError } = await supabase.from("google_app_sessions").delete()
      .eq("id", id).eq("user_id", userId);
    if (deleteError) throw deleteError;
    return false;
  }

  // Cierre real de sesión en este dispositivo: invalida únicamente la sesión
  // actual y revoca solo la suscripción Push vinculada a esta sesión (o endpoint
  // indicado), conservando intactas las suscripciones de otros dispositivos del alumno.
  router.post("/logout", express.json({ limit: "16kb" }), async (req, res) => {
    if (req.get("origin") !== frontend.origin) return res.status(403).json({ error: "origen_no_permitido" });
    try {
      const session = await currentSession(req);
      if (session) {
        // Obligatorio: si no se puede invalidar la sesión, el logout falla.
        const currentSessionHash = sessionHash(session.sessionId);
        const marked = await revokeSession(currentSessionHash, session.userId);

        const sessionPushClean = await cleanupPush("session", () => supabase.from("push_subscriptions")
          .delete().eq("user_id", session.userId).eq("session_id", currentSessionHash));
        // Si el Push de la sesión ya se limpió, la marca sobra: se borra la fila
        // para que la tabla quede como antes. Si falla, la purga la borra después.
        if (marked && sessionPushClean) {
          try {
            const { error } = await supabase.from("google_app_sessions").delete()
              .eq("id", currentSessionHash).eq("user_id", session.userId).not("revoked_at", "is", null);
            if (error) logger.warn("revoked_session_cleanup_failed", { error_code: error.code ?? null });
          } catch (error) {
            logger.warn("revoked_session_cleanup_failed", { error_code: error?.code ?? null });
          }
        }

        const bodyEndpoint = typeof req.body?.endpoint === "string" ? req.body.endpoint.trim() : "";
        if (bodyEndpoint) {
          await cleanupPush("endpoint", () => supabase.from("push_subscriptions")
            .delete().eq("user_id", session.userId).eq("endpoint", bodyEndpoint));
        }
      }
      clearSessionCookies(res);
      res.clearCookie(STATE_COOKIE, stateCookieOptions);
      return res.sendStatus(204);
    } catch (error) {
      logger.error("logout_fallido", { error_code: error?.code ?? null });
      return res.status(500).json({ error: "error_interno" });
    }
  });

  return router;
}

module.exports = { authGoogleRouter, getGoogleSession, sessionHash, SESSION_COOKIE };
