// ITN-58: cliente de /api/courses, utilidades de courses.ts y la pantalla Materias en App.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { compile, harness, find } = require('./harness.cjs');

const json = (body, status = 200) => ({ ok: status < 400, status, json: async () => body });

const COURSE_IV = { id: '11111111-1111-4111-8111-111111111111', name: 'Programación', source: 'ivirtual', period: null, finalGrade: '95.5', updatedAt: '2026-11-18T10:00:00.000Z' };
const COURSE_CR = { id: '22222222-2222-4222-8222-222222222222', name: 'IA', source: 'classroom', period: 'Grupo 02', finalGrade: null, updatedAt: '2026-11-18T10:00:00.000Z' };
const COURSE_IT = { id: '33333333-3333-4333-8333-333333333333', name: 'Cálculo', source: 'itson_api', period: '03', finalGrade: '9', updatedAt: '2026-11-18T10:00:00.000Z' };
const ITEM = { id: 'i1', label: 'Práctica 1', grade: 85, maxGrade: 100, dueAt: '2026-11-20T06:59:00.000Z', kind: 'ivirtual' };

// ── Cliente ─────────────────────────────────────────────────────────────────

function cliente({ useMock = false, responder } = {}) {
  const env = { VITE_BACKEND_URL: 'https://api.test/', ...(useMock ? { VITE_USE_MOCK: 'true' } : {}) };
  const backend = compile('services/backend.ts', require, env);
  const api = compile('services/api.ts', id => (id === '@/services/backend' ? backend : require(id)), env);
  const calls = [];
  const original = global.fetch;
  global.fetch = async (url, options = {}) => {
    calls.push({ url, method: options.method ?? 'GET', credentials: options.credentials });
    return responder(url);
  };
  return { api, calls, restore: () => { global.fetch = original; } };
}

test('getCourses y getCourseItems piden la URL correcta con la cookie de sesión', async () => {
  const c = cliente({ responder: url => (url.endsWith('/items') ? json({ items: [ITEM] }) : json({ courses: [COURSE_IV] })) });
  try {
    assert.deepEqual(await c.api.getCourses(), [COURSE_IV]);
    assert.deepEqual(await c.api.getCourseItems('a b/c'), [ITEM]);
    assert.deepEqual(c.calls, [
      { url: 'https://api.test/api/courses', method: 'GET', credentials: 'include' },
      { url: 'https://api.test/api/courses/a%20b%2Fc/items', method: 'GET', credentials: 'include' },
    ]);
  } finally { c.restore(); }
});

test('400, 401 y 404 llegan como ApiError con status y código, sin el body', async () => {
  for (const [status, error] of [[400, 'id_invalido'], [401, 'no_autenticado'], [404, 'no_encontrado']]) {
    const c = cliente({ responder: () => json({ error, detalle: 'texto libre del servidor' }, status) });
    try {
      for (const llamada of [() => c.api.getCourses(), () => c.api.getCourseItems('x')]) {
        await assert.rejects(llamada, e => {
          assert.ok(e instanceof c.api.ApiError);
          assert.equal(e.status, status);
          assert.equal(e.code, error);
          assert.ok(!JSON.stringify(e).includes('texto libre'));
          return true;
        });
      }
    } finally { c.restore(); }
  }
});

test('sin mock un fallo de red se propaga: no hay datos de respaldo', async () => {
  const c = cliente({ responder: () => { throw new TypeError('Failed to fetch'); } });
  try {
    await assert.rejects(() => c.api.getCourses(), TypeError);
    await assert.rejects(() => c.api.getCourseItems('x'), TypeError);
  } finally { c.restore(); }
});

