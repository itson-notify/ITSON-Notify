const express = require('express');
const { createCoursesService, CoursesError } = require('../services/classroomCourses');
const { isMissingAuthorizationStatus } = require('../services/googleAuthorizationSchema');
const {
  createClassroomDeliveryRepository,
  ClassroomLedgerError,
  MISSING_MIGRATION_CODES,
} = require('../repositories/classroomDeliveryRepository');
const {
  processClassroomDeliveries,
  buildClassroomTransports,
  loadClassroomDispatchConfig,
} = require('../services/classroomDeliveryService');

function classroomInternalRouter({
  config,
  supabase,
  classroomFetch,
  channels,
  classroomTransports,
  classroomDeliveryRepo,
  logger,
  now,
}) {
  const router = express.Router();
  const service = createCoursesService({ config, supabase, fetchImpl: classroomFetch });
  const deliveryRepo = classroomDeliveryRepo ?? createClassroomDeliveryRepository(supabase);
  let despachando = false;

  router.use((req, res, next) => { res.set('Cache-Control', 'no-store'); next(); });

  // ITN-50 / ITN-44 - Despacho de avisos de tareas nuevas sobre el ledger 019
  // (processClassroomDeliveries). La llave INTERNAL_API_KEY ya se validó en app.js
  // antes de parsear el body. Apagado por defecto (CLASSROOM_DISPATCH_ENABLED=false
  // -> 404 sin tocar la base) y restringido a la lista permitida de usuarios.
  router.post('/dispatch', async (req, res) => {
    let dispatchCfg;
    try {
      dispatchCfg = loadClassroomDispatchConfig(process.env, config);
    } catch {
      return res.status(404).json({ error: 'no_encontrado' });
    }
    if (dispatchCfg.classroomDispatchEnabled !== true) {
      return res.status(404).json({ error: 'no_encontrado' });
    }
    if (!Array.isArray(dispatchCfg.classroomDispatchAllowedUsers) || dispatchCfg.classroomDispatchAllowedUsers.length === 0) {
      logger?.warn?.('despacho_classroom_sin_usuarios_permitidos', { count: 0 });
      return res.json({ procesados: 0, enviados: 0, fallidos: 0 });
    }
    if (despachando) {
      return res.status(409).json({ error: 'despacho_en_curso' });
    }
    despachando = true;
    try {
      const transports = buildClassroomTransports({
        config,
        env: process.env,
        pushRepo: deliveryRepo.pushRepo,
        channels,
        transports: classroomTransports,
      });
      if (!transports.email && !transports.web_push) {
        logger?.warn?.('despacho_classroom_fallido', { step: 'transports', error_code: 'channel_unconfigured' });
        return res.status(503).json({ error: 'classroom_canales_no_configurados' });
      }
      const rawSecret = config.googleAuthSecret || config.credentialsEncryptionKey;
      const secret = Buffer.isBuffer(rawSecret) ? rawSecret.toString('base64') : rawSecret;
      const r = await processClassroomDeliveries({
        repo: deliveryRepo,
        transports,
        secret,
        allowedUsers: dispatchCfg.classroomDispatchAllowedUsers,
        logger,
        now,
      });
      logger?.info?.('despacho_classroom', {
        procesados: r.procesados,
        enviados: r.enviados,
        fallidos: r.fallidos,
        omitidos: r.omitidos,
      });
      return res.json({
        procesados: r.procesados,
        enviados: r.enviados,
        fallidos: r.fallidos,
      });
    } catch (error) {
      const errCode = error?.pgCode ?? error?.code ?? null;
      logger?.error?.('despacho_classroom_fallido', {
        step: error?.step ?? null,
        error_code: errCode,
      });
      if (
        (error instanceof ClassroomLedgerError && error.status === 503) ||
        MISSING_MIGRATION_CODES.has(errCode)
      ) {
        return res.status(503).json({ error: 'classroom_migracion_requerida' });
      }
      return res.status(500).json({ error: 'error_interno' });
    } finally {
      despachando = false;
    }
  });

  router.get('/active', async (req, res) => {
    try {
      const { data, error } = await supabase.from('google_authorizations')
        .select('user_id,google_id').eq('status', 'active');
      if (isMissingAuthorizationStatus(error)) {
        return res.status(503).json({ error: 'classroom_migracion_requerida' });
      }
      if (error) return res.status(500).json({ error: 'error_interno' });
      return res.json({ students: data.map(row => ({ userId: row.user_id, googleId: row.google_id })) });
    } catch {
      return res.status(500).json({ error: 'error_interno' });
    }
  });
  router.post('/read', async (req, res) => {
    const { userId, googleId } = req.body ?? {};
    if (req.body?.sync !== undefined && typeof req.body.sync !== 'boolean') {
      return res.status(400).json({ error: 'datos_invalidos' });
    }
    if (req.body?.sync === true && (typeof userId !== 'string' ||
        !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(userId))) {
      return res.status(400).json({ error: 'datos_invalidos' });
    }
    if (![userId, googleId].every(value => typeof value === 'string' && /^[A-Za-z0-9_-]{1,128}$/.test(value))) {
      return res.status(400).json({ error: 'datos_invalidos' });
    }
    try {
      return res.json(await service.readForWorker({ userId, googleId }, { sync: req.body.sync === true }));
    } catch (error) {
      return res.status(error instanceof CoursesError ? error.status : 500)
        .json({ error: error instanceof CoursesError ? error.code : 'error_interno' });
    }
  });
  // ITN-58f - Estado de entrega del alumno por tarea (solo lectura, sin avisos). Fase aparte del
  // sync: la llama el worker después de sincronizar cursos y tareas. Solo devuelve conteos.
  router.post('/submissions', async (req, res) => {
    const { userId, googleId } = req.body ?? {};
    if (typeof userId !== 'string' ||
        !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(userId) ||
        typeof googleId !== 'string' || !/^[A-Za-z0-9_-]{1,128}$/.test(googleId)) {
      return res.status(400).json({ error: 'datos_invalidos' });
    }
    try {
      const { submissions, errorCodes } = await service.syncSubmissionsForWorker({ userId, googleId });
      logger?.info?.('classroom_entregas', {
        courses: submissions.courses,
        items: submissions.items,
        stored: submissions.stored,
        unknown: submissions.unknown,
        failed: submissions.failedCourses,
        reason: submissions.skipped ?? null,
        error_code: errorCodes,
      });
      const { skipped, ...counts } = submissions;
      return res.json({ submissions: { ...counts, skipped: Boolean(skipped) } });
    } catch (error) {
      const known = error instanceof CoursesError;
      logger?.warn?.('classroom_entregas_fallida', { status: known ? error.status : 500, error_code: known ? error.code : 'error_interno' });
      return res.status(known ? error.status : 500).json({ error: known ? error.code : 'error_interno' });
    }
  });
  return router;
}
module.exports = { classroomInternalRouter };
