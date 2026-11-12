// ITN-53: App y el cliente de /api con red controlada, con y sin VITE_USE_MOCK.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { harness, find } = require('./harness.cjs');

const ME = { email: 'alumna@example.test', classroomConnected: true, itsonStatus: 'error' };
const notif = (id, unread = true) => ({
  id, type: 'calificaciones', title: 'Nueva calificación disponible', subject: 'Materia de prueba',
  time: '2026-11-06T10:00:00.000Z', unread, body: 'Texto', rows: [],
});

const json = (body, status = 200) => ({ ok: status < 400, status, json: async () => body });

// Backend simulado. `fallos` cambia la respuesta de una ruta por su status.
function backend({ session = true, notifs = [notif('a'), notif('b')], fallos = {} } = {}) {
  const calls = [];
  const fetchImpl = async (url, options = {}) => {
    const ruta = url.replace('https://api.test', '');
    calls.push({ ruta, method: options.method ?? 'GET', credentials: options.credentials });
    if (fallos[ruta]) return json({ error: 'x' }, fallos[ruta]);
    if (ruta === '/auth/google/session') {
      return session ? json({ connected: true, email: 'alumna@example.test' }) : json({ error: 'no_autenticado' }, 401);
    }
    if (ruta === '/api/me') return json(ME);
    if (ruta === '/api/notifications') return json(notifs);
    return { ok: true, status: 204 };
  };
  return { calls, fetchImpl };
}

const apiCalls = calls => calls.filter(c => c.ruta.startsWith('/api'));

async function conSesion(opciones) {
  const b = backend(opciones);
  const h = harness('', b.fetchImpl, { useMock: false });
  await h.start();
  return { ...b, h };
}

const home = h => find(h.render(), 'HomePage');
const toast = h => find(h.render(), 'ToastView').props.toast?.text;

test('sin mock y con sesión carga notificaciones y estado de ITSON desde la API', async () => {
  const { h, calls } = await conSesion();
  try {
    const page = home(h);
    assert.deepEqual(page.props.notifs.map(n => n.id), ['a', 'b']);
    assert.equal(page.props.settings.itsonStatus, 'error');
    assert.equal(page.props.settings.email, ME.email);
    assert.equal(page.props.sync.loading, false);
    assert.equal(find(h.render(), 'Onboarding'), null);
    for (const call of apiCalls(calls)) assert.equal(call.credentials, 'include');
    assert.deepEqual(apiCalls(calls).map(c => c.ruta).sort(), ['/api/me', '/api/notifications']);
  } finally { h.restore(); }
});

test('muestra el estado de carga mientras la API responde', async () => {
  let responder;
  const pendiente = new Promise(resolve => { responder = resolve; });
  const b = backend();
  const fetchImpl = (url, options) => (url.endsWith('/api/notifications') ? pendiente : b.fetchImpl(url, options));
  const h = harness('', fetchImpl, { useMock: false });
  try {
    const inicial = h.render();
    assert.equal(find(inicial, 'Onboarding'), null);
    assert.ok(find(inicial, 'Spinner'));
    await h.start();
    assert.equal(home(h).props.sync.loading, true);
    responder(json([notif('a')]));
    await h.settle();
    assert.equal(home(h).props.sync.loading, false);
    assert.deepEqual(home(h).props.notifs.map(n => n.id), ['a']);
  } finally { h.restore(); }
});

test('sin sesión sigue Onboarding, exige Google y no llama a /api', async () => {
  const { h, calls } = await conSesion({ session: false });
  try {
    const onboarding = find(h.render(), 'Onboarding');
    assert.ok(onboarding);
    assert.equal(onboarding.props.requireGoogle, true);
    assert.equal(apiCalls(calls).length, 0);
  } finally { h.restore(); }
});

test('al volver de Google a medio Onboarding sigue ahí y ya carga los datos', async () => {
  const b = backend();
  const h = harness('?classroom=auth_success&from=onboarding', b.fetchImpl, { useMock: false });
  try {
    await h.start();
    const onboarding = find(h.render(), 'Onboarding');
    assert.ok(onboarding);
    assert.equal(apiCalls(b.calls).length, 2);
    onboarding.props.onFinish();
    assert.deepEqual(home(h).props.notifs.map(n => n.id), ['a', 'b']);
    assert.equal(home(h).props.sync.firstRun, false);
  } finally { h.restore(); }
});

