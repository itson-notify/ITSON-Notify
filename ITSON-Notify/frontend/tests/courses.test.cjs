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

// Renderiza CoursesPage expandiendo sus componentes locales. ITN-58c - El único hook
// es el useState de CoursesPage (secciones abiertas); su estado se conserva entre
// render() para poder abrir y cerrar. `abiertas` abre secciones antes del primer render.
// Los componentes importados quedan como nodos con nombre ('Button', 'SkeletonList').
function renderCourses(props, { abiertas = [] } = {}) {
  const jsx = (type, p) => ({ type, props: p });
  const courses = compile('utils/courses.ts', require);
  let estado = Object.fromEntries(abiertas.map(id => [id, true]));
  const hooks = {
    useState: () => [estado, value => { estado = typeof value === 'function' ? value(estado) : value; }],
  };
  const { CoursesPage } = compile('pages/CoursesPage.tsx', id => {
    if (id === 'react') return hooks;
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
  const text = n => [n?.props?.children].flat(Infinity).map(c => (typeof c === 'string' || typeof c === 'number' ? String(c) : c && typeof c === 'object' ? text(c) : '')).join('');
  const render = () => {
    const tree = expand(CoursesPage({
      state: { status: 'ready', courses: [UNIFICADA] }, itemsById: {}, selectedId: null,
      onOpen() {}, onClose() {}, onRetry() {}, onRetryItems() {}, onGo() {},
      ivirtualLink: { linked: true }, classroomConnected: true, now: NOW, ...props,
    }));
    const all = [];
    const walk = n => { if (Array.isArray(n)) return n.forEach(walk); if (n && typeof n === 'object') { all.push(n); walk(n.props?.children); } };
    walk(tree);
    const seccion = id => all.find(n => n.props?.['data-collapsible'] === id);
    const boton = id => all.find(n => n.type === 'button' && n.props?.id === `${id}-titulo`);
    return {
      all, texto: text(tree), conFuente: tipo => all.filter(n => n.props?.['data-source'] && n.type === tipo),
      seccion, boton, textoDe: id => text(seccion(id)),
      // Encabezados plegables en orden de aparición.
      plegables: () => all.filter(n => n.props?.['data-collapsible']).map(n => n.props['data-collapsible']),
      toggle(id) { boton(id).props.onClick(); return render(); },
      render,
    };
  };
  return render();
}

test('la lista muestra una sola tarjeta por materia unificada con los indicadores de sus fuentes', () => {
  const r = renderCourses({}, { abiertas: ['fuente-ivirtual'] });
  assert.equal(r.all.filter(n => n.type === 'li').length, 1);
  assert.deepEqual(r.conFuente('span').map(n => n.props['data-source']), ['ivirtual', 'classroom', 'itson_api']);
  assert.match(r.texto, /Ingeniería de Software/);
  assert.match(r.texto, /iVirtual.*Google Classroom.*API de ITSON/);
  // Una materia de una sola fuente no lleva indicadores; la de ITSON sale en su semestre.
  const sola = renderCourses({ state: { status: 'ready', courses: [COURSE_IT] } }, { abiertas: ['fuente-itson_api', 'semestre-03'] });
  assert.equal(sola.conFuente('span').length, 0);
  assert.match(sola.texto, /API de ITSON 1/);
  assert.match(sola.textoDe('semestre-03'), /Semestre 3 · 1 materia.*Cálculo.*9/);
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
  // Con fuente Classroom no se afirma que no haya tareas: aún no se sincronizan.
  assert.match(sinNada.texto, /Las tareas de Google Classroom todavía no están disponibles en ITSON Notify/);
  assert.doesNotMatch(sinNada.texto, /Sin tareas ni calificaciones registradas/);
});

test('estado vacío del detalle: Classroom explica que sus tareas aún no llegan; sin Classroom es neutro', () => {
  assert.equal(U.emptyCourseNotice(COURSE_CR).body,
    'Las tareas de Google Classroom todavía no están disponibles en ITSON Notify. Consulta Classroom para revisar tus actividades y entregas pendientes.');
  assert.equal(U.emptyCourseNotice(UNIFICADA), U.CLASSROOM_TASKS_NOTICE);
  for (const curso of [COURSE_IV, COURSE_IT, { ...COURSE_IT, sources: [UNIFICADA.sources[0], UNIFICADA.sources[2]] }]) {
    const { title, body } = U.emptyCourseNotice(curso);
    assert.match(`${title} ${body}`, /sincronizad/);
    assert.doesNotMatch(`${title} ${body}`, /Classroom|no tiene|Sin tareas/);
  }

  // Materia de iVirtual sin actividades (detalle de una sola fuente): texto neutro.
  const iv = renderCourses({ state: { status: 'ready', courses: [COURSE_IV] }, selectedId: COURSE_IV.id, itemsById: { [COURSE_IV.id]: { status: 'ready', items: [], updatedAt: COURSE_IV.updatedAt } } });
  assert.match(iv.texto, /Aún no hay actividades sincronizadas/);

  // Unificada con datos de iVirtual pero sin tareas de Classroom: se aclara lo de Classroom.
  const soloIv = renderCourses({ selectedId: UNIFICADA.id, itemsById: { [UNIFICADA.id]: { status: 'ready', items: [ITEM_IV], updatedAt: UNIFICADA.updatedAt } } });
  assert.match(soloIv.texto, /Tareas de Classroom aún no disponibles/);
  const conCr = renderCourses({ selectedId: UNIFICADA.id, itemsById: { [UNIFICADA.id]: { status: 'ready', items: [ITEM_IV, ITEM_CR], updatedAt: UNIFICADA.updatedAt } } });
  assert.doesNotMatch(conCr.texto, /Tareas de Classroom aún no disponibles/);
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

// ── ITN-58c - Secciones plegables e historial de ITSON por semestre ──────────

const itsonCurso = (id, name, period, finalGrade) => ({ id, name, source: 'itson_api', period, finalGrade, updatedAt: '2026-11-18T09:00:00.000Z' });
const HISTORIAL = [
  UNIFICADA, // su fuente itson_api es del semestre 05
  COURSE_CR,
  itsonCurso('it-a', 'Álgebra', '01', '10'),
  itsonCurso('it-b', 'Redes', '08', null),
  itsonCurso('it-c', 'Compiladores', '08', '-'),
  itsonCurso('it-d', 'Ética', '10', 'A'),
];

test('utilidades: semestres de ITSON en orden descendente con las materias unificadas', () => {
  const sems = U.itsonSemesters(HISTORIAL);
  assert.deepEqual(sems.map(s => s.label), ['Semestre 10', 'Semestre 8', 'Semestre 5', 'Semestre 1']);
  assert.deepEqual(sems[1].courses.map(c => c.course.name), ['Compiladores', 'Redes']);
  // La unificada aparece con el nombre y el id de la materia y la calificación de ITSON.
  assert.deepEqual(sems[2].courses.map(c => [c.course.id, c.entry.finalGrade]), [[UNIFICADA.id, '9']]);
  // Classroom no entra; sin semestre va al final.
  assert.deepEqual(U.itsonSemesters([COURSE_CR]), []);
  assert.deepEqual(U.itsonSemesters([itsonCurso('x', 'X', null, '9'), itsonCurso('y', 'Y', '02', '9')]).map(s => s.label), ['Semestre 2', 'Sin semestre']);
});

test('utilidades: null y "-" son "Sin calificación"', () => {
  assert.equal(U.finalGradeLabel(null), 'Sin calificación');
  assert.equal(U.finalGradeLabel('-'), 'Sin calificación');
  assert.equal(U.finalGradeLabel(' - '), 'Sin calificación');
  assert.equal(U.finalGradeLabel(''), 'Sin calificación');
  assert.equal(U.finalGradeLabel('9'), '9');
  assert.equal(U.finalGradeLabel('A'), 'A');
  assert.equal(U.hasFinalGrade('-'), false);
});

test('las secciones por plataforma empiezan cerradas: solo el encabezado', () => {
  const r = renderCourses({ state: { status: 'ready', courses: HISTORIAL } });
  assert.deepEqual(r.plegables(), ['fuente-ivirtual', 'fuente-classroom', 'fuente-itson_api']);
  for (const id of r.plegables()) {
    const b = r.boton(id);
    assert.equal(b.props['aria-expanded'], false);
    assert.equal(b.props['aria-controls'], `${id}-contenido`);
    assert.equal(b.props.type, 'button');
    const region = r.all.find(n => n.props?.id === `${id}-contenido`);
    assert.equal(region.props.hidden, true);
    assert.equal(region.props.children, false);
  }
  assert.equal(r.all.filter(n => n.type === 'li').length, 0);
  // Encabezado con nombre y conteo; ITSON cuenta todas sus materias (también la unificada).
  assert.match(r.textoDe('fuente-ivirtual'), /^iVirtual 1/);
  assert.match(r.textoDe('fuente-classroom'), /^Google Classroom 1/);
  assert.match(r.textoDe('fuente-itson_api'), /^API de ITSON 5/);
  assert.doesNotMatch(r.texto, /Semestre|Redes|Álgebra/);
});

test('abrir y cerrar una sección y un semestre', () => {
  let r = renderCourses({ state: { status: 'ready', courses: HISTORIAL } });
  r = r.toggle('fuente-classroom');
  assert.equal(r.boton('fuente-classroom').props['aria-expanded'], true);
  assert.equal(r.all.find(n => n.props?.id === 'fuente-classroom-contenido').props.hidden, false);
  assert.match(r.textoDe('fuente-classroom'), /IA/);
  assert.equal(r.boton('fuente-ivirtual').props['aria-expanded'], false);
  r = r.toggle('fuente-classroom');
  assert.equal(r.boton('fuente-classroom').props['aria-expanded'], false);
  assert.doesNotMatch(r.textoDe('fuente-classroom'), /IA/);

  // Al abrir ITSON salen los semestres, todos cerrados.
  r = r.toggle('fuente-itson_api');
  assert.deepEqual(r.plegables().filter(id => id.startsWith('semestre-')), ['semestre-10', 'semestre-08', 'semestre-05', 'semestre-01']);
  assert.ok(r.plegables().filter(id => id.startsWith('semestre-')).every(id => r.boton(id).props['aria-expanded'] === false));
  assert.match(r.textoDe('fuente-itson_api'), /Semestre 10 · 1 materia.*Semestre 8 · 2 materias.*Semestre 5 · 1 materia.*Semestre 1 · 1 materia/);
  assert.doesNotMatch(r.texto, /Compiladores/);

  r = r.toggle('semestre-08');
  assert.equal(r.boton('semestre-08').props['aria-expanded'], true);
  assert.match(r.textoDe('semestre-08'), /Compiladores.*Sin calificación.*Redes.*Sin calificación/);
  assert.doesNotMatch(r.textoDe('semestre-08'), /-/);
  r = r.toggle('semestre-05');
  assert.match(r.textoDe('semestre-05'), /Ingeniería de Software.*9/);
  r = r.toggle('semestre-08');
  assert.doesNotMatch(r.texto, /Compiladores/);
  // Cerrar la sección de ITSON oculta todo su historial.
  r = r.toggle('fuente-itson_api');
  assert.doesNotMatch(r.texto, /Semestre|Ingeniería de Software/);
});

test('una materia del historial abre su detalle (también la unificada)', () => {
  const abiertas = [];
  const r = renderCourses({ state: { status: 'ready', courses: HISTORIAL }, onOpen: id => abiertas.push(id) }, { abiertas: ['fuente-itson_api', 'semestre-05', 'semestre-08'] });
  const filas = r.all.filter(n => n.type === 'button' && n.props.onClick && !n.props.id);
  filas.forEach(f => f.props.onClick());
  // Semestre 8 (Compiladores, Redes) va antes que el 5 (la unificada, con su propio id).
  assert.deepEqual(abiertas, ['it-c', 'it-b', UNIFICADA.id]);
});

test('el detalle de una unificada muestra semestre y calificación de ITSON; "-" no cuenta', () => {
  const entry = { status: 'ready', items: [ITEM_IV], updatedAt: UNIFICADA.updatedAt };
  const r = renderCourses({ selectedId: UNIFICADA.id, itemsById: { [UNIFICADA.id]: entry } });
  const itson = r.conFuente('section').find(s => s.props['data-source'] === 'itson_api');
  assert.ok(itson);
  const guion = { ...UNIFICADA, sources: UNIFICADA.sources.map(s => (s.source === 'itson_api' ? { ...s, finalGrade: '-' } : s)) };
  const sinItson = renderCourses({ state: { status: 'ready', courses: [guion] }, selectedId: UNIFICADA.id, itemsById: { [UNIFICADA.id]: entry } });
  assert.deepEqual(sinItson.conFuente('section').map(s => s.props['data-source']), ['ivirtual']);
});

test('con VITE_USE_MOCK=true el historial de ITSON trae dos semestres con materias sin calificación', () => {
  const env = { VITE_USE_MOCK: 'true' };
  const mock = compile('services/mockData.ts', require, env);
  const sems = U.itsonSemesters(mock.MOCK_COURSES);
  assert.deepEqual(sems.map(s => s.label), ['Semestre 6', 'Semestre 5']);
  const grados = sems.flatMap(s => s.courses.map(c => U.finalGradeLabel(c.entry.finalGrade)));
  assert.ok(grados.includes('Sin calificación'));
  assert.ok(sems[0].courses.some(c => c.course.sources?.length > 1), 'incluye la materia unificada');
  for (const c of mock.MOCK_COURSES) assert.ok(Array.isArray(mock.MOCK_COURSE_ITEMS[c.id]), c.id);
});

// ── ITN-58d - Materias fuera del plan de estudios ───────────────────────────

const ANTERIOR_ARCH = { id: '44444444-4444-4444-8444-444444444444', name: 'Taller Antiguo Inventado', source: 'classroom', period: 'Grupo A', finalGrade: null, updatedAt: '2026-11-18T10:00:00.000Z', scope: 'anterior' };
const ANTERIOR_VIEJO = { id: '55555555-5555-4555-8555-555555555555', name: 'Precálculo Inventado', source: 'classroom', period: null, finalGrade: null, updatedAt: '2026-11-18T10:00:00.000Z', scope: 'anterior' };
const ITEM_VIEJO = { id: 'old1', label: 'Guía inventada de 2023', grade: null, maxGrade: 10, dueAt: '2023-03-10T06:59:00.000Z', kind: 'classroom', source: 'classroom' };
const CON_ANTERIORES = [...HISTORIAL.map(c => ({ ...c, scope: 'actual' })), ANTERIOR_ARCH, ANTERIOR_VIEJO];

test('utilidades: splitByScope separa las anteriores; sin scope cuenta como actual', () => {
  const { current, past } = U.splitByScope([COURSE_IV, ANTERIOR_ARCH, { ...COURSE_CR, scope: 'actual' }, ANTERIOR_VIEJO]);
  assert.deepEqual(current.map(c => c.id), [COURSE_IV.id, COURSE_CR.id]);
  assert.deepEqual(past.map(c => c.id), [ANTERIOR_ARCH.id, ANTERIOR_VIEJO.id]);
  assert.equal(U.isPastCourse(COURSE_CR), false);
});

test('g) sin materias anteriores no aparece la sección "Fuera del plan de estudios"', () => {
  for (const courses of [HISTORIAL, HISTORIAL.map(c => ({ ...c, scope: 'actual' }))]) {
    const r = renderCourses({ state: { status: 'ready', courses } });
    assert.equal(r.seccion('fuera-del-plan'), undefined);
    assert.doesNotMatch(r.texto, /Fuera del plan/);
  }
});

test('g) la sección va al final, empieza cerrada, con su contador, y las anteriores salen solo ahí', () => {
  let r = renderCourses({ state: { status: 'ready', courses: CON_ANTERIORES } });
  assert.deepEqual(r.plegables(), ['fuente-ivirtual', 'fuente-classroom', 'fuente-itson_api', 'fuera-del-plan']);
  const b = r.boton('fuera-del-plan');
  assert.equal(b.props['aria-expanded'], false);
  assert.equal(b.props['aria-controls'], 'fuera-del-plan-contenido');
  assert.equal(r.all.find(n => n.props?.id === 'fuera-del-plan-contenido').props.hidden, true);
  assert.match(r.textoDe('fuera-del-plan'), /^Fuera del plan de estudios \(2\)/);
  // Google Classroom sigue contando solo su materia actual.
  assert.match(r.textoDe('fuente-classroom'), /^Google Classroom 1/);
  assert.doesNotMatch(r.texto, /Taller Antiguo|Precálculo Inventado|no coinciden/);

  r = r.toggle('fuente-classroom');
  assert.doesNotMatch(r.textoDe('fuente-classroom'), /Taller Antiguo|Precálculo Inventado/);

  r = r.toggle('fuera-del-plan');
  assert.equal(r.boton('fuera-del-plan').props['aria-expanded'], true);
  assert.match(r.textoDe('fuera-del-plan'), /Cursos de Classroom que no coinciden con tu semestre actual\..*Taller Antiguo Inventado.*Precálculo Inventado/);
  r = r.toggle('fuera-del-plan');
  assert.doesNotMatch(r.texto, /Taller Antiguo/);
});

test('g) abrir una materia anterior muestra su detalle con sus tareas', () => {
  const abiertas = [];
  const r = renderCourses({ state: { status: 'ready', courses: CON_ANTERIORES }, onOpen: id => abiertas.push(id) }, { abiertas: ['fuera-del-plan'] });
  const filas = r.all.filter(n => n.type === 'button' && n.props.onClick && !n.props.id);
  filas.forEach(f => f.props.onClick());
  assert.deepEqual(abiertas, [ANTERIOR_ARCH.id, ANTERIOR_VIEJO.id]);

  const detalle = renderCourses({
    state: { status: 'ready', courses: CON_ANTERIORES }, selectedId: ANTERIOR_VIEJO.id,
    itemsById: { [ANTERIOR_VIEJO.id]: { status: 'ready', items: [ITEM_VIEJO], updatedAt: ANTERIOR_VIEJO.updatedAt } },
  });
  assert.match(detalle.texto, /Precálculo Inventado/);
  assert.match(detalle.texto, /Guía inventada de 2023/);
  assert.match(detalle.texto, /Vencida/);
});

test('g) App pide las tareas de una materia anterior al abrirla', async () => {
  const b = backend({ courses: [COURSE_IV, ANTERIOR_VIEJO], items: { [ANTERIOR_VIEJO.id]: [ITEM_VIEJO] } });
  const h = harness('', b.fetchImpl, { useMock: false });
  try {
    await h.start();
    find(h.render(), 'AppLayout').props.onGo('materias');
    await h.settle();
    const page = () => find(h.render(), 'CoursesPage');
    assert.equal(page().props.state.courses.find(c => c.id === ANTERIOR_VIEJO.id).scope, 'anterior');
    page().props.onOpen(ANTERIOR_VIEJO.id);
    await h.settle();
    assert.equal(page().props.itemsById[ANTERIOR_VIEJO.id].status, 'ready');
    assert.deepEqual(page().props.itemsById[ANTERIOR_VIEJO.id].items.map(i => i.id), ['old1']);
    assert.ok(b.calls.some(c => c.ruta === `/api/courses/${ANTERIOR_VIEJO.id}/items`));
  } finally { h.restore(); }
});

test('con VITE_USE_MOCK=true hay cursos de Classroom fuera del plan (archivado y antiguo) con detalle', () => {
  const mock = compile('services/mockData.ts', require, { VITE_USE_MOCK: 'true' });
  const { past } = U.splitByScope(mock.MOCK_COURSES);
  assert.ok(past.length >= 2);
  assert.ok(past.every(c => c.source === 'classroom'));
  assert.ok(past.some(c => mock.MOCK_COURSE_ITEMS[c.id].length > 0), 'una anterior con tareas');
});

// ── ITN-58f - Estado de entrega de Classroom ───────────────────────────────

const tareaCr = (id, dueAt, submission, grade = null) => ({ id, label: id, grade, maxGrade: 100, dueAt, kind: 'classroom', source: 'classroom',
  ...(submission === undefined ? {} : { submission }) });
const PASADA = '2026-11-10T06:59:00.000Z';
const FUTURA = '2026-11-25T06:59:00.000Z';

test('classifyItem con estado de entrega: TURNED_IN y RETURNED son entregada; el resto, por fecha', () => {
  for (const state of ['TURNED_IN', 'RETURNED']) {
    assert.equal(U.classifyItem(tareaCr('e', PASADA, { state, late: false }), NOW), 'entregada', `${state} vencida`);
    assert.equal(U.classifyItem(tareaCr('e', FUTURA, { state, late: true }), NOW), 'entregada', `${state} futura`);
    assert.equal(U.classifyItem(tareaCr('e', null, { state, late: false }), NOW), 'entregada', `${state} sin fecha`);
  }
  for (const state of ['NEW', 'CREATED', 'RECLAIMED_BY_STUDENT', 'SUBMISSION_STATE_UNSPECIFIED', 'turned_in', '']) {
    assert.equal(U.classifyItem(tareaCr('n', PASADA, { state, late: false }), NOW), 'vencida', `${state || 'vacío'} no cuenta como entregada`);
    assert.equal(U.classifyItem(tareaCr('n', FUTURA, { state, late: false }), NOW), 'proxima');
    assert.equal(U.classifyItem(tareaCr('n', null, { state, late: false }), NOW), 'sin_fecha');
  }
  // Sin submission (ausente o null) se queda como hoy.
  assert.equal(U.classifyItem(tareaCr('x', PASADA), NOW), 'vencida');
  assert.equal(U.classifyItem(tareaCr('x', PASADA, null), NOW), 'vencida');
  // Nota + entregada = calificada (también un 0).
  assert.equal(U.classifyItem(tareaCr('c', PASADA, { state: 'RETURNED', late: true }, 95), NOW), 'calificada');
  assert.equal(U.classifyItem(tareaCr('c0', PASADA, { state: 'TURNED_IN', late: false }, 0), NOW), 'calificada');
});

test('isLateSubmission solo aplica a entregas reales con late true', () => {
  assert.equal(U.isLateSubmission(tareaCr('a', PASADA, { state: 'TURNED_IN', late: true })), true);
  assert.equal(U.isLateSubmission(tareaCr('b', PASADA, { state: 'TURNED_IN', late: false })), false);
  assert.equal(U.isLateSubmission(tareaCr('c', PASADA, { state: 'RECLAIMED_BY_STUDENT', late: true })), false);
  assert.equal(U.isLateSubmission(tareaCr('d', PASADA)), false);
});

test('grupos en orden Vencidas, Próximas, Entregadas, Calificadas, Sin fecha', () => {
  assert.deepEqual(U.STATUS_ORDER, ['vencida', 'proxima', 'entregada', 'calificada', 'sin_fecha']);
  const groups = U.groupItems([item('s', null), tareaCr('e2', FUTURA, { state: 'RETURNED', late: false }),
    item('c', '2026-11-01T00:00:00.000Z', 90), tareaCr('e1', PASADA, { state: 'TURNED_IN', late: true }),
    item('p', '2026-11-25T00:00:00.000Z'), tareaCr('v', PASADA, { state: 'RECLAIMED_BY_STUDENT', late: false })], NOW);
  assert.deepEqual(groups.map(g => [g.status, g.items.map(i => i.id)]),
    [['vencida', ['v']], ['proxima', ['p']], ['entregada', ['e1', 'e2']], ['calificada', ['c']], ['sin_fecha', ['s']]]);
});

test('iVirtual no cambia: sus items se clasifican igual aunque traigan una llave submission', () => {
  const conEntrega = i => ({ ...i, submission: { state: 'TURNED_IN', late: true } });
  const iv = [item('v', PASADA), item('p', FUTURA), item('c', PASADA, 80), item('s', null)].map(conEntrega);
  const antes = iv.map(i => U.classifyItem(i, NOW));
  assert.deepEqual(antes, ['vencida', 'proxima', 'calificada', 'sin_fecha']);
  assert.equal(U.groupItems(iv, NOW).some(g => g.status === 'entregada'), false);
});

test('el detalle de Classroom muestra el grupo Entregadas, la etiqueta de retraso y el aviso nuevo', () => {
  const items = [tareaCr('Tarea a tiempo', PASADA, { state: 'TURNED_IN', late: false }),
    tareaCr('Tarea tarde', PASADA, { state: 'RETURNED', late: true }),
    tareaCr('Tarea retirada', PASADA, { state: 'RECLAIMED_BY_STUDENT', late: true })];
  const r = renderCourses({ state: { status: 'ready', courses: [COURSE_CR] }, selectedId: COURSE_CR.id,
    itemsById: { [COURSE_CR.id]: { status: 'ready', items, updatedAt: COURSE_CR.updatedAt } } });
  const secciones = r.all.filter(n => n.type === 'section' && n.props?.['aria-labelledby']?.startsWith('grupo-'));
  assert.deepEqual(secciones.map(s => s.props['aria-labelledby']), ['grupo-vencida', 'grupo-entregada']);
  const tags = r.all.filter(n => n.props?.['data-status']);
  const textoTag = n => [n.props.children].flat(Infinity).filter(c => typeof c === 'string').join('');
  assert.deepEqual(tags.map(n => [n.props['data-status'], textoTag(n)]),
    [['vencida', 'Vencida'], ['entregada', 'Entregada'], ['entregada', 'Entregada con retraso']]);
  // Estilo sobrio: el grupo Entregadas no usa el rojo de Vencidas.
  const entregada = tags.find(n => n.props['data-status'] === 'entregada');
  assert.doesNotMatch(entregada.props.className, /B91C1C|FEF2F2|FECACA/);
  assert.match(r.texto, /Entregadas/);
  assert.match(r.texto, /El estado de entrega se actualiza con cada sincronización con Google Classroom\. Si una tarea aún no muestra su estado, puede tardar en aparecer\./);
  assert.doesNotMatch(r.texto, /no nos dice si ya entregaste/);
});

test('el detalle de iVirtual no muestra el aviso de entregas de Classroom ni el grupo Entregadas', () => {
  const r = renderCourses({ state: { status: 'ready', courses: [COURSE_IV] }, selectedId: COURSE_IV.id,
    itemsById: { [COURSE_IV.id]: { status: 'ready', items: [item('a', PASADA), item('b', PASADA, 70)], updatedAt: COURSE_IV.updatedAt } } });
  assert.doesNotMatch(r.texto, /Entregadas|estado de entrega/);
  assert.deepEqual(r.all.filter(n => n.props?.['data-status']).map(n => n.props['data-status']), ['vencida', 'calificada']);
});

test('mockData trae tareas de Classroom con entrega a tiempo, con retraso, retirada y sin estado', () => {
  const mock = compile('services/mockData.ts', require);
  const tareas = mock.MOCK_COURSE_ITEMS['mock-classroom-1'];
  const estados = tareas.map(t => U.classifyItem(t, Date.now()));
  assert.ok(estados.filter(e => e === 'entregada').length >= 2);
  assert.ok(tareas.some(t => U.isLateSubmission(t)));
  assert.ok(tareas.some(t => t.submission?.state === 'RECLAIMED_BY_STUDENT' && U.classifyItem(t, Date.now()) === 'vencida'));
  assert.ok(tareas.some(t => !('submission' in t)));
});

// ── ITN-58e - Enlace a la tarea en Google Classroom ─────────────────────────

const ENLACE_CR = 'https://classroom.google.com/c/MTIz/a/NDU2/details';
const tareaCrUrl = (id, url) => ({ id, label: `Tarea ${id}`, grade: null, maxGrade: 10, dueAt: '2026-11-25T06:59:00.000Z', kind: 'classroom', source: 'classroom', url });

test('utilidades: safeItemUrl solo acepta https sin credenciales', () => {
  const U = compile('utils/courses.ts', require);
  assert.equal(U.safeItemUrl(ENLACE_CR), ENLACE_CR);
  for (const malo of [
    'http://classroom.google.com/c/1', 'javascript:alert(1)', 'data:text/html,hola', '', '   ',
    'https://usuario:clave@classroom.google.com/c/1', '/c/1', 'no es url', null, undefined, 42, {},
  ]) {
    assert.equal(U.safeItemUrl(malo), null, String(malo));
  }
});

test('detalle: tarea de Classroom con url es un enlace a una pestaña nueva; sin url o no https, no', () => {
  const items = [
    tareaCrUrl('con-url', ENLACE_CR),
    tareaCrUrl('sin-url', null),
    tareaCrUrl('sin-campo', undefined),
    tareaCrUrl('http', 'http://classroom.google.com/c/1/a/2/details'),
    tareaCrUrl('script', 'javascript:alert(1)'),
  ];
  const r = renderCourses({
    state: { status: 'ready', courses: [COURSE_CR] }, selectedId: COURSE_CR.id,
    itemsById: { [COURSE_CR.id]: { status: 'ready', items, updatedAt: COURSE_CR.updatedAt } },
  });
  const enlaces = r.all.filter(n => n.type === 'a');
  assert.equal(enlaces.length, 1);
  const [a] = enlaces;
  assert.equal(a.props.href, ENLACE_CR);
  assert.equal(a.props.target, '_blank');
  assert.equal(a.props.rel, 'noopener noreferrer');
  const textoEnlace = [a].flatMap(function t(n) { return [n?.props?.children].flat(Infinity).flatMap(c => (typeof c === 'string' ? [c] : c && typeof c === 'object' ? t(c) : [])); }).join('');
  assert.match(textoEnlace, /Tarea con-url/);
  assert.match(textoEnlace, /Abrir en Classroom/);
  assert.match(textoEnlace, /se abre en una pestaña nueva/);
  for (const otra of ['sin-url', 'sin-campo', 'http', 'script']) assert.match(r.texto, new RegExp(`Tarea ${otra}`));
  assert.equal((r.texto.match(/Abrir en Classroom/g) ?? []).length, 1);
  assert.doesNotMatch(JSON.stringify(r.all.map(n => n.props?.href ?? null)), /javascript:|http:\/\//);
});

test('detalle: los items de iVirtual nunca son enlace, aunque traigan url', () => {
  const r = renderCourses({
    state: { status: 'ready', courses: [COURSE_IV] }, selectedId: COURSE_IV.id,
    itemsById: { [COURSE_IV.id]: { status: 'ready', items: [{ ...ITEM, url: ENLACE_CR }], updatedAt: COURSE_IV.updatedAt } },
  });
  assert.equal(r.all.filter(n => n.type === 'a').length, 0);
  assert.match(r.texto, /Práctica 1/);
});

test('detalle de Classroom: combina enlace a Classroom (58e) con estado de entrega y aviso de sincronización (58f)', () => {
  const r = renderCourses({
    state: { status: 'ready', courses: [COURSE_CR] }, selectedId: COURSE_CR.id,
    itemsById: { [COURSE_CR.id]: { status: 'ready', items: [{ ...tareaCrUrl('a', ENLACE_CR), submission: { state: 'RETURNED', late: true } }], updatedAt: COURSE_CR.updatedAt } },
  });
  assert.equal(r.all.filter(n => n.type === 'a').length, 1);
  assert.match(r.texto, /Abrir en Classroom/);
  assert.match(r.texto, /Entregada con retraso/);
  assert.match(r.texto, /El estado de entrega se actualiza con cada sincronización con Google Classroom\. Si una tarea aún no muestra su estado, puede tardar en aparecer\./);
  assert.doesNotMatch(r.texto, /no nos dice|pronto|próximamente/i);
});

test('con VITE_USE_MOCK=true hay una tarea de Classroom con enlace válido', () => {
  const U = compile('utils/courses.ts', require);
  const mock = compile('services/mockData.ts', require, { VITE_USE_MOCK: 'true' });
  const conUrl = Object.values(mock.MOCK_COURSE_ITEMS).flat().filter(i => i.url);
  assert.ok(conUrl.length > 0);
  assert.ok(conUrl.every(i => i.kind === 'classroom' && U.safeItemUrl(i.url) === i.url));
});

// ── ITN-58e - safeItemUrl igual al backend (solo classroom.google.com) ──────

test('utilidades: safeItemUrl solo acepta https://classroom.google.com, como el backend', () => {
  const U = compile('utils/courses.ts', require);
  assert.equal(U.safeItemUrl(ENLACE_CR), ENLACE_CR);
  assert.equal(U.safeItemUrl('https://classroom.google.com/u/0/c/MTIz/a/NDU2/details'), 'https://classroom.google.com/u/0/c/MTIz/a/NDU2/details');
  for (const malo of [
    'https://example.com/c/1/a/2/details',
    'https://classroom.google.com.evil.com/c/1/a/2/details',
    'https://evil.com/classroom.google.com',
    'https://evilclassroom.google.com/c/1',
    'https://docs.google.com/c/1',
    'https://usuario:clave@classroom.google.com/c/1',
    'https://usuario@classroom.google.com/c/1',
    'https://classroom.google.com:8443/c/1',
    'http://classroom.google.com/c/1',
    'javascript:alert(1)',
    'data:text/html,hola',
    '', '   ', null, undefined, 42, {}, [], true,
    `https://classroom.google.com/${'a'.repeat(3000)}`,
  ]) {
    assert.equal(U.safeItemUrl(malo), null, String(malo).slice(0, 80));
  }
});

test('detalle: una tarea de Classroom con url https de otro dominio se muestra sin enlace', () => {
  const items = [
    tareaCrUrl('otro-dominio', 'https://example.com/c/1/a/2/details'),
    tareaCrUrl('subdominio-falso', 'https://classroom.google.com.evil.com/c/1'),
    tareaCrUrl('ruta-engañosa', 'https://evil.com/classroom.google.com'),
  ];
  const r = renderCourses({
    state: { status: 'ready', courses: [COURSE_CR] }, selectedId: COURSE_CR.id,
    itemsById: { [COURSE_CR.id]: { status: 'ready', items, updatedAt: COURSE_CR.updatedAt } },
  });
  assert.equal(r.all.filter(n => n.type === 'a').length, 0);
  assert.doesNotMatch(r.texto, /Abrir en Classroom/);
  for (const i of items) assert.match(r.texto, new RegExp(i.label));
  assert.doesNotMatch(JSON.stringify(r.all.map(n => n.props?.href ?? null)), /example\.com|evil\.com/);
});

// ── ITN-58g - Enlace "Abrir en iVirtual" a nivel de materia ─────────────────

const ENLACE_IV = 'https://ivirtual.itson.edu.mx/course/view.php?id=12345';
const textoDeNodo = n => [n?.props?.children].flat(Infinity).map(c => (typeof c === 'string' ? c : c && typeof c === 'object' ? textoDeNodo(c) : '')).join('');
const enlacesIvirtual = r => r.all.filter(n => n.type === 'a' && /Abrir en iVirtual/.test(textoDeNodo(n)));

test('utilidades: safeIvirtualUrl solo acepta https://ivirtual.itson.edu.mx/course/view.php?id=N', () => {
  const U = compile('utils/courses.ts', require);
  assert.equal(U.safeIvirtualUrl(ENLACE_IV), ENLACE_IV);
  assert.equal(U.safeIvirtualUrl('https://ivirtual.itson.edu.mx/course/view.php?id=1'), 'https://ivirtual.itson.edu.mx/course/view.php?id=1');
  assert.equal(U.safeIvirtualUrl('https://ivirtual.itson.edu.mx/course/view.php?id=9999999999'), 'https://ivirtual.itson.edu.mx/course/view.php?id=9999999999');
  for (const malo of [
    'https://ivirtual.itson.edu.mx.evil.com/course/view.php?id=12345',
    'https://evil.com/ivirtual.itson.edu.mx/course/view.php?id=12345',
    'https://evil.com/course/view.php?id=12345',
    'https://evilivirtual.itson.edu.mx/course/view.php?id=12345',
    'https://itson.edu.mx/course/view.php?id=12345',
    'http://ivirtual.itson.edu.mx/course/view.php?id=12345',
    'https://ivirtual.itson.edu.mx:8443/course/view.php?id=12345',
    'https://usuario:clave@ivirtual.itson.edu.mx/course/view.php?id=12345',
    'https://usuario@ivirtual.itson.edu.mx/course/view.php?id=12345',
    'https://ivirtual.itson.edu.mx/mod/assign/view.php?id=12345',
    'https://ivirtual.itson.edu.mx/course/view.php/x?id=12345',
    'https://ivirtual.itson.edu.mx/',
    'https://ivirtual.itson.edu.mx/course/view.php',
    'https://ivirtual.itson.edu.mx/course/view.php?id=12345&section=2',
    'https://ivirtual.itson.edu.mx/course/view.php?section=2&id=12345',
    'https://ivirtual.itson.edu.mx/course/view.php?id=12345&id=6',
    'https://ivirtual.itson.edu.mx/course/view.php?x=12345',
    'https://ivirtual.itson.edu.mx/course/view.php?id=abc',
    'https://ivirtual.itson.edu.mx/course/view.php?id=0',
    'https://ivirtual.itson.edu.mx/course/view.php?id=-5',
    'https://ivirtual.itson.edu.mx/course/view.php?id=',
    'https://ivirtual.itson.edu.mx/course/view.php?id=12345678901',
    'https://ivirtual.itson.edu.mx/course/view.php?id=12345#x',
    'javascript:alert(1)',
    'JavaScript:alert("ivirtual.itson.edu.mx/course/view.php?id=1")',
    'data:text/html,hola',
    '/course/view.php?id=12345',
    '', '   ', null, undefined, 42, {}, [], true,
    `https://ivirtual.itson.edu.mx/course/view.php?id=1${'0'.repeat(3000)}`,
  ]) {
    assert.equal(U.safeIvirtualUrl(malo), null, String(malo).slice(0, 80));
  }
});

test('detalle de materia de iVirtual: enlace "Abrir en iVirtual" a pestaña nueva, accesible', () => {
  const curso = { ...COURSE_IV, ivirtualUrl: ENLACE_IV };
  const r = renderCourses({
    state: { status: 'ready', courses: [curso] }, selectedId: curso.id,
    itemsById: { [curso.id]: { status: 'ready', items: [ITEM], updatedAt: curso.updatedAt } },
  });
  const enlaces = enlacesIvirtual(r);
  assert.equal(enlaces.length, 1);
  const [a] = enlaces;
  assert.equal(a.props.href, ENLACE_IV);
  assert.equal(a.props.target, '_blank');
  assert.equal(a.props.rel, 'noopener noreferrer');
  assert.equal(textoDeNodo(a), 'Abrir en iVirtual (se abre en una pestaña nueva)');
  assert.ok(a.props.children.some(c => c?.type === 'span' && /sr-only/.test(c.props.className)));
  // Los items de iVirtual siguen sin enlace (eso necesita el cmid).
  assert.equal(r.all.filter(n => n.type === 'a').length, 1);
});

test('detalle de iVirtual sin enlace o con enlace inválido no muestra nada', () => {
  for (const ivirtualUrl of [undefined, null, '', 'https://evil.com/course/view.php?id=1', 'javascript:alert(1)', 'http://ivirtual.itson.edu.mx/course/view.php?id=1']) {
    const curso = { ...COURSE_IV, ivirtualUrl };
    const r = renderCourses({
      state: { status: 'ready', courses: [curso] }, selectedId: curso.id,
      itemsById: { [curso.id]: { status: 'ready', items: [ITEM], updatedAt: curso.updatedAt } },
    });
    assert.equal(r.all.filter(n => n.type === 'a').length, 0, String(ivirtualUrl));
    assert.doesNotMatch(r.texto, /Abrir en iVirtual/);
  }
});

test('materias de Classroom o de la API de ITSON no muestran enlace a iVirtual, aunque traigan ivirtualUrl', () => {
  for (const base of [COURSE_CR, COURSE_IT]) {
    const curso = { ...base, ivirtualUrl: ENLACE_IV };
    const r = renderCourses({
      state: { status: 'ready', courses: [curso] }, selectedId: curso.id,
      itemsById: { [curso.id]: { status: 'ready', items: [], updatedAt: curso.updatedAt } },
    });
    assert.doesNotMatch(r.texto, /Abrir en iVirtual/, base.source);
    assert.equal(enlacesIvirtual(r).length, 0);
  }
  const U = compile('utils/courses.ts', require);
  assert.equal(U.courseIvirtualUrl({ ...COURSE_CR, ivirtualUrl: ENLACE_IV }), null);
  assert.equal(U.courseIvirtualUrl({ ...COURSE_IT, ivirtualUrl: ENLACE_IV }), null);
  assert.equal(U.courseIvirtualUrl({ ...COURSE_IV, ivirtualUrl: ENLACE_IV }), ENLACE_IV);
});

test('materia unificada: el enlace va en la sección de iVirtual, una sola vez; Classroom e ITSON no lo llevan', () => {
  const curso = { ...UNIFICADA, ivirtualUrl: ENLACE_IV };
  const r = renderCourses({
    state: { status: 'ready', courses: [curso] }, selectedId: curso.id,
    itemsById: { [curso.id]: { status: 'ready', items: [ITEM_IV, ITEM_CR], updatedAt: curso.updatedAt } },
  });
  assert.equal(enlacesIvirtual(r).length, 1);
  const seccion = fuente => r.all.find(n => n.type === 'section' && n.props['data-source'] === fuente);
  assert.match(textoDeNodo(seccion('ivirtual')), /Abrir en iVirtual/);
  assert.doesNotMatch(textoDeNodo(seccion('classroom')), /Abrir en iVirtual/);
  assert.doesNotMatch(textoDeNodo(seccion('itson_api')), /Abrir en iVirtual/);
});

test('materia unificada sin sección de iVirtual (sin tareas ni nota): el enlace sale bajo el encabezado', () => {
  const sinNota = { ...UNIFICADA, finalGrade: null, ivirtualUrl: ENLACE_IV,
    sources: [{ ...UNIFICADA.sources[0], finalGrade: null }, UNIFICADA.sources[1]] };
  const r = renderCourses({
    state: { status: 'ready', courses: [sinNota] }, selectedId: sinNota.id,
    itemsById: { [sinNota.id]: { status: 'ready', items: [ITEM_CR], updatedAt: sinNota.updatedAt } },
  });
  assert.equal(r.all.some(n => n.type === 'section' && n.props['data-source'] === 'ivirtual'), false);
  assert.equal(enlacesIvirtual(r).length, 1);
  // Mientras cargan las tareas no se muestra (después decide si va en la sección).
  const cargando = renderCourses({
    state: { status: 'ready', courses: [sinNota] }, selectedId: sinNota.id,
    itemsById: { [sinNota.id]: { status: 'loading' } },
  });
  assert.equal(enlacesIvirtual(cargando).length, 0);
});

test('materia unificada Classroom + ITSON (sin iVirtual) no muestra enlace aunque traiga ivirtualUrl', () => {
  const curso = { ...COURSE_CR, ivirtualUrl: ENLACE_IV, sources: [UNIFICADA.sources[1], UNIFICADA.sources[2]] };
  const r = renderCourses({
    state: { status: 'ready', courses: [curso] }, selectedId: curso.id,
    itemsById: { [curso.id]: { status: 'ready', items: [ITEM_CR], updatedAt: curso.updatedAt } },
  });
  assert.doesNotMatch(r.texto, /Abrir en iVirtual/);
});

test('con VITE_USE_MOCK=true hay materias de iVirtual con enlace válido y ninguna de otra fuente lo trae', () => {
  const U = compile('utils/courses.ts', require);
  const mock = compile('services/mockData.ts', require, { VITE_USE_MOCK: 'true' });
  const conUrl = mock.MOCK_COURSES.filter(c => c.ivirtualUrl);
  assert.ok(conUrl.length > 0);
  for (const c of conUrl) assert.equal(U.courseIvirtualUrl(c), c.ivirtualUrl);
  assert.ok(mock.MOCK_COURSES.filter(c => !U.courseSources(c).some(s => s.source === 'ivirtual')).every(c => c.ivirtualUrl === undefined));
});
