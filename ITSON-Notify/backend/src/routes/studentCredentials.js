// ITN-51 - /api/credentials/ivirtual: el alumno consulta, vincula y borra su propia
// cuenta de iVirtual. Se monta dentro de studentApi.js, así que antes de llegar aquí
// ya pasó la verificación de Origin (PUT y DELETE) y requireStudentSession; el body
// se parsea después, con 8 KB como máximo. El alumno sale SIEMPRE de
// req.student.userId: un id o correo en el body se descarta.
//
// La contraseña solo vive en esta petición: se entrega al puerto exchangeToken y se
// suelta al terminar. Nunca se guarda, se loguea ni se devuelve. Los logs llevan
// user_id, portal, kind y códigos, como credentials.js.
const express = require("express");
const { parseIvirtualLink, isValidSecret } = require("../models/credentialPayload");
const { createCredentialRepository } = require("../repositories/credentialRepository");
const { createCredentialService } = require("../services/credentialService");
const { CredentialNotFoundError } = require("../utils/errors");

const PORTAL = "ivirtual";
const KIND = "ivirtual_token";
const BODY_LIMIT = "8kb";

// Intentos de vinculación por alumno: cada uno es un login contra iVirtual.
const LINK_ATTEMPTS = 5;
const LINK_WINDOW_MS = 15 * 60 * 1000;

// ITN-51 - Límite en memoria por alumno. Se reinicia con el proceso y no se comparte
// entre instancias; el README lo documenta. Purga las entradas vencidas en cada
// consulta para que el mapa no crezca sin tope.
function createAttemptLimiter({ max = LINK_ATTEMPTS, windowMs = LINK_WINDOW_MS, now = Date.now } = {}) {
  const intentos = new Map();

  function purgar(t) {
    for (const [userId, entrada] of intentos) {
      if (entrada.resetAt <= t) intentos.delete(userId);
    }
  }

  // Devuelve { allowed: true } o { allowed: false, retryAfterSeconds }.
  function take(userId) {
    const t = now();
    purgar(t);
    let entrada = intentos.get(userId);
    if (!entrada) {
      entrada = { count: 0, resetAt: t + windowMs };
      intentos.set(userId, entrada);
    }
    if (entrada.count >= max) {
      return { allowed: false, retryAfterSeconds: Math.max(1, Math.ceil((entrada.resetAt - t) / 1000)) };
    }
    entrada.count += 1;
    return { allowed: true };
  }

  const reset = (userId) => intentos.delete(userId);

  return { take, reset, size: () => intentos.size };
}

// exchangeToken({ username, password }) es el puerto que conecta ITN-52. Contrato:
//   - resuelve con el token (texto) si iVirtual aceptó las credenciales;
//   - resuelve con null si iVirtual las rechazó (forma de ITN-51, se conserva);
//   - ITN-52: resuelve con { ok: false, reason } para distinguir el motivo:
//     "credenciales" (invalidlogin) o "cambio_password" (forcepasswordchangenotice
//     o passwordisexpired);
//   - lanza si el portal no respondió o falló algo técnico.
// Sin puerto, la vinculación responde 501 y GET dice available: false.
//
// Respuestas: 422 vinculacion_fallida, 409 cambio_password y 502 portal_no_disponible.
// Las tres cuentan como intento. Si iVirtual rechaza, no se guarda nada.
const MOTIVOS_RECHAZO = {
  credenciales: { status: 422, error: "vinculacion_fallida", evento: "vinculacion_rechazada" },
  cambio_password: { status: 409, error: "cambio_password", evento: "vinculacion_cambio_password" },
};