test('con VITE_USE_MOCK=true devuelve datos simulados de las tres fuentes y no sale a la red', async () => {
  const c = cliente({ useMock: true, responder: () => assert.fail('no debe llamar a la red') });
  try {
    const courses = await c.api.getCourses();
    assert.deepEqual([...new Set(courses.map(x => x.source))].sort(), ['classroom', 'itson_api', 'ivirtual']);
    const items = (await Promise.all(courses.map(x => c.api.getCourseItems(x.id)))).flat();
    const now = Date.now();
    assert.ok(items.some(i => i.grade !== null), 'calificadas');
    assert.ok(items.some(i => i.dueAt === null), 'sin fecha');
    assert.ok(items.some(i => i.grade === null && i.dueAt && Date.parse(i.dueAt) < now), 'vencidas');
    assert.ok(items.some(i => i.grade === null && i.dueAt && Date.parse(i.dueAt) >= now), 'próximas');
    await assert.rejects(() => c.api.getCourseItems('no-existe'), e => e.status === 404);
    assert.equal(c.calls.length, 0);
  } finally { c.restore(); }
});

// ── Utilidades ──────────────────────────────────────────────────────────────

const U = compile('utils/courses.ts', require);
const NOW = Date.parse('2026-11-18T19:00:00.000Z'); // miércoles 18 nov, 12:00 en Hermosillo
const item = (id, dueAt, grade = null, maxGrade = 100) => ({ id, label: id, grade, maxGrade, dueAt, kind: 'ivirtual' });

test('ordena por dueAt ascendente con las que no tienen fecha al final', () => {
  const items = [item('sin1', null), item('c', '2026-12-01T00:00:00.000Z'), item('a', '2026-11-01T00:00:00.000Z'),
    item('mala', 'no es fecha'), item('b', '2026-11-20T06:59:00.000Z'), item('sin2', null)];
  assert.deepEqual(U.sortItems(items).map(i => i.id), ['a', 'b', 'c', 'sin1', 'mala', 'sin2']);
  assert.deepEqual(items.map(i => i.id)[0], 'sin1', 'no muta la lista original');
});

test('clasifica en vencida, próxima, calificada y sin fecha con now fijo', () => {
  assert.equal(U.classifyItem(item('v', '2026-11-18T18:59:59.000Z'), NOW), 'vencida');
  assert.equal(U.classifyItem(item('p', '2026-11-18T19:00:00.000Z'), NOW), 'proxima', 'dueAt == now es próxima');
  assert.equal(U.classifyItem(item('p2', '2026-11-20T06:59:00.000Z'), NOW), 'proxima');
  assert.equal(U.classifyItem(item('c', '2026-11-01T00:00:00.000Z', 90), NOW), 'calificada');
  assert.equal(U.classifyItem(item('c0', '2026-12-01T00:00:00.000Z', 0), NOW), 'calificada', 'un 0 sí es calificación');
  assert.equal(U.classifyItem(item('ct', null, 'Aprobado'), NOW), 'calificada');
  assert.equal(U.classifyItem(item('s', null), NOW), 'sin_fecha');
});

test('agrupa en orden Vencidas, Próximas, Calificadas, Sin fecha y omite grupos vacíos', () => {
  const groups = U.groupItems([item('s', null), item('c', '2026-11-01T00:00:00.000Z', 90),
    item('p', '2026-11-25T00:00:00.000Z'), item('v2', '2026-11-10T00:00:00.000Z'), item('v1', '2026-11-05T00:00:00.000Z')], NOW);
  assert.deepEqual(groups.map(g => [g.status, g.items.map(i => i.id)]),
    [['vencida', ['v1', 'v2']], ['proxima', ['p']], ['calificada', ['c']], ['sin_fecha', ['s']]]);
  assert.deepEqual(U.groupItems([item('p', '2026-11-25T00:00:00.000Z')], NOW).map(g => g.status), ['proxima']);
});

