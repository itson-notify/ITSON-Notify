// ITN-43c - Tareas de Classroom en Ajustes: cliente de /api/classroom/tasks-authorization,
// tarjeta (estados, Activar, Desactivar con confirmación) y avisos de ?tareas=. El harness
// no sustituye una prueba de navegador ni una autorización real de Google.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { compile, harness, find } = require('./harness.cjs');

const ENV = { VITE_BACKEND_URL: 'https://api.test/' };
const json = (body, status = 200) => ({ ok: status < 400, status, json: async () => body, headers: { get: () => null } });

function findAll(node, pred, out = []) {
  if (!node || typeof node !== 'object') return out;
  if (Array.isArray(node)) { node.forEach(n => findAll(n, pred, out)); return out; }
  if (node.type !== undefined && pred(node)) out.push(node);
  for (const value of Object.values(node.props ?? {})) {
    if (value && typeof value === 'object') findAll(value, pred, out);
  }
  return out;
}
const textOf = tree => findAll(tree, () => true)
  .flatMap(n => [n.props?.children, n.props?.text, n.props?.title, n.props?.description].flat(Infinity))
  .filter(v => typeof v === 'string').join(' ');

function withFetch(fetchImpl, fn) {
  const original = global.fetch;
  global.fetch = fetchImpl;
  return Promise.resolve().then(fn).finally(() => { global.fetch = original; });
}

function clients(env = ENV) {
  const backend = compile('services/backend.ts', require, env);
  const req = id => (id === '@/services/backend' ? backend : require(id));
  return { api: compile('services/api.ts', req, env), auth: compile('services/googleAuth.ts', req, env) };
}

test('el cliente lee el estado, trata 404 como apagado y desactiva con DELETE y cookies', async () => {
  const { api } = clients();
  const calls = [];
  const respuestas = {
    GET: [json({ enabled: true, granted: true, needsRelink: false }), json({ error: 'no_encontrado' }, 404)],
    DELETE: [{ ok: true, status: 204 }],
  };
  await withFetch(async (url, options = {}) => {
    calls.push({ url, method: options.method, credentials: options.credentials });
    return respuestas[options.method ?? 'GET'].shift();
  }, async () => {
    assert.deepEqual(await api.getTasksAuthorization(), { enabled: true, granted: true, needsRelink: false });
    assert.deepEqual(await api.getTasksAuthorization(), api.TASKS_AUTH_OFF);
    await api.disableTasksAuthorization();
  });
  assert.equal(calls[0].url, 'https://api.test/api/classroom/tasks-authorization');
  assert.equal(calls[2].method, 'DELETE');
  assert.ok(calls.every(c => c.credentials === 'include'));
});

test('en modo mock no hay tarjeta de tareas ni llamadas', async () => {
  const { api } = clients({ ...ENV, VITE_USE_MOCK: 'true' });
  await withFetch(async () => { throw new Error('no debería llamar'); }, async () => {
    assert.deepEqual(await api.getTasksAuthorization(), api.TASKS_AUTH_OFF);
  });
});

test('modo demo: ?tareasDemo= elige el estado de la tarjeta sin llamar al backend', async () => {
  const originalWindow = global.window;
  try {
    await withFetch(async () => { throw new Error('no debería llamar'); }, async () => {
      for (const [param, expected] of [
        ['no_activadas', { enabled: true, granted: false, needsRelink: false }],
        ['activadas', { enabled: true, granted: true, needsRelink: false }],
        ['revincular', { enabled: true, granted: false, needsRelink: true }],
        ['apagada', { enabled: false, granted: false, needsRelink: false }],
        ['otra-cosa', { enabled: false, granted: false, needsRelink: false }],
      ]) {
        global.window = { location: { search: `?tareasDemo=${param}` } };
        const { api } = clients({ ...ENV, VITE_USE_MOCK: 'true' });
        assert.deepEqual(await api.getTasksAuthorization(), expected, param);
      }
      // Desactivar en el demo cambia el estado en memoria, sin red.
      global.window = { location: { search: '?tareasDemo=activadas' } };
      const { api } = clients({ ...ENV, VITE_USE_MOCK: 'true' });
      await api.disableTasksAuthorization();
      assert.deepEqual(await api.getTasksAuthorization(), { enabled: true, granted: false, needsRelink: false });
    });
    // Sin mock el parámetro no cambia nada: el estado sale del backend.
    global.window = { location: { search: '?tareasDemo=activadas' } };
    const { api } = clients();
    await withFetch(async () => json({ enabled: false, granted: false, needsRelink: false }), async () => {
      assert.deepEqual(await api.getTasksAuthorization(), api.TASKS_AUTH_OFF);
      api.setMockTasksAuthorization({ enabled: true, granted: true, needsRelink: false });
      assert.deepEqual(await api.getTasksAuthorization(), api.TASKS_AUTH_OFF);
    });
  } finally {
    global.window = originalWindow;
  }
});