// ITN-52 - Traduce lo que devolvió el puerto. Devuelve { token } o { rechazo } o
// { invalido: true }.
function interpretarPuerto(resultado) {
  if (resultado === null || resultado === undefined) return { rechazo: MOTIVOS_RECHAZO.credenciales };
  if (typeof resultado === "object" && !Array.isArray(resultado) && resultado.ok === false) {
    const rechazo = Object.hasOwn(MOTIVOS_RECHAZO, resultado.reason) ? MOTIVOS_RECHAZO[resultado.reason] : null;
    return rechazo ? { rechazo } : { invalido: true };
  }
  return isValidSecret(resultado) ? { token: resultado } : { invalido: true };
}
function studentCredentialsRouter({ supabase, logger, now, credentialCrypto, exchangeToken, limiter }) {
  const router = express.Router();
  const service = createCredentialService({
    repo: createCredentialRepository(supabase),
    crypto: credentialCrypto,
    now,
  });
  const attempts = limiter ?? createAttemptLimiter({ now });
  const available = typeof exchangeToken === "function";
  const ref = (req) => ({ userId: req.student.userId, portal: PORTAL, kind: KIND });

  const fallo = (res, evento, req, error) => {
    logger.error(evento, {
      user_id: req.student.userId,
      portal: PORTAL,
      kind: KIND,
      step: error?.step ?? null,
      error_code: error?.code ?? null,
    });
    return res.status(500).json({ error: "error_interno" });
  };

  router.use(express.json({ limit: BODY_LIMIT }));

  router.get("/ivirtual", async (req, res) => {
    let estado;
    try {
      estado = await service.getStatusForUser(ref(req));
    } catch (error) {
      return fallo(res, "credencial_estado_no_leido", req, error);
    }
    return res.json({
      available,
      linked: Boolean(estado),
      status: estado?.status ?? null,
      lastValidatedAt: estado?.lastValidatedAt ?? null,
    });
  });

  router.put("/ivirtual", async (req, res) => {
    const { userId } = req.student;
    if (!available) {
      req.body = undefined;
      return res.status(501).json({ error: "vinculacion_no_disponible" });
    }

    const parsed = parseIvirtualLink(req.body);
    // El body ya no hace falta: así no queda una referencia a la contraseña en req.
    req.body = undefined;
    if (!parsed.success) {
      logger.warn("vinculacion_body_rechazado", { user_id: userId, portal: PORTAL, issues: parsed.issues.length });
      return res.status(400).json({ error: "cuerpo_invalido", detalles: parsed.issues });
    }

    const turno = attempts.take(userId);
    if (!turno.allowed) {
      logger.warn("vinculacion_limitada", { user_id: userId, portal: PORTAL, kind: KIND });
      res.set("Retry-After", String(turno.retryAfterSeconds));
      return res.status(429).json({ error: "demasiados_intentos" });
    }

    let resultado;
    try {
      resultado = await exchangeToken({ username: parsed.data.username, password: parsed.data.password });
    } catch {
      // Nada del error del puerto llega al log: su mensaje o código podría citar
      // la contraseña o el token.
      logger.error("vinculacion_portal_fallo", { user_id: userId, portal: PORTAL, kind: KIND, step: "exchange_token" });
      return res.status(502).json({ error: "portal_no_disponible" });
    }

    const { token, rechazo, invalido } = interpretarPuerto(resultado);
    resultado = undefined;
    if (rechazo) {
      logger.warn(rechazo.evento, { user_id: userId, portal: PORTAL, kind: KIND });
      return res.status(rechazo.status).json({ error: rechazo.error });
    }
    if (invalido) {
      logger.error("vinculacion_token_invalido", { user_id: userId, portal: PORTAL, kind: KIND, step: "exchange_token" });
      return res.status(502).json({ error: "portal_no_disponible" });
    }

    let guardada;
    try {
      // ITN-52 - iVirtual acaba de aceptar el token: queda validado ahora.
      guardada = await service.saveSecretForUser({ ...ref(req), secret: token, validated: true });
    } catch (error) {
      return fallo(res, "credencial_no_guardada", req, error);
    }
    attempts.reset(userId);
    logger.info("credencial_vinculada", {
      user_id: userId,
      portal: PORTAL,
      kind: KIND,
      status: guardada.status,
      key_version: guardada.keyVersion,
    });
    return res.json({ available, linked: true, status: guardada.status, lastValidatedAt: guardada.lastValidatedAt });
  });

  router.delete("/ivirtual", async (req, res) => {
    try {
      await service.deleteSecretForUser(ref(req));
    } catch (error) {
      if (error instanceof CredentialNotFoundError) {
        return res.status(404).json({ error: "no_encontrado" });
      }
      return fallo(res, "credencial_no_borrada", req, error);
    }
    logger.info("credencial_borrada", { user_id: req.student.userId, portal: PORTAL, kind: KIND });
    return res.sendStatus(204);
  });

  return router;
}

module.exports = { studentCredentialsRouter, createAttemptLimiter, LINK_ATTEMPTS, LINK_WINDOW_MS };