test('formatea en hora de Hermosillo: 2026-11-20T06:59Z es jueves 19 nov a las 23:59', () => {
  assert.equal(U.formatDue('2026-11-20T06:59:00.000Z', NOW), 'jue 19 nov, 23:59');
  assert.equal(U.formatDue('2026-11-18T07:00:00.000Z', NOW), 'mié 18 nov, 00:00');
  assert.equal(U.formatDue('2027-01-05T19:30:00.000Z', NOW), 'mar 5 ene 2027, 12:30', 'otro año lleva el año');
  assert.equal(U.formatDue(null, NOW), null);
  assert.equal(U.formatDue('no es fecha', NOW), null);
});

test('nota legible y etiquetas de fuente y periodo', () => {
  assert.equal(U.formatGrade({ grade: 85, maxGrade: 100 }), '85 / 100');
  assert.equal(U.formatGrade({ grade: 78.456, maxGrade: 100 }), '78.46 / 100');
  assert.equal(U.formatGrade({ grade: 9, maxGrade: null }), '9');
  assert.equal(U.formatGrade({ grade: 'Aprobado', maxGrade: 100 }), 'Aprobado');
  assert.equal(U.formatGrade({ grade: null, maxGrade: 100 }), 'Sin calificar');
  assert.deepEqual(U.SOURCE_LABEL, { ivirtual: 'iVirtual', classroom: 'Google Classroom', itson_api: 'API de ITSON' });
  assert.equal(U.periodLabel({ source: 'itson_api', period: '03' }), 'Semestre 3');
  assert.equal(U.periodLabel({ source: 'classroom', period: 'Grupo 02' }), 'Grupo 02');
  assert.equal(U.periodLabel({ source: 'ivirtual', period: null }), null);
});

// ── App ─────────────────────────────────────────────────────────────────────

const ME = { email: 'alumna@example.test', classroomConnected: true, itsonStatus: 'ok' };

function backend({ courses = [COURSE_IV, COURSE_CR, COURSE_IT], items = { [COURSE_IV.id]: [ITEM], [COURSE_CR.id]: [] }, fallos = {}, profile } = {}) {
  const calls = [];
  const fetchImpl = async (url, options = {}) => {
    const ruta = url.replace('https://api.test', '');
    calls.push({ ruta, credentials: options.credentials });
    if (fallos[ruta]) return json({ error: 'x' }, fallos[ruta]);
    if (ruta === '/auth/google/session') return json({ connected: true, email: ME.email });
    if (ruta === '/api/me') return json(ME);
    if (ruta === '/api/notifications') return json([]);
    if (ruta === '/api/credentials/ivirtual') return json({ available: true, linked: true, status: 'active', lastValidatedAt: null });
    if (ruta === '/api/itson-profile') return json(profile ?? { configured: true, matriculaHint: '•••••••1234', career: 'INSOF', updatedAt: null });
    if (ruta === '/api/courses') return json({ courses });
    const m = ruta.match(/^\/api\/courses\/([^/]+)\/items$/);
    if (m) return items[m[1]] ? json({ items: items[m[1]] }) : json({ error: 'no_encontrado' }, 404);
    return { ok: true, status: 204 };
  };
  return { calls, fetchImpl };
}

async function enMaterias(opciones, harnessOpts = { useMock: false }) {
  const b = backend(opciones);
  const h = harness('', b.fetchImpl, harnessOpts);
  await h.start();
  find(h.render(), 'AppLayout').props.onGo('materias');
  await h.settle();
  return { ...b, h, page: () => find(h.render(), 'CoursesPage') };
}
const rutas = (calls, prefijo) => calls.filter(c => c.ruta.startsWith(prefijo)).map(c => c.ruta);

