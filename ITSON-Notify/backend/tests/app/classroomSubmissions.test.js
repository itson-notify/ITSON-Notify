// ITN-58f - Estado de entrega de Classroom: POST /internal/classroom/submissions (lectura de
// studentSubmissions, lotes a la RPC 022) y el campo submission en /api/courses/:id/items.
// Datos sintéticos; sin red (fetch simulado) ni base real (Supabase simulado).
const { test, describe, before, after } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const request = require('supertest');
const { createApp } = require('../../src/app');
const { createLogger } = require('../../src/utils/logger');
const { sessionHash } = require('../../src/middleware/studentSession');
const { CLASSROOM_SCOPE, CLASSROOM_WORK_SCOPE } = require('../../src/services/googleAuthService');
const { normalizeSubmissions, persistSubmissions, BATCH_SIZE } = require('../../src/services/classroomSubmissions');
const { encrypt } = require('../../src/utils/secureToken');
const { createFakeSupabase } = require('../helpers/fakeSupabase');
const { API_KEY, CREDENTIALS_KEY } = require('../helpers/payloads');

const SECRET = 'synthetic-secret-'.repeat(4);
const USER = '00000000-0000-4000-8000-000000000001';
const GOOGLE = 'google-a';
const ALIAS = 'https://www.googleapis.com/auth/classroom.student-submissions.me.readonly';
const json = (body, status = 200) => new Response(JSON.stringify(body), { status });
const token = (scope) => json({ access_token: 'synthetic-access', token_type: 'Bearer', expires_in: 3600,
  ...(scope === undefined ? {} : { scope }) });
const sub = (courseWorkId, state, extra = {}) => ({ id: `s-${courseWorkId}`, courseId: 'c1', courseWorkId, userId: 'PRIVATE-USER',
  state, alternateLink: 'https://classroom.google.com/PRIVATE', assignmentSubmission: { attachments: ['PRIVATE'] }, ...extra });

function setup({ scope = `${CLASSROOM_SCOPE} ${CLASSROOM_WORK_SCOPE}`, responses = [], courses = ['c1'] } = {}) {
  const db = createFakeSupabase();
  const config = { internalApiKey: API_KEY, credentialsEncryptionKey: CREDENTIALS_KEY, googleAuthSecret: SECRET,
    googleOAuth: { enabled: true, clientId: 'synthetic-id', clientSecret: 'synthetic-secret' } };
  db.tables.google_authorizations.push({ user_id: USER, google_id: GOOGLE, email: 'synthetic@example.test', scope,
    status: 'active', refresh_token: encrypt({ token: 'synthetic-refresh' }, SECRET, 'google-refresh') });
  // Ids ordenados: el backend recorre los cursos por id, así el orden de respuestas es fijo.
  for (const [i, external] of courses.entries()) {
    const id = `10000000-0000-4000-8000-${String(i).padStart(12, '0')}`;
    db.tables.classroom_courses.push({ id, user_id: USER, external_course_id: external, name: 'PRIVATE', course_state: 'ACTIVE' });
    db.tables.classroom_coursework.push({ id: crypto.randomUUID(), user_id: USER, course_id: id,
      external_coursework_id: `w-${external}`, title: 'PRIVATE' });
  }
  // Curso sin tareas: nunca se consulta.
  db.tables.classroom_courses.push({ id: '00000000-0000-4000-8000-000000000000', user_id: USER, external_course_id: 'empty', name: 'PRIVATE', course_state: 'ACTIVE' });
  const calls = [];
  const lines = [];
  const classroomFetch = async (url) => {
    calls.push(String(url));
    assert.ok(responses.length, 'Unexpected request');
    const next = responses.shift();
    if (next instanceof Error) throw next;
    return next;
  };
  const rpcArgs = [];
  db.rpcHandlers.sync_classroom_submissions = (args) => {
    rpcArgs.push(args);
    return { data: { items: args.p_items.length, stored: args.p_items.length, unknown: 0, tasksAllowed: true }, error: null };
  };
  const app = createApp({ config, supabase: db.client, classroomFetch, channels: [], logger: createLogger((l) => lines.push(l)) });
  const post = (body = { userId: USER, googleId: GOOGLE }) =>
    request(app).post('/internal/classroom/submissions').set('x-api-key', API_KEY).send(body);
  return { db, calls, rpcArgs, lines, post };
}

