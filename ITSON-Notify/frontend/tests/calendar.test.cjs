// ITN-61: cliente de /api/calendar, utilidades de calendar.ts y la pantalla Calendario en App.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { compile, compileCalendar, harness, find } = require('./harness.cjs');

const json = (body, status = 200) => ({ ok: status < 400, status, json: async () => body });

// Eventos de prueba con la forma del contrato de ITN-60 (inventados).
const ev = (id, { title = id, allDay = true, startDate, endDate = startDate, startsAt, endsAt, category = 'Registro Escolar', description = null } = {}) => ({
  id, title, description, category, allDay, startDate, endDate,
  // Todo el día: 00:00 – 23:59:59 en Hermosillo (UTC-7).
  startsAt: startsAt ?? `${startDate}T07:00:00.000Z`,
  endsAt: endsAt ?? new Date(Date.parse(`${endDate}T07:00:00.000Z`) + 86_399_000).toISOString(),
  updatedAt: '2026-11-18T10:00:00.000Z',
});

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

test('getCalendar pide el rango con la cookie de sesión y devuelve los eventos', async () => {
  const E = ev('1', { startDate: '2026-11-19' });
  const c = cliente({ responder: () => json({ events: [E] }) });
  try {
    assert.deepEqual(await c.api.getCalendar('2026-11-01', '2027-03-31'), [E]);
    assert.deepEqual(c.calls, [{ url: 'https://api.test/api/calendar?from=2026-11-01&to=2027-03-31', method: 'GET', credentials: 'include' }]);
  } finally { c.restore(); }
});

test('una respuesta sin events se trata como lista vacía', async () => {
  const c = cliente({ responder: () => json({}) });
  try { assert.deepEqual(await c.api.getCalendar('2026-11-01', '2026-11-30'), []); } finally { c.restore(); }
});

test('401, 400 y 503 llegan como ApiError con status y código, sin el mensaje del body', async () => {
  const casos = [
    [401, 'no_autenticado'], [400, 'fechas_requeridas'], [400, 'fecha_invalida'],
    [400, 'rango_invertido'], [400, 'rango_demasiado_amplio'], [503, 'calendario_no_disponible'],
  ];
  for (const [status, error] of casos) {
    const c = cliente({ responder: () => json({ error, message: 'texto libre del servidor' }, status) });
    try {
      await assert.rejects(() => c.api.getCalendar('2026-11-01', '2026-11-30'), e => {
        assert.ok(e instanceof c.api.ApiError);
        assert.equal(e.status, status);
        assert.equal(e.code, error);
        assert.ok(!JSON.stringify(e).includes('texto libre'));
        return true;
      });
    } finally { c.restore(); }
  }
});

test('sin mock un fallo de red se propaga: no hay datos de respaldo', async () => {
  const c = cliente({ responder: () => { throw new TypeError('Failed to fetch'); } });
  try { await assert.rejects(() => c.api.getCalendar('2026-11-01', '2026-11-30'), TypeError); } finally { c.restore(); }
});

test('con VITE_USE_MOCK=true hay eventos pasados, de hoy y próximos, de las dos categorías, sin red', async () => {
  const c = cliente({ useMock: true, responder: () => assert.fail('no debe llamar a la red') });
  const U = compileCalendar();
  try {
    const now = Date.now();
    const { from, to } = U.calendarWindow(now);
    const events = await c.api.getCalendar(U.addDays(U.dayKey(now), -30), to);
    const when = new Set(events.map(e => U.classifyEvent(e, now)));
    assert.deepEqual([...when].sort(), ['hoy', 'pasado', 'proximo']);
    assert.ok(events.some(e => e.allDay) && events.some(e => !e.allDay), 'todo el día y con hora');
    assert.ok(events.some(U.isSchoolRecord) && events.some(e => e.category === 'Académicos'), 'dos categorías');
    // Respeta el rango pedido y viene ordenado por inicio.
    const enRango = await c.api.getCalendar(from, to);
    assert.ok(enRango.every(e => e.endDate >= from && e.startDate <= to));
    const inicios = enRango.map(e => Date.parse(e.startsAt));
    assert.deepEqual(inicios, [...inicios].sort((a, b) => a - b));
    assert.equal(c.calls.length, 0);
  } finally { c.restore(); }
});

// ── Utilidades ──────────────────────────────────────────────────────────────

const U = compileCalendar();
const NOW = Date.parse('2026-11-18T19:00:00.000Z'); // miércoles 18 nov 2026, 12:00 en Hermosillo
const NOCHE = Date.parse('2026-11-19T06:30:00.000Z'); // miércoles 18 nov, 23:30 en Hermosillo (ya 19 en UTC)