test('al entrar a Materias pide /api/courses una vez y las tareas solo al abrir cada materia', async () => {
  const { h, calls, page } = await enMaterias();
  try {
    assert.equal(page().props.state.status, 'ready');
    assert.deepEqual(page().props.state.courses.map(c => c.id), [COURSE_IV.id, COURSE_CR.id, COURSE_IT.id]);
    assert.deepEqual(rutas(calls, '/api/courses'), ['/api/courses']);

    page().props.onOpen(COURSE_IV.id);
    assert.equal(page().props.itemsById[COURSE_IV.id].status, 'loading');
    await h.settle();
    assert.deepEqual(page().props.itemsById[COURSE_IV.id].items, [ITEM]);
    assert.equal(page().props.selectedId, COURSE_IV.id);

    // Volver a la lista y abrirla otra vez no repite la petición.
    page().props.onClose();
    page().props.onOpen(COURSE_IV.id);
    await h.settle();
    // itson_api no se pide: siempre responde { items: [] }.
    page().props.onOpen(COURSE_IT.id);
    await h.settle();
    assert.deepEqual(rutas(calls, '/api/courses/'), [`/api/courses/${COURSE_IV.id}/items`]);
    for (const c of calls.filter(c => c.ruta.startsWith('/api'))) assert.equal(c.credentials, 'include');
  } finally { h.restore(); }
});

test('volver a entrar refresca la lista y conserva las tareas si la materia no cambió', async () => {
  const { h, calls, page } = await enMaterias();
  try {
    page().props.onOpen(COURSE_IV.id);
    await h.settle();
    const layout = () => find(h.render(), 'AppLayout');
    layout().props.onGo('inicio');
    layout().props.onGo('materias');
    // Mientras carga, otra entrada no duplica la petición.
    layout().props.onGo('materias');
    await h.settle();
    assert.deepEqual(rutas(calls, '/api/courses'), ['/api/courses', `/api/courses/${COURSE_IV.id}/items`, '/api/courses']);
    assert.equal(page().props.selectedId, null);
    page().props.onOpen(COURSE_IV.id);
    await h.settle();
    assert.equal(rutas(calls, '/api/courses/').length, 1);
  } finally { h.restore(); }
});

test('error al cargar materias o tareas deja reintentar', async () => {
  const { h, page } = await enMaterias({ fallos: { '/api/courses': 500 } });
  try {
    assert.equal(page().props.state.status, 'error');
    assert.deepEqual(page().props.state.courses, []);
  } finally { h.restore(); }

  const b = await enMaterias({ fallos: { [`/api/courses/${COURSE_IV.id}/items`]: 500 } });
  try {
    b.page().props.onOpen(COURSE_IV.id);
    await b.h.settle();
    assert.equal(b.page().props.itemsById[COURSE_IV.id].status, 'error');
    b.page().props.onRetryItems(COURSE_IV.id);
    await b.h.settle();
    assert.equal(rutas(b.calls, '/api/courses/').length, 2);
  } finally { b.h.restore(); }
});

test('404 de las tareas marca la materia como no disponible', async () => {
  const { h, page } = await enMaterias({ items: {} });
  try {
    page().props.onOpen(COURSE_IV.id);
    await h.settle();
    assert.equal(page().props.itemsById[COURSE_IV.id].status, 'missing');
  } finally { h.restore(); }
});

test('un 401 en materias o tareas termina la sesión', async () => {
  const { h } = await enMaterias({ fallos: { '/api/courses': 401 } });
  try {
    const tree = h.render();
    assert.ok(find(tree, 'Onboarding'));
    assert.equal(find(tree, 'ToastView').props.toast.text, 'Tu sesión expiró. Vuelve a entrar con Google.');
  } finally { h.restore(); }

  const b = await enMaterias({ fallos: { [`/api/courses/${COURSE_IV.id}/items`]: 401 } });
  try {
    b.page().props.onOpen(COURSE_IV.id);
    await b.h.settle();
    assert.ok(find(b.h.render(), 'Onboarding'));
  } finally { b.h.restore(); }
});