test('si falla la carga avisa con un toast y deja la lista vacía', async () => {
  const { h } = await conSesion({ fallos: { '/api/notifications': 500 } });
  try {
    assert.equal(toast(h), 'No se pudieron cargar tus notificaciones');
    assert.deepEqual(home(h).props.notifs, []);
    assert.equal(home(h).props.sync.loading, false);
  } finally { h.restore(); }
});

test('si /api responde 401 vuelve a Onboarding sin conservar datos', async () => {
  const { h } = await conSesion({ fallos: { '/api/me': 401 } });
  try {
    const tree = h.render();
    assert.ok(find(tree, 'Onboarding'));
    assert.equal(find(tree, 'ToastView').props.toast.text, 'Tu sesión expiró. Vuelve a entrar con Google.');
  } finally { h.restore(); }
});

test('abrir una notificación marca leída de inmediato y llama a la API', async () => {
  const { h, calls } = await conSesion();
  try {
    home(h).props.onOpen('a');
    const page = find(h.render(), 'NotificationsPage');
    assert.equal(page.props.notifs.find(n => n.id === 'a').unread, false);
    await h.settle();
    const post = calls.find(c => c.method === 'POST');
    assert.equal(post.ruta, '/api/notifications/a/read');
    assert.equal(post.credentials, 'include');
  } finally { h.restore(); }
});

test('abrir una notificación ya leída no vuelve a llamar a la API', async () => {
  const { h, calls } = await conSesion({ notifs: [notif('a', false)] });
  try {
    home(h).props.onOpen('a');
    await h.settle();
    assert.equal(calls.some(c => c.method === 'POST'), false);
  } finally { h.restore(); }
});

test('si falla marcar leída revierte y avisa', async () => {
  const { h } = await conSesion({ fallos: { '/api/notifications/a/read': 500 } });
  try {
    home(h).props.onOpen('a');
    assert.equal(find(h.render(), 'NotificationsPage').props.notifs[0].unread, false);
    await h.settle();
    assert.equal(find(h.render(), 'NotificationsPage').props.notifs[0].unread, true);
    assert.equal(toast(h), 'No se pudo marcar como leída');
  } finally { h.restore(); }
});

test('marcar todo es optimista, llama a read-all y revierte si falla', async () => {
  for (const [fallos, esperado] of [[{}, false], [{ '/api/notifications/read-all': 500 }, true]]) {
    const { h, calls } = await conSesion({ fallos });
    try {
      home(h).props.onOpen('a');
      await h.settle();
      find(h.render(), 'NotificationsPage').props.onMarkAll();
      assert.ok(find(h.render(), 'NotificationsPage').props.notifs.every(n => !n.unread));
      await h.settle();
      assert.ok(calls.some(c => c.ruta === '/api/notifications/read-all' && c.method === 'POST'));
      assert.equal(find(h.render(), 'NotificationsPage').props.notifs.find(n => n.id === 'b').unread, esperado);
    } finally { h.restore(); }
  }
});

test('marcar como no leída se queda local', async () => {
  const { h, calls } = await conSesion({ notifs: [notif('a', false)] });
  try {
    home(h).props.onOpen('a');
    find(h.render(), 'NotificationsPage').props.onMarkUnread('a');
    await h.settle();
    assert.equal(find(h.render(), 'NotificationsPage').props.notifs[0].unread, true);
    assert.equal(calls.some(c => c.method === 'POST'), false);
  } finally { h.restore(); }
});

test('con VITE_USE_MOCK=true conserva los datos simulados y nunca llama a /api', async () => {
  const b = backend();
  const h = harness('', b.fetchImpl, { useMock: true, initialNotifs: [notif('mock')] });
  try {
    const tree = await h.start();
    assert.equal(find(tree, 'Spinner'), null);
    const onboarding = find(h.render(), 'Onboarding');
    assert.equal(onboarding.props.requireGoogle, false);
    onboarding.props.onFinish();
    assert.deepEqual(home(h).props.notifs.map(n => n.id), ['mock']);
    home(h).props.onOpen('mock');
    find(h.render(), 'NotificationsPage').props.onMarkAll();
    await h.settle();
    assert.equal(apiCalls(b.calls).length, 0);
  } finally { h.restore(); }
});

test('nada de lo que trae la API se guarda en el navegador', async () => {
  const usos = [];
  global.localStorage = { setItem: (...args) => usos.push(args) };
  global.sessionStorage = global.localStorage;
  const { h } = await conSesion();
  try {
    home(h).props.onOpen('a');
    await h.settle();
    assert.deepEqual(usos, []);
  } finally { h.restore(); delete global.localStorage; delete global.sessionStorage; }
});
