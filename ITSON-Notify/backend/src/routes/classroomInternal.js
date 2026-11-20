const express = require('express');
const { createCoursesService, CoursesError } = require('../services/classroomCourses');
const { isMissingAuthorizationStatus } = require('../services/googleAuthorizationSchema');
const { createClassroomDispatchRepository } = require('../repositories/classroomDispatchRepository');
const { dispatchClassroomTasks } = require('../services/classroomDispatch');

// Tabla o columna inexistente (016/017 sin aplicar) o tabla fuera del caché de PostgREST.
const MIGRACION_FALTANTE = new Set(['42P01', '42703', 'PGRST205']);

function classroomInternalRouter({ config, supabase, classroomFetch, channels = [], logger, now = () => Date.now() }) {
  const router = express.Router();
  const service = createCoursesService({ config, supabase, fetchImpl: classroomFetch });
  const dispatchRepo = createClassroomDispatchRepository(supabase);
  // Una sola corrida de despacho a la vez por proceso.
  let despachando = false;
  router.use((req, res, next) => { res.set('Cache-Control', 'no-store'); next(); });
  // ITN-50 - Despacho de avisos de tareas nuevas. La llave (INTERNAL_API_KEY) ya se
  // revisó en app.js antes de parsear el body. Con la bandera apagada responde 404
  // sin tocar la base. El body se ignora. Responde solo conteos.
  router.post('/dispatch', async (req, res) => {
    if (config.classroomDispatchEnabled !== true) return res.status(404).json({ error: 'no_encontrado' });
    if (despachando) return res.status(409).json({ error: 'despacho_en_curso' });
    despachando = true;
    try {
      const r = await dispatchClassroomTasks({ repo: dispatchRepo, channels, logger, now });
      logger?.info('despacho_classroom', r);
      return res.json({ procesados: r.procesados, enviados: r.enviados, fallidos: r.fallidos });
    } catch (error) {
      logger?.error('despacho_classroom_fallido', { step: error?.step ?? null, error_code: error?.code ?? null });
      if (MIGRACION_FALTANTE.has(error?.code)) return res.status(503).json({ error: 'classroom_migracion_requerida' });
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
  return router;
}
module.exports = { classroomInternalRouter };