test('pasa la vinculación de iVirtual para explicar el vacío', async () => {
  const { h, page } = await enMaterias({ courses: [] });
  try {
    assert.equal(page().props.state.status, 'ready');
    assert.deepEqual(page().props.state.courses, []);
    assert.equal(page().props.ivirtualLink.linked, true);
    assert.equal(page().props.classroomConnected, true);
  } finally { h.restore(); }
});

test('sin mock no muestra el alumno de prueba: correo de /api/me y carrera de /api/itson-profile', async () => {
  const { h } = await enMaterias();
  try {
    const tree = h.render();
    const student = find(tree, 'AppLayout').props.student;
    assert.deepEqual(student, { name: null, email: ME.email, initials: 'A', career: 'INSOF' });
    assert.ok(!JSON.stringify(student).includes('Demo'));
  } finally { h.restore(); }
});

test('con VITE_USE_MOCK=true Materias funciona sin backend', async () => {
  const b = backend();
  const h = harness('', b.fetchImpl, { useMock: true });
  try {
    await h.start();
    find(h.render(), 'Onboarding').props.onFinish();
    assert.equal(find(h.render(), 'HomePage').props.student.name, 'Alumno Demo');
    find(h.render(), 'AppLayout').props.onGo('materias');
    await h.settle();
    const page = () => find(h.render(), 'CoursesPage');
    assert.ok(page().props.state.courses.length >= 3);
    const first = page().props.state.courses.find(c => c.source === 'ivirtual');
    page().props.onOpen(first.id);
    await h.settle();
    assert.equal(page().props.itemsById[first.id].status, 'ready');
    assert.ok(page().props.itemsById[first.id].items.length > 0);
    assert.equal(b.calls.filter(c => c.ruta.startsWith('/api')).length, 0);
  } finally { h.restore(); }
});

// ── ITN-58b - Materias unificadas ───────────────────────────────────────────

const UNIFICADA = {
  id: COURSE_IV.id, name: 'Ingeniería de Software', source: 'ivirtual', period: null, finalGrade: '90', updatedAt: '2026-11-18T12:00:00.000Z',
  sources: [
    { source: 'ivirtual', id: COURSE_IV.id, name: 'Ingeniería de Software', period: null, finalGrade: '90', updatedAt: '2026-11-18T10:00:00.000Z' },
    { source: 'classroom', id: COURSE_CR.id, name: 'Ingeniería de Software - Grupo 02', period: 'Grupo 02', finalGrade: null, updatedAt: '2026-11-18T12:00:00.000Z' },
    { source: 'itson_api', id: COURSE_IT.id, name: 'INGENIERIA DE SOFTWARE', period: '05', finalGrade: '9', updatedAt: '2026-11-18T09:00:00.000Z' },
  ],
};
const ITEM_IV = { id: 'iv1', label: 'Tarea iVirtual', grade: 90, maxGrade: 100, dueAt: '2026-11-10T06:59:00.000Z', kind: 'ivirtual', source: 'ivirtual' };
const ITEM_CR = { id: 'cr1', label: 'Tarea Classroom', grade: null, maxGrade: 50, dueAt: '2026-11-25T06:59:00.000Z', kind: 'classroom', source: 'classroom' };

test('utilidades: fuentes ordenadas, materia sin sources y secciones sin fuentes vacías', () => {
  assert.deepEqual(U.courseSources({ ...UNIFICADA, sources: [...UNIFICADA.sources].reverse() }).map(s => s.source), ['ivirtual', 'classroom', 'itson_api']);
  assert.deepEqual(U.courseSources(COURSE_IT), [{ source: 'itson_api', id: COURSE_IT.id, name: 'Cálculo', period: '03', finalGrade: '9', updatedAt: COURSE_IT.updatedAt }]);
  assert.equal(U.courseHasItems(COURSE_IT), false);
  assert.equal(U.courseHasItems({ ...COURSE_IT, sources: [UNIFICADA.sources[2], UNIFICADA.sources[1]] }), true);
  assert.equal(U.itemSource({ ...ITEM, source: undefined }), 'ivirtual');

  const secciones = U.sourceSections(UNIFICADA, [ITEM_CR, ITEM_IV]);
  assert.deepEqual(secciones.map(s => [s.entry.source, s.items.map(i => i.id)]), [['ivirtual', ['iv1']], ['classroom', ['cr1']], ['itson_api', []]]);
  // Classroom sin tareas e ITSON sin calificación no tienen sección.
  const sinDatos = { ...UNIFICADA, sources: UNIFICADA.sources.map(s => (s.source === 'itson_api' ? { ...s, finalGrade: null } : s)) };
  assert.deepEqual(U.sourceSections(sinDatos, [ITEM_IV]).map(s => s.entry.source), ['ivirtual']);
});