// Interruptor de la fase de escritura: se restaura el valor original al terminar.
const PREV_FLAG = process.env.CLASSROOM_ENTREGAS_ENABLED;
const setFlag = (value) => {
  if (value === undefined) delete process.env.CLASSROOM_ENTREGAS_ENABLED;
  else process.env.CLASSROOM_ENTREGAS_ENABLED = value;
};
after(() => setFlag(PREV_FLAG));

describe('ITN-58f - CLASSROOM_ENTREGAS_ENABLED (fail-closed)', () => {
  test('ausente, vacío, false, TRUE, 1 o basura: 404 sin tocar Google ni la base', async () => {
    for (const flag of [undefined, '', 'false', 'TRUE', 'True', ' true', '1', 'yes', 'basura']) {
      setFlag(flag);
      const s = setup();
      const touched = [];
      const from = s.db.client.from.bind(s.db.client);
      s.db.client.from = (table) => { touched.push(table); return from(table); };
      s.db.client.rpc = () => assert.fail('no debe llamar a la RPC');
      const res = await s.post();
      assert.equal(res.status, 404, `bandera ${JSON.stringify(flag)}`);
      assert.deepEqual(res.body, { error: 'no_encontrado' });
      // Body inválido también es 404: la bandera va antes de cualquier validación.
      assert.equal((await s.post({})).status, 404);
      assert.equal(s.calls.length, 0, 'no llama a Google');
      assert.deepEqual(touched, [], 'no toca la base');
      assert.deepEqual(s.rpcArgs, []);
    }
  });

  test('se lee en cada petición: "true" la enciende sin reconstruir la app y la llave sigue siendo obligatoria', async () => {
    setFlag('false');
    const s = setup({ responses: [token(), json({ studentSubmissions: [sub('w1', 'TURNED_IN')] })] });
    assert.equal((await s.post()).status, 404);
    setFlag('true');
    const res = await s.post();
    assert.equal(res.status, 200);
    assert.equal(res.body.submissions.stored, 1);
    setFlag('false');
    assert.equal((await s.post()).status, 404);
    const sinLlave = await request(createApp({ config: { internalApiKey: API_KEY, credentialsEncryptionKey: CREDENTIALS_KEY },
      supabase: s.db.client, channels: [] })).post('/internal/classroom/submissions').send({ userId: USER, googleId: GOOGLE });
    assert.equal(sinLlave.status, 401);
  });

  test('un valor inválido no impide construir la app ni afecta /health', async () => {
    setFlag('{basura');
    const app = createApp({ config: { internalApiKey: API_KEY, credentialsEncryptionKey: CREDENTIALS_KEY },
      supabase: createFakeSupabase().client, channels: [] });
    assert.equal((await request(app).get('/health')).status, 200);
  });
});

