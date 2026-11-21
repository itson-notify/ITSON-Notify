const { createClassroomWorkerClient } = require('../rpa/google-classroom');

// ITN-50: same closed list as the backend flags (true/false/1/0); empty = off.
const FLAG_VALUES = ['true', 'false', '1', '0'];
function dispatchFlag(raw) {
  const flag = typeof raw === 'string' ? raw.trim().toLowerCase() : '';
  if (flag === '') return { valid: true, enabled: false };
  if (!FLAG_VALUES.includes(flag)) return { valid: false, enabled: false };
  return { valid: true, enabled: flag === 'true' || flag === '1' };
}

// ITN-50: non critical phase after the sync. Never throws and never changes the
// worker exit code; logs only counters.
async function despacharClassroom({ env = process.env, client, log = console.log, logError = console.error } = {}) {
  const flag = dispatchFlag(env.CLASSROOM_DISPATCH_ENABLED);
  if (!flag.valid) { logError('Classroom despacho: configuracion invalida.'); return; }
  if (!flag.enabled) return;
  try {
    const result = await client.dispatch();
    if (!result?.ok) {
      logError(`Classroom despacho: no disponible (status=${Number.isSafeInteger(result?.status) ? result.status : 0}).`);
      return;
    }
    const { procesados, enviados, fallidos } = result.data;
    log(`Classroom despacho: procesados=${procesados} enviados=${enviados} fallidos=${fallidos}`);
  } catch {
    logError('Classroom despacho: no disponible (status=0).');
  }
}

// ITN-58f: non critical phase after the sync. Reads each synced account's submission state
// (backend calls Google and stores it; never creates events or notices). Only accounts whose
// sync reported tasks are asked: courses-only grants (no task permission) report coursework=0.
// Never throws, never changes the exit code and logs only counters and HTTP status codes.
async function sincronizarEntregas({ client, accounts, log = console.log, logError = console.error } = {}) {
  if (typeof client?.submissions !== 'function' || !Array.isArray(accounts) || accounts.length === 0) return;
  let processed = 0, skipped = 0, failures = 0, stored = 0;
  try {
    for (const account of accounts) {
      let result;
      try { result = await client.submissions(account); }
      catch { result = { ok: false, status: 0 }; }
      if (result?.ok) {
        if (result.data.submissions.skipped) skipped++;
        else processed++;
        stored += result.data.submissions.stored;
        if (result.data.submissions.failedCourses > 0) {
          logError(`Classroom entregas: cursos con error=${result.data.submissions.failedCourses}.`);
        }
        continue;
      }
      const status = Number.isSafeInteger(result?.status) ? result.status : 0;
      if (status === 409 || (status === 403 && result.permissionsMissing === true)) { skipped++; continue; }
      failures++;
      logError(`Classroom entregas: no disponible (status=${status}).`);
      // 401 (key) or 404 (older backend): every other account would fail the same way.
      if (status === 401 || status === 404) break;
    }
  } catch {
    logError('Classroom entregas: no disponible (status=0).');
  }
  log(`Classroom entregas: procesadas=${processed} omitidas=${skipped} fallidas=${failures} guardadas=${stored}`);
}

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
  const withTasks = [];
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
      if (result.ok && (result.status === undefined || (result.status >= 200 && result.status < 300))) {
        processed++;
        if (result.data?.sync?.coursework > 0) withTasks.push({ userId: student.userId, googleId: student.googleId });
      }
      else if (result.status === 409 || (result.status === 403 && result.permissionsMissing === true) ||
          (result.needsRelink && result.status === undefined)) skipped++;
      else failures++;
    } catch { failures++; }
  }
  // No bodies, account identities, academic metadata or arbitrary error messages.
  log(`Classroom: procesadas=${processed} omitidas=${skipped} fallidas=${failures}`);
  // ITN-58f: submission status for synced accounts with tasks; never changes the exit code.
  await sincronizarEntregas({ client, accounts: withTasks, log, logError });
  // ITN-50: dispatch pending task notices; its result never changes the exit code.
  await despacharClassroom({ env, client, log, logError });
  return failures ? 1 : 0;
}
module.exports = { ejecutarClassroom, despacharClassroom, sincronizarEntregas, dispatchFlag };