// Renderiza CoursesPage expandiendo sus componentes locales (sin hooks). Los
// componentes importados quedan como nodos con nombre ('Button', 'SkeletonList').
function renderCourses(props) {
  const jsx = (type, p) => ({ type, props: p });
  const courses = compile('utils/courses.ts', require);
  const { CoursesPage } = compile('pages/CoursesPage.tsx', id => {
    if (id === 'react/jsx-runtime') return { jsx, jsxs: jsx, Fragment: 'Fragment' };
    if (id === '@/components/icons') return { I: new Proxy({}, { get: () => () => null }) };
    if (id === '@/utils/courses') return courses;
    if (id === '@/utils/styles') return { focusRing: '' };
    return new Proxy({}, { get: (_, key) => key });
  });
  const expand = node => {
    if (Array.isArray(node)) return node.map(expand);
    if (!node || typeof node !== 'object') return node;
    if (typeof node.type === 'function') return expand(node.type(node.props));
    return { type: node.type, props: { ...node.props, children: expand(node.props?.children) } };
  };
  const tree = expand(CoursesPage({
    state: { status: 'ready', courses: [UNIFICADA] }, itemsById: {}, selectedId: null,
    onOpen() {}, onClose() {}, onRetry() {}, onRetryItems() {}, onGo() {},
    ivirtualLink: { linked: true }, classroomConnected: true, now: NOW, ...props,
  }));
  const all = [];
  const walk = n => { if (Array.isArray(n)) return n.forEach(walk); if (n && typeof n === 'object') { all.push(n); walk(n.props?.children); } };
  walk(tree);
  const text = n => [n?.props?.children].flat(Infinity).map(c => (typeof c === 'string' || typeof c === 'number' ? String(c) : c && typeof c === 'object' ? text(c) : '')).join('');
  return { all, texto: text(tree), conFuente: tipo => all.filter(n => n.props?.['data-source'] && n.type === tipo) };
}

test('la lista muestra una sola tarjeta por materia unificada con los indicadores de sus fuentes', () => {
  const r = renderCourses({});
  const tarjetas = r.all.filter(n => n.type === 'li');
  assert.equal(tarjetas.length, 1);
  assert.deepEqual(r.conFuente('span').map(n => n.props['data-source']), ['ivirtual', 'classroom', 'itson_api']);
  assert.match(r.texto, /Ingeniería de Software/);
  assert.match(r.texto, /iVirtual.*Google Classroom.*API de ITSON/);
  // Una materia de una sola fuente conserva el texto de antes y no lleva indicadores.
  const sola = renderCourses({ state: { status: 'ready', courses: [COURSE_IT] } });
  assert.equal(sola.conFuente('span').length, 0);
  assert.match(sola.texto, /API de ITSON · Semestre 3/);
});