test('mensajes claros para cada resultado de ?tareas=', () => {
  const { auth } = clients();
  assert.equal(auth.tasksResultMessage('ok'), 'Tareas de Classroom activadas');
  assert.match(auth.tasksResultMessage('rechazada'), /no se concedió el permiso/);
  assert.match(auth.tasksResultMessage('cuenta_distinta'), /misma cuenta de Google/);
  assert.equal(auth.tasksResultMessage('error'), 'No se pudieron activar las tareas de Classroom');
  assert.equal(auth.tasksResultMessage('cualquier-cosa'), 'No se pudieron activar las tareas de Classroom');
});

function renderSettings(tasksAuth, { classroomConnected = true } = {}) {
  const jsx = (type, props) => ({ type, props });
  const { SettingsPage } = compile('pages/SettingsPage.tsx', id => {
    if (id === 'react/jsx-runtime') return { jsx, jsxs: jsx, Fragment: 'Fragment' };
    if (id === '@/components/icons') return { I: new Proxy({}, { get: () => () => null }) };
    return new Proxy({}, { get: (_, key) => key });
  });
  const events = { activate: 0, disable: 0, reconnect: 0 };
  const tree = SettingsPage({
    settings: { itsonStatus: 'ok', classroomConnected, classroomEmail: 'alumna@example.test', categories: {}, pushOn: true, emailOn: true },
    setSettings() {}, onFix() {}, askConfirm() {}, notify() {},
    tasksAuth,
    onActivateTasks: () => { events.activate++; },
    onDisableTasks: () => { events.disable++; },
    onReconnectClassroom: () => { events.reconnect++; },
  });
  const nodes = findAll(tree, () => true);
  const control = label => nodes.find(n => (n.type === 'button' || n.type === 'Button') && n.props.children === label);
  return { tree, texto: textOf(tree), control, events };
}

test('la tarjeta no aparece con la bandera apagada ni sin Classroom conectado', () => {
  assert.doesNotMatch(renderSettings({ enabled: false, granted: false, needsRelink: false }).texto, /Tareas de Classroom/);
  assert.doesNotMatch(renderSettings(undefined).texto, /Tareas de Classroom/);
  assert.doesNotMatch(renderSettings({ enabled: true, granted: false, needsRelink: false }, { classroomConnected: false }).texto, /Tareas de Classroom/);
});

test('sin activar: estado «No activadas» y botón Activar', () => {
  const r = renderSettings({ enabled: true, granted: false, needsRelink: false });
  assert.match(r.texto, /Tareas de Classroom/);
  assert.match(r.texto, /No activadas/);
  assert.equal(r.control('Desactivar'), undefined);
  r.control('Activar').props.onClick();
  assert.deepEqual(r.events, { activate: 1, disable: 0, reconnect: 0 });
});

test('activadas: estado «Activadas» y Desactivar', () => {
  const r = renderSettings({ enabled: true, granted: true, needsRelink: false });
  assert.match(r.texto, /Activadas/);
  assert.equal(r.control('Activar'), undefined);
  r.control('Desactivar').props.onClick();
  assert.deepEqual(r.events, { activate: 0, disable: 1, reconnect: 0 });
});

test('autorización revocada: pide volver a autorizar Classroom', () => {
  const r = renderSettings({ enabled: true, granted: false, needsRelink: true });
  assert.match(r.texto, /Vuelve a autorizar Google Classroom/);
  assert.equal(r.control('Activar'), undefined);
  r.control('Volver a autorizar').props.onClick();
  assert.deepEqual(r.events, { activate: 0, disable: 0, reconnect: 1 });
});

