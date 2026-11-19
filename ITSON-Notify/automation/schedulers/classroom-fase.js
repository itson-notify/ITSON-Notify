const { createClassroomWorkerClient } = require('../rpa/google-classroom');

async function ejecutarClassroom({ env = process.env, crearCliente = createClassroomWorkerClient,
  log = console.log, logError = console.error } = {}) {
  if (env.RPA_PAUSADO === 'true' || env.CLASSROOM_SYNC_ENABLED !== 'true') return 0;
  let client;
  try { client = crearCliente({ baseUrl: env.BACKEND_URL, apiKey: env.INTERNAL_API_KEY }); }
  catch { logError('Classroom: configuracion invalida.'); return 1; }
  let active;
  try { active = await client.listActive(); }
  catch { logError('Classroom: listado no disponible.'); return 1; }
  if (!active.ok) { logError('Classroom: listado no disponible.'); return 1; }
  const students = active.data?.students;
  const validId = value => typeof value === 'string' && /^[A-Za-z0-9_-]{1,128}$/.test(value);
  if (!Array.isArray(students) || students.some(s => !validId(s?.userId) || !validId(s?.googleId))) {
    logError('Classroom: listado invalido.'); return 1;
  }
  let failures = 0, processed = 0, skipped = 0;
  const seen = new Set();
  for (const student of students) {
    const key = JSON.stringify([student.userId, student.googleId]);
    if (seen.has(key)) continue;
    seen.add(key);
    try {
      const result = await client.sync(student);
      if (result.status === 401) {
        failures++;
        break;
      }
      if (result.ok && (result.status === undefined || (result.status >= 200 && result.status < 300))) processed++;
      else if (result.status === 409 || (result.status === 403 && result.permissionsMissing === true) ||
          (result.needsRelink && result.status === undefined)) skipped++;
      else failures++;
    } catch { failures++; }
  }
  // No bodies, account identities, academic metadata or arbitrary error messages.
  log(`Classroom: procesadas=${processed} omitidas=${skipped} fallidas=${failures}`);
  return failures ? 1 : 0;
}
module.exports = { ejecutarClassroom };