test('el detalle de una materia unificada tiene una sección por fuente con sus datos', () => {
  const entry = { status: 'ready', items: [ITEM_CR, ITEM_IV], updatedAt: UNIFICADA.updatedAt };
  const r = renderCourses({ selectedId: UNIFICADA.id, itemsById: { [UNIFICADA.id]: entry } });
  const secciones = r.conFuente('section');
  assert.deepEqual(secciones.map(s => s.props['data-source']), ['ivirtual', 'classroom', 'itson_api']);
  const textoDe = fuente => {
    const s = secciones.find(x => x.props['data-source'] === fuente);
    const partes = [];
    const walk = n => { if (Array.isArray(n)) return n.forEach(walk); if (typeof n === 'string') partes.push(n); else if (n && typeof n === 'object') walk(n.props?.children); };
    walk(s);
    return partes.join(' ');
  };
  assert.match(textoDe('ivirtual'), /Tarea iVirtual/);
  assert.match(textoDe('ivirtual'), /90/);
  assert.doesNotMatch(textoDe('ivirtual'), /Tarea Classroom/);
  assert.match(textoDe('classroom'), /Tarea Classroom/);
  assert.match(textoDe('itson_api'), /Semestre 5/);
  assert.match(textoDe('itson_api'), /9/);
});

test('el detalle omite las fuentes sin datos y conserva carga y error', () => {
  const soloIv = { status: 'ready', items: [ITEM_IV], updatedAt: UNIFICADA.updatedAt };
  const sinItson = { ...UNIFICADA, sources: UNIFICADA.sources.map(s => (s.source === 'itson_api' ? { ...s, finalGrade: null } : s)) };
  const r = renderCourses({ state: { status: 'ready', courses: [sinItson] }, selectedId: UNIFICADA.id, itemsById: { [UNIFICADA.id]: soloIv } });
  assert.deepEqual(r.conFuente('section').map(s => s.props['data-source']), ['ivirtual']);

  const cargando = renderCourses({ selectedId: UNIFICADA.id, itemsById: { [UNIFICADA.id]: { status: 'loading', items: [], updatedAt: UNIFICADA.updatedAt } } });
  assert.ok(cargando.all.some(n => n.props?.['aria-label'] === 'Cargando tareas'));
  assert.equal(cargando.conFuente('section').length, 0);

  const error = renderCourses({ selectedId: UNIFICADA.id, itemsById: { [UNIFICADA.id]: { status: 'error', items: [], updatedAt: UNIFICADA.updatedAt } } });
  assert.match(error.texto, /No pudimos cargar las tareas de esta materia/);
  // Con el error de tareas sigue a la vista la calificación de ITSON, que no depende de /items.
  assert.deepEqual(error.conFuente('section').map(s => s.props['data-source']), ['ivirtual', 'itson_api']);

  const vacia = { ...UNIFICADA, sources: UNIFICADA.sources.map(s => ({ ...s, finalGrade: null })) };
  const sinNada = renderCourses({ state: { status: 'ready', courses: [vacia] }, selectedId: UNIFICADA.id, itemsById: { [UNIFICADA.id]: { status: 'ready', items: [], updatedAt: UNIFICADA.updatedAt } } });
  assert.match(sinNada.texto, /Sin tareas ni calificaciones registradas/);
});

test('App pide /items de una materia unificada aunque su fuente principal sea ITSON', async () => {
  const principalItson = { ...COURSE_IT, sources: [{ source: 'itson_api', id: COURSE_IT.id, name: 'Cálculo', period: '03', finalGrade: '9', updatedAt: COURSE_IT.updatedAt },
    { source: 'classroom', id: COURSE_CR.id, name: 'Cálculo', period: null, finalGrade: null, updatedAt: COURSE_IT.updatedAt }] };
  const { h, calls, page } = await enMaterias({ courses: [principalItson], items: { [COURSE_IT.id]: [ITEM_CR] } });
  try {
    page().props.onOpen(COURSE_IT.id);
    await h.settle();
    assert.deepEqual(rutas(calls, '/api/courses/'), [`/api/courses/${COURSE_IT.id}/items`]);
    assert.deepEqual(page().props.itemsById[COURSE_IT.id].items, [ITEM_CR]);
  } finally { h.restore(); }
});