test('día en Hermosillo, aritmética de días y ventana de la petición', () => {
  assert.equal(U.dayKey(NOW), '2026-11-18');
  assert.equal(U.dayKey(NOCHE), '2026-11-18', 'a las 23:30 de Hermosillo sigue siendo 18 aunque en UTC ya sea 19');
  assert.equal(U.addDays('2026-12-30', 3), '2027-01-02');
  assert.equal(U.daysBetween('2026-11-18', '2026-11-21'), 3);
  assert.equal(U.daysBetween('2026-11-18', '2026-11-15'), -3);
  assert.deepEqual(U.calendarWindow(NOW), { from: '2026-11-01', to: '2027-03-31' });
  assert.deepEqual(U.calendarWindow(Date.parse('2027-12-10T19:00:00.000Z')), { from: '2027-12-01', to: '2028-04-30' });
  for (const now of [NOW, Date.parse('2028-01-31T19:00:00.000Z'), Date.parse('2026-10-31T19:00:00.000Z')]) {
    const { from, to } = U.calendarWindow(now);
    assert.ok(U.daysBetween(from, to) + 1 <= 366);
    assert.ok(from <= U.dayKey(now) && U.dayKey(now) <= to);
  }
});

test('todo el día usa startDate/endDate; con hora, startsAt/endsAt en Hermosillo', () => {
  // Un evento de todo el día cuyo startsAt en UTC ya es del día siguiente no se corre.
  const todoElDia = ev('a', { startDate: '2026-11-19', startsAt: '2026-11-20T06:59:59.000Z', endsAt: '2026-11-20T06:59:59.000Z' });
  assert.deepEqual(U.eventDays(todoElDia), { start: '2026-11-19', end: '2026-11-19' });
  const conHora = ev('b', { allDay: false, startDate: 'x', startsAt: '2026-11-20T05:00:00.000Z', endsAt: '2026-11-20T06:30:00.000Z' });
  assert.deepEqual(U.eventDays(conHora), { start: '2026-11-19', end: '2026-11-19' });
});

test('clasifica en pasado, hoy y próximo con now fijo', () => {
  assert.equal(U.classifyEvent(ev('p', { startDate: '2026-11-17' }), NOW), 'pasado');
  assert.equal(U.classifyEvent(ev('h', { startDate: '2026-11-18' }), NOW), 'hoy');
  assert.equal(U.classifyEvent(ev('h2', { startDate: '2026-11-10', endDate: '2026-11-20' }), NOW), 'hoy', 'en curso');
  assert.equal(U.classifyEvent(ev('f', { startDate: '2026-11-19' }), NOW), 'proximo');
  // Con hora: hoy a las 08:00 (ya pasó la hora) sigue siendo de hoy; mañana a las 00:30 es próximo.
  assert.equal(U.classifyEvent(ev('t', { allDay: false, startsAt: '2026-11-18T15:00:00.000Z', endsAt: '2026-11-18T16:00:00.000Z' }), NOW), 'hoy');
  assert.equal(U.classifyEvent(ev('t2', { allDay: false, startsAt: '2026-11-19T07:30:00.000Z', endsAt: '2026-11-19T08:00:00.000Z' }), NOW), 'proximo');
  assert.equal(U.classifyEvent(ev('t3', { allDay: false, startsAt: '2026-11-18T05:00:00.000Z', endsAt: '2026-11-18T06:00:00.000Z' }), NOW), 'pasado',
    '2026-11-18T05:00Z es el 17 a las 22:00 en Hermosillo');
});

test('agrupa por fecha en orden; lo en curso va en hoy; todo el día antes que con hora', () => {
  const events = [
    ev('f2', { startDate: '2026-12-01' }),
    ev('hora', { allDay: false, startsAt: '2026-11-19T16:00:00.000Z', endsAt: '2026-11-19T17:00:00.000Z' }),
    ev('f1', { startDate: '2026-11-19' }),
    ev('curso', { startDate: '2026-11-10', endDate: '2026-11-25' }),
    ev('p', { startDate: '2026-11-02' }),
    ev('hoy', { startDate: '2026-11-18' }),
  ];
  const groups = U.groupByDate(events, NOW);
  assert.deepEqual(groups.map(g => [g.day, g.when, g.events.map(e => e.id)]), [
    ['2026-11-02', 'pasado', ['p']],
    ['2026-11-18', 'hoy', ['curso', 'hoy']],
    ['2026-11-19', 'proximo', ['f1', 'hora']],
    ['2026-12-01', 'proximo', ['f2']],
  ]);
  const { past, upcoming } = U.splitGroups(groups);
  assert.deepEqual(past.map(g => g.day), ['2026-11-02']);
  assert.deepEqual(upcoming.map(g => g.day), ['2026-11-18', '2026-11-19', '2026-12-01']);
  assert.equal(events[0].id, 'f2', 'no muta la lista original');
});

