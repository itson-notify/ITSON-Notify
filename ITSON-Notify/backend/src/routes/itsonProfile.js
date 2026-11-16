// ITN-55 - /api/itson-profile: el alumno consulta, guarda y borra su matrícula y
// carrera para la API REST de ITSON. Se monta dentro de studentApi.js, así que antes
// de llegar aquí ya pasó la verificación de Origin (PUT y DELETE) y
// requireStudentSession. El alumno sale SIEMPRE de req.student.userId: un id o
// correo en el body se descarta.
//
// La API de ITSON responde con los datos de cualquier matrícula, así que el PUT
// exige que la matrícula sea la del correo institucional de la sesión
// (verificarMatriculaConCorreo). Ni la matrícula ni la carrera llegan a los logs ni
// a las respuestas de error; GET solo devuelve los últimos 4 dígitos.
const express = require("express");
const { parseItsonProfile, verificarMatriculaConCorreo } = require("../models/itsonProfile");
const { createItsonProfileRepository } = require("../repositories/itsonProfileRepository");
const { createItsonProfileService } = require("../services/itsonProfileService");
const { createAttemptLimiter } = require("./studentCredentials");

const BODY_LIMIT = "4kb";
// Cuentan todos los PUT que pasan Origin y sesión, también los 400: así no se pueden
// probar matrículas sin tope.
const SAVE_ATTEMPTS = 10;
const SAVE_WINDOW_MS = 15 * 60 * 1000;

function itsonProfileRouter({ supabase, logger, now, credentialCrypto, limiter }) {
  const router = express.Router();
  const service = createItsonProfileService({
    repo: createItsonProfileRepository(supabase),
    crypto: credentialCrypto,
    now,
  });
  const attempts = limiter ?? createAttemptLimiter({ max: SAVE_ATTEMPTS, windowMs: SAVE_WINDOW_MS, now });

  const fallo = (res, evento, req, error) => {
    logger.error(evento, { user_id: req.student.userId, step: error?.step ?? null, error_code: error?.code ?? null });
    return res.status(500).json({ error: "error_interno" });
  };

  const sinPerfil = { configured: false, matriculaHint: null, career: null, updatedAt: null };

  router.use(express.json({ limit: BODY_LIMIT }));

  router.get("/", async (req, res) => {
    let perfil;
    try {
      perfil = await service.getForUser(req.student.userId);
    } catch (error) {
      return fallo(res, "perfil_itson_no_leido", req, error);
    }
    if (!perfil) return res.json(sinPerfil);
    return res.json({ configured: true, ...perfil });
  });

  router.put("/", async (req, res) => {
    const { userId } = req.student;
    const body = req.body;
    req.body = undefined;

    const turno = attempts.take(userId);
    if (!turno.allowed) {
      logger.warn("perfil_itson_limitado", { user_id: userId });
      res.set("Retry-After", String(turno.retryAfterSeconds));
      return res.status(429).json({ error: "demasiados_intentos" });
    }

    const parsed = parseItsonProfile(body);
    if (!parsed.success) {
      logger.warn("perfil_itson_body_rechazado", { user_id: userId, issues: parsed.issues.length });
      return res.status(400).json({ error: "cuerpo_invalido", detalles: parsed.issues });
    }
    const { matricula, career } = parsed.data;

    let email;
    try {
      email = await service.getUserEmail(userId);
    } catch (error) {
      return fallo(res, "perfil_itson_no_guardado", req, error);
    }
    if (!email) return res.status(401).json({ error: "no_autenticado" });

    const rechazo = verificarMatriculaConCorreo(matricula, email);
    if (rechazo) {
      logger.warn("perfil_itson_rechazado", { user_id: userId, reason: rechazo });
      return res.status(400).json({ error: rechazo });
    }

    let guardado;
    try {
      guardado = await service.saveForUser({ userId, matricula, career });
    } catch (error) {
      return fallo(res, "perfil_itson_no_guardado", req, error);
    }
    attempts.reset(userId);
    logger.info("perfil_itson_guardado", { user_id: userId });

    let perfil;
    try {
      perfil = await service.getForUser(userId);
    } catch (error) {
      return fallo(res, "perfil_itson_no_leido", req, error);
    }
    return res.json({ configured: true, ...(perfil ?? { ...guardado, matriculaHint: null }) });
  });

  router.delete("/", async (req, res) => {
    let borrado;
    try {
      borrado = await service.deleteForUser(req.student.userId);
    } catch (error) {
      return fallo(res, "perfil_itson_no_borrado", req, error);
    }
    if (!borrado) return res.status(404).json({ error: "no_encontrado" });
    logger.info("perfil_itson_borrado", { user_id: req.student.userId });
    return res.sendStatus(204);
  });

  return router;
}

module.exports = { itsonProfileRouter, SAVE_ATTEMPTS, SAVE_WINDOW_MS };