describe('ITN-58f - POST /internal/classroom/submissions', () => {
  before(() => setFlag('true'));
  test('lee entregas por curso con tareas (courseWorkId "-", userId "me") y solo devuelve conteos', async () => {
    const s = setup({ responses: [token(), json({ studentSubmissions: [sub('w1', 'TURNED_IN', { late: true }),
      sub('w2', 'NEW', { assignedGrade: 8, updateTime: '2026-11-20T10:00:00Z' })] })] });
    const res = await s.post();
    assert.equal(res.status, 200);
    assert.deepEqual(res.body, { submissions: { courses: 1, items: 2, stored: 2, unknown: 0, invalid: 0, failedCourses: 0, skipped: false } });
    assert.equal(s.calls.length, 2);
    const url = new URL(s.calls[1]);
    assert.equal(url.pathname, '/v1/courses/c1/courseWork/-/studentSubmissions');
    assert.equal(url.searchParams.get('userId'), 'me');
    assert.equal(s.calls.some((c) => c.includes('/courses/empty/')), false, 'curso sin tareas no se consulta');
    // Lote validado: solo los campos que acepta la 022, sin datos crudos de Google.
    assert.deepEqual(s.rpcArgs, [{ p_user_id: USER, p_google_id: GOOGLE, p_items: [
      { courseId: 'c1', courseWorkId: 'w1', state: 'TURNED_IN', late: true, assignedGrade: null, updateTime: null },
      { courseId: 'c1', courseWorkId: 'w2', state: 'NEW', late: false, assignedGrade: 8, updateTime: '2026-11-20T10:00:00Z' },
    ] }]);
    assert.doesNotMatch(JSON.stringify([res.body, s.lines]), /PRIVATE|synthetic|attachments/);
    // Nunca toca eventos, tareas ni cursos.
    assert.equal(s.db.calls.some((c) => c.rpc && c.rpc !== 'sync_classroom_submissions'), false);
    assert.equal(s.db.calls.some((c) => c.table === 'classroom_task_events' || (c.op && c.op !== 'select')), false);
  });

  test('omite cursos con tareas cuyo course_state no es ACTIVE (archivados o sin estado)', async () => {
    const s = setup({ responses: [token(), json({ studentSubmissions: [sub('w1', 'TURNED_IN')] })] });
    for (const [idx, state] of ['ARCHIVED', 'PROVISIONED', 'DECLINED', null].entries()) {
      const id = `20000000-0000-4000-8000-${String(idx).padStart(12, '0')}`;
      s.db.tables.classroom_courses.push({ id, user_id: USER, external_course_id: `inactivo-${idx}`, name: 'PRIVATE', course_state: state });
      s.db.tables.classroom_coursework.push({ id: crypto.randomUUID(), user_id: USER, course_id: id,
        external_coursework_id: `w-inactivo-${idx}`, title: 'PRIVATE' });
    }
    const res = await s.post();
    assert.equal(res.status, 200);
    assert.deepEqual(res.body.submissions, { courses: 1, items: 1, stored: 1, unknown: 0, invalid: 0, failedCourses: 0, skipped: false });
    assert.equal(s.calls.length, 2, 'solo consulta el curso ACTIVE');
    assert.equal(s.calls.some((c) => c.includes('inactivo-')), false);
  });

  test('pagina studentSubmissions hasta el final y detecta un bucle de paginación', async () => {
    const s = setup({ responses: [token(), json({ studentSubmissions: [sub('w1', 'NEW')], nextPageToken: 'p2' }),
      json({ studentSubmissions: [sub('w2', 'RETURNED')], nextPageToken: 'p3' }), json({ studentSubmissions: [sub('w3', 'CREATED')] })] });
    const res = await s.post();
    assert.equal(res.status, 200);
    assert.equal(res.body.submissions.items, 3);
    assert.deepEqual(s.calls.slice(1).map((c) => new URL(c).searchParams.get('pageToken')), [null, 'p2', 'p3']);

    const loop = setup({ responses: [token(), json({ studentSubmissions: [], nextPageToken: 'x' }),
      json({ studentSubmissions: [], nextPageToken: 'x' })] });
    const r2 = await loop.post();
    assert.equal(r2.status, 200);
    assert.deepEqual(r2.body.submissions, { courses: 0, items: 0, stored: 0, unknown: 0, invalid: 0, failedCourses: 1, skipped: false });
    assert.equal(loop.rpcArgs.length, 0);
  });

  test('un curso que falla se cuenta con su código y no tumba a los demás', async () => {
    const s = setup({ courses: ['c1', 'c2', 'c3'], responses: [token(), json({}, 503), json({}, 403),
      json({ studentSubmissions: [{ ...sub('w3', 'TURNED_IN'), courseId: 'c3' }] })] });
    const res = await s.post();
    assert.equal(res.status, 200);
    assert.deepEqual(res.body.submissions, { courses: 1, items: 1, stored: 1, unknown: 0, invalid: 0, failedCourses: 2, skipped: false });
    assert.equal(s.rpcArgs[0].p_items[0].courseId, 'c3');
    const log = s.lines.map((l) => JSON.parse(l)).find((l) => l.event === 'classroom_entregas');
    assert.deepEqual(log.error_code, ['HTTP_ERROR', 'PERMISSION_DENIED']);
    assert.equal(log.failed, 2);
  });

  test('sin permiso de tareas no llama a studentSubmissions ni a la RPC', async () => {
    for (const [stored, refreshed] of [[CLASSROOM_SCOPE, undefined], [`${CLASSROOM_SCOPE} ${CLASSROOM_WORK_SCOPE}`, CLASSROOM_SCOPE]]) {
      const s = setup({ scope: stored, responses: [token(refreshed)] });
      const res = await s.post();
      assert.equal(res.status, 200);
      assert.equal(res.body.submissions.skipped, true);
      assert.equal(s.calls.length, 1, 'solo el refresh del token');
      assert.equal(s.rpcArgs.length, 0);
    }
    // El alias del permiso de tareas sí cuenta.
    const alias = setup({ scope: `${CLASSROOM_SCOPE} ${ALIAS}`, responses: [token(), json({ studentSubmissions: [] })] });
    assert.equal((await alias.post()).body.submissions.skipped, false);
  });

  test('SQL sin permiso de tareas (revocado a mitad) se reporta como omitida', async () => {
    const s = setup({ responses: [token(), json({ studentSubmissions: [sub('w1', 'TURNED_IN')] })] });
    s.db.rpcHandlers.sync_classroom_submissions = () => ({ data: { items: 0, stored: 0, unknown: 0, tasksAllowed: false }, error: null });
    const res = await s.post();
    assert.equal(res.status, 200);
    assert.equal(res.body.submissions.skipped, true);
    assert.equal(res.body.submissions.stored, 0);
  });

  test('entregas inválidas o de otro curso se descartan; estados raros del formato correcto pasan', async () => {
    const s = setup({ responses: [token(), json({ studentSubmissions: [
      sub('w1', 'turned_in'), sub('w2', 'TURNED_IN', { courseId: 'otro' }), sub('w3', 'TURNED_IN', { late: 'yes' }),
      sub('w4', 'TURNED_IN', { assignedGrade: 1e12 }), sub('w/5', 'TURNED_IN'), sub('w6', 'SUBMISSION_STATE_UNSPECIFIED'),
    ] })] });
    const res = await s.post();
    assert.equal(res.status, 200);
    assert.equal(res.body.submissions.invalid, 5);
    assert.deepEqual(s.rpcArgs[0].p_items.map((i) => i.courseWorkId), ['w6']);
  });

  test('parte el lote en bloques de a lo más BATCH_SIZE', async () => {
    const many = Array.from({ length: BATCH_SIZE + 3 }, (_, i) => sub(`w${i}`, 'NEW'));
    const s = setup({ responses: [token(), json({ studentSubmissions: many })] });
    const res = await s.post();
    assert.equal(res.status, 200);
    assert.deepEqual(s.rpcArgs.map((a) => a.p_items.length), [BATCH_SIZE, 3]);
    assert.equal(res.body.submissions.stored, BATCH_SIZE + 3);
  });

  test('errores de la RPC: 022 sin aplicar 503, autorización 409, otro 500; sin datos en la respuesta', async () => {
    for (const [error, status, code] of [
      [{ code: 'PGRST202', message: 'Could not find the function' }, 503, 'classroom_migracion_requerida'],
      [{ code: '42P01', message: 'relation does not exist' }, 503, 'classroom_migracion_requerida'],
      [{ code: '42501', message: 'classroom_authorization_required' }, 409, 'classroom_requiere_autorizacion'],
      [{ code: '42501', message: 'permission denied for table PRIVATE' }, 500, 'error_interno'],
      [{ code: '22023', message: 'invalid_classroom_submissions' }, 500, 'error_interno'],
    ]) {
      const s = setup({ responses: [token(), json({ studentSubmissions: [sub('w1', 'NEW')] })] });
      s.db.rpcHandlers.sync_classroom_submissions = () => ({ data: null, error });
      const res = await s.post();
      assert.equal(res.status, status);
      assert.deepEqual(res.body, { error: code });
      assert.doesNotMatch(JSON.stringify(s.lines), /PRIVATE|relation/);
    }
  });

  test('token rechazado por Classroom deja la cuenta como relink sin escribir', async () => {
    const s = setup({ courses: ['c1', 'c2'], responses: [token(), json({}, 401)] });
    const res = await s.post();
    assert.equal(res.status, 409);
    assert.equal(s.rpcArgs.length, 0);
    assert.equal(s.calls.length, 2, 'no sigue con los demás cursos');
  });

  test('sin tablas 006 (42P01) no consulta Google más allá del token', async () => {
    const s = setup({ responses: [token()] });
    s.db.failNext('classroom_coursework', 'select', '42P01');
    const res = await s.post();
    assert.equal(res.status, 200);
    assert.equal(res.body.submissions.courses, 0);
  });

  test('valida el body y exige la llave interna', async () => {
    const s = setup();
    for (const body of [{}, { userId: 'no-uuid', googleId: GOOGLE }, { userId: USER, googleId: '../x' }, { userId: USER }]) {
      assert.equal((await s.post(body)).status, 400);
    }
    const sinLlave = await request(createApp({ config: { internalApiKey: API_KEY, credentialsEncryptionKey: CREDENTIALS_KEY },
      supabase: s.db.client, channels: [] })).post('/internal/classroom/submissions').send({ userId: USER, googleId: GOOGLE });
    assert.equal(sinLlave.status, 401);
    assert.equal(s.calls.length, 0);
  });
});