test('cuánto falta o cuánto pasó, en días de calendario de Hermosillo', () => {
  assert.equal(U.relativeLabel(ev('a', { startDate: '2026-11-18' }), NOW), 'Hoy');
  assert.equal(U.relativeLabel(ev('b', { startDate: '2026-11-19' }), NOW), 'Mañana');
  assert.equal(U.relativeLabel(ev('c', { startDate: '2026-11-21' }), NOW), 'En 3 días');
  assert.equal(U.relativeLabel(ev('c', { startDate: '2026-11-21' }), NOCHE), 'En 3 días', 'a las 23:30 aún cuenta desde el 18');
  assert.equal(U.relativeLabel(ev('d', { startDate: '2026-11-17' }), NOW), 'Ayer');
  assert.equal(U.relativeLabel(ev('e', { startDate: '2026-11-10', endDate: '2026-11-13' }), NOW), 'Hace 5 días');
  assert.equal(U.relativeLabel(ev('f', { startDate: '2026-11-15', endDate: '2026-11-19' }), NOW), 'Hoy · termina mañana');
  assert.equal(U.relativeLabel(ev('g', { startDate: '2026-11-15', endDate: '2026-11-20' }), NOW), 'Hoy · termina en 2 días');
});

test('formato de todo el día vs con hora en America/Hermosillo', () => {
  assert.equal(U.formatEventWhen(ev('a', { startDate: '2026-11-19' }), NOW), 'Todo el día');
  assert.equal(U.formatEventWhen(ev('b', { startDate: '2026-12-21', endDate: '2027-01-06' }), NOW), 'Todo el día · 21 dic – 6 ene 2027');
  // 2026-11-20T01:00Z = jueves 19 nov 18:00 en Hermosillo.
  assert.equal(U.formatEventWhen(ev('c', { allDay: false, startsAt: '2026-11-20T01:00:00.000Z', endsAt: '2026-11-20T03:00:00.000Z' }), NOW), '18:00 – 20:00');
  assert.equal(U.formatEventWhen(ev('d', { allDay: false, startsAt: '2026-11-20T01:00:00.000Z', endsAt: '2026-11-20T01:00:00.000Z' }), NOW), '18:00');
  assert.equal(U.formatEventWhen(ev('e', { allDay: false, startsAt: '2026-11-19T15:00:00.000Z', endsAt: '2026-11-20T17:00:00.000Z' }), NOW), '19 nov, 08:00 – 20 nov, 10:00');
  assert.equal(U.formatDayHeading('2026-11-19', NOW), 'jueves 19 de noviembre');
  assert.equal(U.formatDayHeading('2027-01-18', NOW), 'lunes 18 de enero de 2027');
  assert.equal(U.formatShortDay('2026-11-01', NOW), '1 nov');
});

test('Registro Escolar se reconoce por categoría', () => {
  assert.equal(U.isSchoolRecord({ category: 'Registro Escolar' }), true);
  assert.equal(U.isSchoolRecord({ category: ' registro escolar ' }), true);
  assert.equal(U.isSchoolRecord({ category: 'Académicos' }), false);
  assert.equal(U.isSchoolRecord({ category: null }), false);
});

// ── App ─────────────────────────────────────────────────────────────────────

const ME = { email: 'alumna@example.test', classroomConnected: true, itsonStatus: 'ok' };

function backend({ events = [ev('1', { startDate: '2026-11-19' })], fallos = {}, pendiente } = {}) {
  const calls = [];
  const fetchImpl = async (url, options = {}) => {
    const ruta = url.replace('https://api.test', '');
    calls.push({ ruta, credentials: options.credentials });
    const base = ruta.split('?')[0];
    if (fallos[base]) return json({ error: fallos[base][1], message: 'x' }, fallos[base][0]);
    if (ruta === '/auth/google/session') return json({ connected: true, email: ME.email });
    if (ruta === '/api/me') return json(ME);
    if (ruta === '/api/notifications') return json([]);
    if (ruta === '/api/credentials/ivirtual') return json({ available: true, linked: true, status: 'active', lastValidatedAt: null });
    if (ruta === '/api/itson-profile') return json({ configured: false, matriculaHint: null, career: null, updatedAt: null });
    if (base === '/api/calendar') return pendiente ? pendiente.then(() => json({ events })) : json({ events });
    return { ok: true, status: 204 };
  };
  return { calls, fetchImpl };
}