// App completa con backend simulado.
function backend({ tasks = { enabled: true, granted: true, needsRelink: false }, deleteStatus = 204 } = {}) {
  const calls = [];
  const fetchImpl = async (url, options = {}) => {
    const ruta = url.replace('https://api.test', '');
    calls.push({ ruta, method: options.method ?? 'GET' });
    if (ruta === '/auth/google/session') return json({ connected: true, email: 'alumna@example.test' });
    if (ruta === '/api/me') return json({ email: 'alumna@example.test', classroomConnected: true, itsonStatus: 'ok' });
    if (ruta === '/api/notifications') return json([]);
    if (ruta === '/api/classroom/tasks-authorization') {
      return options.method === 'DELETE' ? json(null, deleteStatus) : json(tasks);
    }
    return { ok: true, status: 204, json: async () => ({}) };
  };
  return { calls, fetchImpl };
}
const toast = h => find(h.render(), 'ToastView').props.toast?.text;
const settings = h => find(h.render(), 'SettingsPage');

for (const [resultado, texto] of [
  ['ok', 'Tareas de Classroom activadas'],
  ['rechazada', 'No se activaron las tareas: no se concedió el permiso. Puedes intentarlo otra vez.'],
  ['cuenta_distinta', 'Elige la misma cuenta de Google con la que entraste para activar las tareas'],
  ['error', 'No se pudieron activar las tareas de Classroom'],
]) {
  test(`al volver con ?tareas=${resultado} abre Ajustes, avisa y limpia la URL`, async () => {
    const b = backend();
    const h = harness(`?tareas=${resultado}&from=settings`, b.fetchImpl, { useMock: false });
    try {
      await h.start();
      assert.equal(find(h.render(), 'AppLayout').props.page, 'configuracion');
      assert.equal(toast(h), texto);
      assert.equal(h.history.length, 1);
      // El estado real se vuelve a leer del backend, no del parámetro.
      assert.deepEqual(settings(h).props.tasksAuth, { enabled: true, granted: true, needsRelink: false });
    } finally { h.restore(); }
  });
}

test('Ajustes recibe el estado y Activar navega a /auth/google/tasks', async () => {
  const b = backend({ tasks: { enabled: true, granted: false, needsRelink: false } });
  const h = harness('?classroom=auth_success&from=settings', b.fetchImpl, { useMock: false });
  try {
    await h.start();
    const page = settings(h);
    assert.deepEqual(page.props.tasksAuth, { enabled: true, granted: false, needsRelink: false });
    page.props.onActivateTasks();
    assert.deepEqual(h.assigned, ['https://api.test/auth/google/tasks']);
  } finally { h.restore(); }
});

test('Desactivar pide confirmación y solo después llama al DELETE', async () => {
  for (const deleteStatus of [204, 500]) {
    const b = backend({ deleteStatus });
    const h = harness('?classroom=auth_success&from=settings', b.fetchImpl, { useMock: false });
    try {
      await h.start();
      settings(h).props.onDisableTasks();
      const dialog = find(h.render(), 'ConfirmDialog');
      assert.match(dialog.props.req.title, /Desactivar las tareas/);
      assert.equal(dialog.props.req.danger, true);
      assert.equal(b.calls.some(c => c.method === 'DELETE'), false);
      await dialog.props.req.onConfirm();
      assert.deepEqual(b.calls.filter(c => c.method === 'DELETE').map(c => c.ruta), ['/api/classroom/tasks-authorization']);
      if (deleteStatus === 204) {
        assert.equal(settings(h).props.tasksAuth.granted, false);
        assert.equal(toast(h), 'Tareas de Classroom desactivadas');
      } else {
        assert.equal(settings(h).props.tasksAuth.granted, true);
        assert.equal(toast(h), 'No se pudieron desactivar las tareas de Classroom');
      }
    } finally { h.restore(); }
  }
});

test('si la API de tareas falla, la tarjeta queda oculta y el resto carga', async () => {
  const b = backend();
  const fetchImpl = (url, options) => (url.endsWith('/api/classroom/tasks-authorization') ? Promise.reject(new Error('sin red')) : b.fetchImpl(url, options));
  const h = harness('?classroom=auth_success&from=settings', fetchImpl, { useMock: false });
  try {
    await h.start();
    assert.equal(settings(h).props.tasksAuth.enabled, false);
  } finally { h.restore(); }
});