describe('ITN-58f - validación del lote (normalizeSubmissions / persistSubmissions)', () => {
  test('normaliza solo los campos permitidos y cuenta lo inválido', () => {
    const { items, invalid } = normalizeSubmissions([sub('w1', 'RETURNED', { late: false, assignedGrade: 9.5 }), null, 'x',
      { courseId: 'c1', courseWorkId: 'w2' }, sub('w3', 'TURNED_IN', { updateTime: 'ayer' })], 'c1');
    assert.deepEqual(items, [{ courseId: 'c1', courseWorkId: 'w1', state: 'RETURNED', late: false, assignedGrade: 9.5, updateTime: null }]);
    assert.equal(invalid, 4);
    assert.deepEqual(normalizeSubmissions(undefined, 'c1'), { items: [], invalid: 0 });
  });

  test('una respuesta malformada de la RPC es error interno', async () => {
    const db = createFakeSupabase();
    db.rpcHandlers.sync_classroom_submissions = () => ({ data: { items: 1, stored: -1, unknown: 0, tasksAllowed: true }, error: null });
    await assert.rejects(persistSubmissions(db.client, { userId: USER, googleId: GOOGLE }, [{ courseId: 'c1' }]), { status: 500 });
    assert.deepEqual(await persistSubmissions(db.client, { userId: USER, googleId: GOOGLE }, []), { stored: 0, unknown: 0, tasksAllowed: true });
  });
});