async function enCalendario(opciones, harnessOpts = { useMock: false }) {
  const b = backend(opciones);
  const h = harness('', b.fetchImpl, harnessOpts);
  await h.start();
  find(h.render(), 'AppLayout').props.onGo('calendario');
  await h.settle();
  return { ...b, h, page: () => find(h.render(), 'CalendarPage'), layout: () => find(h.render(), 'AppLayout') };
}
const rutas = calls => calls.filter(c => c.ruta.startsWith('/api/calendar')).map(c => c.ruta);

test('al entrar a Calendario pide /api/calendar con la ventana del mes y guarda el resultado', async () => {
  const { h, calls, page } = await enCalendario();
  try {
    const { from, to } = U.calendarWindow(Date.now());
    assert.equal(page().props.state.status, 'ready');
    assert.deepEqual(page().props.state.events.map(e => e.id), ['1']);
    assert.deepEqual(rutas(calls), [`/api/calendar?from=${from}&to=${to}`]);
    assert.deepEqual([page().props.state.from, page().props.state.to], [from, to]);
    for (const c of calls.filter(c => c.ruta.startsWith('/api'))) assert.equal(c.credentials, 'include');
  } finally { h.restore(); }
});

test('mientras hay una petición en curso no se duplica', async () => {
  let soltar;
  const pendiente = new Promise(resolve => { soltar = resolve; });
  const { h, calls, page, layout } = await enCalendario({ pendiente });
  try {
    assert.equal(page().props.state.status, 'loading');
    layout().props.onGo('inicio');
    layout().props.onGo('calendario');
    page().props.onRetry();
    assert.equal(rutas(calls).length, 1);
    soltar();
    await h.settle();
    assert.equal(page().props.state.status, 'ready');
  } finally { h.restore(); }
});

test('volver a entrar refresca y conserva la lista mientras carga', async () => {
  const { h, calls, page, layout } = await enCalendario();
  try {
    layout().props.onGo('inicio');
    layout().props.onGo('calendario');
    assert.equal(page().props.state.status, 'loading');
    assert.deepEqual(page().props.state.events.map(e => e.id), ['1']);
    await h.settle();
    assert.equal(rutas(calls).length, 2);
  } finally { h.restore(); }
});

test('un 500 deja reintentar; un 503 calendario_no_disponible tiene su propio estado', async () => {
  const a = await enCalendario({ fallos: { '/api/calendar': [500, 'x'] } });
  try {
    assert.equal(a.page().props.state.status, 'error');
    a.page().props.onRetry();
    await a.h.settle();
    assert.equal(rutas(a.calls).length, 2);
  } finally { a.h.restore(); }

  const b = await enCalendario({ fallos: { '/api/calendar': [503, 'calendario_no_disponible'] } });
  try {
    assert.equal(b.page().props.state.status, 'unavailable');
    assert.equal(find(b.h.render(), 'Onboarding'), null);
  } finally { b.h.restore(); }

  const c = await enCalendario({ fallos: { '/api/calendar': [400, 'rango_demasiado_amplio'] } });
  try { assert.equal(c.page().props.state.status, 'error'); } finally { c.h.restore(); }
});

test('un 401 en el calendario termina la sesión y no conserva eventos', async () => {
  const { h } = await enCalendario({ fallos: { '/api/calendar': [401, 'no_autenticado'] } });
  try {
    const tree = h.render();
    assert.ok(find(tree, 'Onboarding'));
    assert.equal(find(tree, 'ToastView').props.toast.text, 'Tu sesión expiró. Vuelve a entrar con Google.');
  } finally { h.restore(); }
});

test('con VITE_USE_MOCK=true el Calendario funciona sin backend', async () => {
  const b = backend();
  const h = harness('', b.fetchImpl, { useMock: true });
  try {
    await h.start();
    find(h.render(), 'Onboarding').props.onFinish();
    find(h.render(), 'AppLayout').props.onGo('calendario');
    await h.settle();
    const page = find(h.render(), 'CalendarPage');
    assert.equal(page.props.state.status, 'ready');
    assert.ok(page.props.state.events.length > 0);
    assert.equal(b.calls.filter(c => c.ruta.startsWith('/api')).length, 0);
  } finally { h.restore(); }
});
