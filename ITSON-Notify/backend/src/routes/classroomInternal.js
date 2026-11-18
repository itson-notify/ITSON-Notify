const express = require('express');
const { createCoursesService, CoursesError } = require('../services/classroomCourses');
const { isMissingAuthorizationStatus } = require('../services/googleAuthorizationSchema');

function classroomInternalRouter({ config, supabase, classroomFetch }) {
  const router = express.Router();
  const service = createCoursesService({ config, supabase, fetchImpl: classroomFetch });
  router.use((req, res, next) => { res.set('Cache-Control', 'no-store'); next(); });
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
    if (![userId, googleId].every(value => typeof value === 'string' && /^[A-Za-z0-9_-]{1,128}$/.test(value))) {
      return res.status(400).json({ error: 'datos_invalidos' });
    }
    try {
      return res.json(await service.readForWorker({ userId, googleId }));
    } catch (error) {
      return res.status(error instanceof CoursesError ? error.status : 500)
        .json({ error: error instanceof CoursesError ? error.code : 'error_interno' });
    }
  });
  return router;
}
module.exports = { classroomInternalRouter };