// ── /api/courses/:id/items ──────────────────────────────────────────────────

const T0 = Date.parse('2026-11-16T12:00:00Z');
const ALUMNA = { userId: crypto.randomUUID(), googleId: 'google-items', sessionId: 'sesion-items' };

function setupItems() {
  const db = createFakeSupabase();
  const lines = [];
  const app = createApp({ config: { internalApiKey: API_KEY, credentialsEncryptionKey: CREDENTIALS_KEY,
    googleAuthSecret: SECRET, frontendUrl: 'http://localhost:5173' }, supabase: db.client,
  logger: createLogger((l) => lines.push(l)), now: () => T0, channels: [] });
  db.tables.app_users.push({ id: ALUMNA.userId, email: 'alumna@example.test' });
  db.tables.google_authorizations.push({ user_id: ALUMNA.userId, google_id: ALUMNA.googleId, email: 'alumna@example.test',
    scope: 's', refresh_token: 'cifrado' });
  db.tables.google_app_sessions.push({ id: sessionHash(ALUMNA.sessionId), user_id: ALUMNA.userId, google_id: ALUMNA.googleId,
    expires_at: new Date(T0 + 7200000).toISOString(), revoked_at: null });
  const courseId = crypto.randomUUID();
  db.tables.classroom_courses.push({ id: courseId, user_id: ALUMNA.userId, external_course_id: 'c1', name: 'Materia' });
  const tareas = ['a', 'b', 'c', 'd'].map((k, i) => ({ id: `0000000${i}-0000-4000-8000-000000000000`, user_id: ALUMNA.userId,
    course_id: courseId, external_coursework_id: k, title: `Tarea ${k}`, due_at: '2026-11-10T06:59:00.000Z', max_points: 10 }));
  db.tables.classroom_coursework.push(...tareas);
  const cookie = `itn41_google_session=${encrypt({ ...ALUMNA, exp: T0 + 3600000 }, SECRET, 'google-session')}`;
  const get = () => request(app).get(`/api/courses/${courseId}/items`).set('Cookie', cookie);
  return { db, tareas, get, lines };
}

describe('ITN-58f - submission en /api/courses/:id/items', () => {
  test('la bandera de entregas no afecta la lectura: con la fase apagada sigue mostrando submission', async () => {
    for (const flag of [undefined, 'false', 'true']) {
      setFlag(flag);
      const s = setupItems();
      s.db.tables.classroom_submissions.push(
        { user_id: ALUMNA.userId, coursework_id: s.tareas[0].id, state: 'RETURNED', late: false });
      const res = await s.get();
      assert.equal(res.status, 200);
      const item = res.body.items.find((i) => i.id === s.tareas[0].id);
      assert.deepEqual(item.submission, { state: 'RETURNED', late: false }, `bandera ${JSON.stringify(flag)}`);
    }
  });

  test('incluye { state, late } cuando hay entrega conocida y omite la llave si no', async () => {
    const s = setupItems();
    s.db.tables.classroom_submissions.push(
      { user_id: ALUMNA.userId, coursework_id: s.tareas[0].id, state: 'TURNED_IN', late: true, assigned_grade: 9 },
      { user_id: ALUMNA.userId, coursework_id: s.tareas[1].id, state: 'RECLAIMED_BY_STUDENT', late: null },
      // Valor raro de state (o futuro de Google): se ignora.
      { user_id: ALUMNA.userId, coursework_id: s.tareas[2].id, state: 'ALGO_NUEVO', late: false },
      // Fila de otro alumno con la misma tarea: nunca se mezcla.
      { user_id: crypto.randomUUID(), coursework_id: s.tareas[3].id, state: 'RETURNED', late: false },
    );
    const res = await s.get();
    assert.equal(res.status, 200);
    const porId = Object.fromEntries(res.body.items.map((i) => [i.id, i]));
    assert.deepEqual(porId[s.tareas[0].id].submission, { state: 'TURNED_IN', late: true });
    assert.deepEqual(porId[s.tareas[1].id].submission, { state: 'RECLAIMED_BY_STUDENT', late: false });
    assert.equal('submission' in porId[s.tareas[2].id], false);
    assert.equal('submission' in porId[s.tareas[3].id], false);
    // La nota de Classroom no se expone aquí.
    assert.equal(porId[s.tareas[0].id].grade, null);
  });

  test('sin la tabla 022 (42P01 o PGRST205) la ruta responde igual que antes, sin submission', async () => {
    for (const code of ['42P01', 'PGRST205']) {
      const s = setupItems();
      s.db.failNext('classroom_submissions', 'select', code);
      const res = await s.get();
      assert.equal(res.status, 200);
      assert.equal(res.body.items.length, 4);
      assert.equal(res.body.items.some((i) => 'submission' in i), false);
    }
    const sinColumna = setupItems();
    sinColumna.db.withoutColumn('classroom_submissions', 'late');
    assert.equal((await sinColumna.get()).status, 200);
  });

  test('un fallo inesperado al leer entregas no tumba la ruta y solo se registra el código', async () => {
    const s = setupItems();
    s.db.failNext('classroom_submissions', 'select', 'XX000');
    const res = await s.get();
    assert.equal(res.status, 200);
    assert.equal(res.body.items.some((i) => 'submission' in i), false);
    assert.doesNotMatch(s.lines.join('\n'), /Tarea|TURNED_IN/);
  });
});
