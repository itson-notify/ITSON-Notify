// ITN-51: vinculación de iVirtual. Cliente de /api/credentials/ivirtual, el sheet
// (con hooks y red controlados, sin dependencias nuevas), la fila de Ajustes y
// desvincular desde App. La contraseña se arma en tiempo de ejecución.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { compile, harness, find } = require('./harness.cjs');

const PASSWORD = ['Contra', 'sena', 'Prueba', '91z'].join('-');
const USUARIO = 'usuario.prueba';
const ENV = { VITE_BACKEND_URL: 'https://api.test/' };

const json = (body, status = 200) => ({ ok: status < 400, status, json: async () => body });
const LINK = (extra = {}) => ({ available: true, linked: false, status: null, lastValidatedAt: null, ...extra });

// Árbol de JSX: todos los nodos (con `type`) que cumplen `pred`.
function findAll(node, pred, out = []) {
  if (!node || typeof node !== 'object') return out;
  if (Array.isArray(node)) { node.forEach(n => findAll(n, pred, out)); return out; }
  if (node.type !== undefined && pred(node)) out.push(node);
  // children y también props con JSX, como el subtitle de SettingRow.
  for (const value of Object.values(node.props ?? {})) {
    if (value && typeof value === 'object') findAll(value, pred, out);
  }
  return out;
}
const textOf = node => findAll(node, () => true).flatMap(n => [n.props?.children].flat(Infinity))
  .filter(c => typeof c === 'string').join(' ');

// Todo lo que la app podría dejar fuera del formulario: consola y almacenamiento.
function spyLeaks() {
  const captured = [];
  const originals = { console: { ...console }, localStorage: global.localStorage, sessionStorage: global.sessionStorage };
  for (const level of ['log', 'info', 'warn', 'error', 'debug']) console[level] = (...args) => captured.push(args.map(String).join(' '));
  const storage = () => ({ setItem: (k, v) => captured.push(`${k}=${v}`), getItem: () => null, removeItem() {}, clear() {} });
  global.localStorage = storage();
  global.sessionStorage = storage();
  return {
    captured,
    restore() {
      Object.assign(console, originals.console);
      global.localStorage = originals.localStorage;
      global.sessionStorage = originals.sessionStorage;
    },
  };
}

function withFetch(fetchImpl, fn) {
  const original = global.fetch;
  global.fetch = fetchImpl;
  return Promise.resolve().then(fn).finally(() => { global.fetch = original; });
}

function clients(env = ENV) {
  const backend = compile('services/backend.ts', require, env);
  const api = compile('services/api.ts', id => (id === '@/services/backend' ? backend : require(id)), env);
  return { backend, api };
}

// Monta IvirtualLinkSheet con hooks mínimos. `ui` y `icons` se reemplazan por
// nombres, como en harness.cjs.
function mountSheet({ env = ENV, props = {} } = {}) {
  const { backend, api } = clients(env);
  const states = []; const effects = []; let cursor = 0; let mounted = false;
  const hooks = {
    useState(initial) {
      const index = cursor++;
      if (!(index in states)) states[index] = typeof initial === 'function' ? initial() : initial;
      return [states[index], value => { states[index] = typeof value === 'function' ? value(states[index]) : value; }];
    },
    useEffect(effect) { if (!mounted) effects.push(effect); },
  };
  const jsx = (type, p) => ({ type, props: p });
  const { IvirtualLinkSheet } = compile('components/IvirtualLinkSheet.tsx', id => {
    if (id === 'react') return hooks;
    if (id === 'react/jsx-runtime') return { jsx, jsxs: jsx, Fragment: 'Fragment' };
    if (id === '@/services/api') return api;
    if (id === '@/services/backend') return backend;
    if (id === './icons') return { I: new Proxy({}, { get: () => () => null }) };
    if (id === '@/services/mockData') return { ITSON_RECOVERY_URL: 'https://itson.test/recuperar' };
    return new Proxy({}, { get: (_, key) => key });
  }, env);
  const events = { linked: [], closed: 0, expired: 0 };
  const allProps = {
    onClose: () => { events.closed += 1; },
    onLinked: link => events.linked.push(link),
    onSessionExpired: () => { events.expired += 1; },
    ...props,
  };
  return {
    events, states,
    render() { cursor = 0; const tree = IvirtualLinkSheet(allProps); mounted = true; return tree; },
    async start() { const tree = this.render(); effects.forEach(e => e()); await settle(); return this.render(); },
  };
}
const settle = () => new Promise(setImmediate);

const field = (tree, type) => find(tree, type);
const form = tree => find(tree, 'form');
const submit = tree => form(tree).props.onSubmit({ preventDefault() {} });
const submitButton = tree => findAll(tree, n => n.type === 'Button' && n.props.type === 'submit')[0];

// Llena y envía el formulario. Devuelve el árbol justo después de enviar.
async function fillAndSend(sheet, { username = USUARIO, password = PASSWORD } = {}) {
  let tree = sheet.render();
  field(tree, 'TextField').props.onChange(username);
  tree = sheet.render();
  field(tree, 'PasswordField').props.onChange(password);
  tree = sheet.render();
  submit(tree);
  return sheet.render();
}

function linkBackend({ get = () => json(LINK()), put = () => json(LINK({ linked: true, status: 'active' })), del = () => ({ ok: true, status: 204 }) } = {}) {
  const calls = [];
  const fetchImpl = async (url, options = {}) => {
    const ruta = url.replace('https://api.test', '');
    calls.push({ ruta, method: options.method ?? 'GET', credentials: options.credentials, body: options.body, headers: options.headers });
    if (ruta !== '/api/credentials/ivirtual') return { ok: true, status: 204 };
    if ((options.method ?? 'GET') === 'GET') return get();
    if (options.method === 'PUT') return put(options);
    if (options.method === 'DELETE') return del();
    return json({ error: 'x' }, 405);
  };
  return { calls, fetchImpl };
}

// ── Cliente ─────────────────────────────────────────────────────────────────

test('el cliente usa credentials include, PUT con JSON y ApiError sin datos', async () => {
  const { api } = clients();
  const b = linkBackend({ put: () => json({ error: 'vinculacion_fallida' }, 422) });
  await withFetch(b.fetchImpl, async () => {
    assert.deepEqual(await api.getIvirtualLink(), LINK());
    await assert.rejects(api.linkIvirtual(USUARIO, PASSWORD), error => {
      assert.ok(error instanceof api.ApiError);
      assert.equal(error.status, 422);
      assert.ok(!JSON.stringify({ m: error.message, s: error.stack }).includes(PASSWORD));
      return true;
    });
  });
  for (const call of b.calls) assert.equal(call.credentials, 'include');
  const put = b.calls.find(c => c.method === 'PUT');
  assert.deepEqual(JSON.parse(put.body), { username: USUARIO, password: PASSWORD });
  assert.equal(put.headers['Content-Type'], 'application/json');
});

test('desvincular: 204 es unlinked, 404 es already_unlinked y otros errores se propagan', async () => {
  const { api } = clients();
  await withFetch(linkBackend().fetchImpl, async () => assert.equal(await api.unlinkIvirtual(), 'unlinked'));
  await withFetch(linkBackend({ del: () => json({ error: 'no_encontrado' }, 404) }).fetchImpl,
    async () => assert.equal(await api.unlinkIvirtual(), 'already_unlinked'));
  await withFetch(linkBackend({ del: () => json({ error: 'error_interno' }, 500) }).fetchImpl,
    async () => assert.rejects(api.unlinkIvirtual(), { status: 500 }));
});

// ── Sheet ───────────────────────────────────────────────────────────────────

test('si available es false no muestra el formulario ni pide la contraseña', async () => {
  const b = linkBackend({ get: () => json(LINK({ available: false })) });
  await withFetch(b.fetchImpl, async () => {
    const sheet = mountSheet();
    const tree = await sheet.start();
    assert.equal(field(tree, 'PasswordField'), null);
    assert.equal(form(tree), null);
    assert.match(textOf(tree), /aún no está disponible/);
    assert.ok(!b.calls.some(c => c.method === 'PUT'));
  });
});

test('en modo mock no llama al backend y muestra que aún no está disponible', async () => {
  const b = linkBackend();
  await withFetch(b.fetchImpl, async () => {
    const sheet = mountSheet({ env: { ...ENV, VITE_USE_MOCK: 'true' } });
    const tree = await sheet.start();
    assert.equal(field(tree, 'PasswordField'), null);
    assert.equal(b.calls.length, 0);
  });
});

test('campos con autoComplete correcto y envío deshabilitado hasta llenar los dos', async () => {
  await withFetch(linkBackend().fetchImpl, async () => {
    const sheet = mountSheet();
    let tree = await sheet.start();
    assert.equal(field(tree, 'TextField').props.autoComplete, 'username');
    // PasswordField de ui.tsx es type="password" con autoComplete="current-password".
    assert.ok(field(tree, 'PasswordField'));
    assert.equal(submitButton(tree).props.disabled, true);
    field(tree, 'TextField').props.onChange(USUARIO);
    tree = sheet.render();
    assert.equal(submitButton(tree).props.disabled, true);
    field(tree, 'PasswordField').props.onChange(PASSWORD);
    assert.equal(submitButton(sheet.render()).props.disabled, false);
  });
});

test('éxito: borra la contraseña al enviar, avisa a App y no la deja en consola ni almacenamiento', async () => {
  let responder;
  const b = linkBackend({ put: () => new Promise(r => { responder = r; }) });
  const leaks = spyLeaks();
  try {
    await withFetch(b.fetchImpl, async () => {
      const sheet = mountSheet();
      await sheet.start();
      const enviando = await fillAndSend(sheet);
      // Mientras espera, la contraseña ya no está en el estado del formulario.
      assert.equal(field(enviando, 'PasswordField').props.value, '');
      assert.equal(submitButton(enviando).props.disabled, true);
      assert.ok(!sheet.states.includes(PASSWORD));

      await settle();
      responder(json(LINK({ linked: true, status: 'active' })));
      await settle(); await settle();
      const tree = sheet.render();
      assert.ok(find(tree, 'SuccessCard'));
      assert.deepEqual(sheet.events.linked, [LINK({ linked: true, status: 'active' })]);
      assert.ok(!JSON.stringify(sheet.states).includes(PASSWORD));
    });
    assert.ok(!leaks.captured.join('\n').includes(PASSWORD));
  } finally { leaks.restore(); }
});

test('rechazo (422): mensaje genérico, contraseña vacía y enlace para recuperarla', async () => {
  const leaks = spyLeaks();
  try {
    await withFetch(linkBackend({ put: () => json({ error: 'vinculacion_fallida', detalle: 'interno' }, 422) }).fetchImpl, async () => {
      const sheet = mountSheet();
      await sheet.start();
      await fillAndSend(sheet);
      await settle(); await settle();
      const tree = sheet.render();
      const pw = field(tree, 'PasswordField');
      assert.equal(pw.props.value, '');
      assert.equal(pw.props.error, 'iVirtual no aceptó ese usuario o contraseña.');
      assert.ok(find(tree, 'a'));
      assert.equal(sheet.events.linked.length, 0);
      assert.ok(!JSON.stringify(sheet.states).includes(PASSWORD));
      // El usuario sí se conserva para corregir solo la contraseña.
      assert.equal(field(tree, 'TextField').props.value, USUARIO);
    });
    assert.ok(!leaks.captured.join('\n').includes(PASSWORD));
  } finally { leaks.restore(); }
});

test('501 al enviar: oculta el formulario y muestra que aún no está disponible', async () => {
  await withFetch(linkBackend({ put: () => json({ error: 'vinculacion_no_disponible' }, 501) }).fetchImpl, async () => {
    const sheet = mountSheet();
    await sheet.start();
    await fillAndSend(sheet);
    await settle(); await settle();
    const tree = sheet.render();
    assert.equal(form(tree), null);
    assert.match(textOf(tree), /aún no está disponible/);
  });
});

test('409, 429, 500, 502 y fallo de red: mensajes genéricos sin códigos ni detalles', async () => {
  for (const [put, esperado] of [
    [() => json({ error: 'demasiados_intentos' }, 429), /demasiados intentos/],
    [() => json({ error: 'error_interno' }, 500), /No pudimos vincular tu cuenta/],
    [() => json({ error: 'portal_no_disponible' }, 502), /No se pudo contactar iVirtual, intenta más tarde/],
    [() => json({ error: 'cambio_password' }, 409), /iVirtual te pide cambiar tu contraseña: hazlo en ivirtual\.itson\.edu\.mx y vuelve a vincular/],
    [() => { throw new TypeError(`fallo de red ${PASSWORD}`); }, /No pudimos vincular tu cuenta/],
  ]) {
    await withFetch(linkBackend({ put }).fetchImpl, async () => {
      const sheet = mountSheet();
      await sheet.start();
      await fillAndSend(sheet);
      await settle(); await settle();
      const tree = sheet.render();
      const error = field(tree, 'PasswordField').props.error;
      assert.match(error, esperado);
      assert.ok(!/\d{3}|error_|portal_|demasiados_|cambio_password|PASSWORD/.test(error));
      assert.ok(!error.includes(PASSWORD));
      assert.equal(field(tree, 'PasswordField').props.value, '');
    });
  }
});

test('401 al revisar o al enviar avisa a App que la sesión expiró', async () => {
  await withFetch(linkBackend({ get: () => json({ error: 'no_autenticado' }, 401) }).fetchImpl, async () => {
    const sheet = mountSheet();
    await sheet.start();
    assert.equal(sheet.events.expired, 1);
  });
  await withFetch(linkBackend({ put: () => json({ error: 'no_autenticado' }, 401) }).fetchImpl, async () => {
    const sheet = mountSheet();
    await sheet.start();
    await fillAndSend(sheet);
    await settle(); await settle();
    assert.equal(sheet.events.expired, 1);
  });
});

test('si no se puede leer el estado no pide la contraseña', async () => {
  await withFetch(linkBackend({ get: () => json({ error: 'error_interno' }, 500) }).fetchImpl, async () => {
    const sheet = mountSheet();
    const tree = await sheet.start();
    assert.equal(field(tree, 'PasswordField'), null);
    assert.match(textOf(tree), /No pudimos revisar/);
  });
});

// ── Ajustes ─────────────────────────────────────────────────────────────────

function renderSettings(ivirtualLink, settings = {}) {
  const jsx = (type, p) => ({ type, props: p });
  const time = compile('utils/time.ts', require);
  const { SettingsPage } = compile('pages/SettingsPage.tsx', id => {
    if (id === 'react/jsx-runtime') return { jsx, jsxs: jsx, Fragment: 'Fragment' };
    if (id === '@/components/icons') return { I: new Proxy({}, { get: () => () => null }) };
    if (id === '@/utils/time') return time;
    return new Proxy({}, { get: (_, key) => key });
  });
  const unlinks = [];
  const tree = SettingsPage({
    settings: { itsonStatus: 'ok', itsonId: '00000000', classroomConnected: false, categories: {}, pushOn: true, emailOn: true, ...settings },
    setSettings() {}, onFix() {}, askConfirm() {}, notify() {},
    ivirtualLink, onUnlinkItson: () => unlinks.push(1),
  });
  const pill = findAll(tree, n => n.props && 'tone' in n.props && 'text' in n.props)[0].props;
  const buttons = findAll(tree, n => n.type === 'button').map(n => n.props.children);
  return { pill, buttons, unlinks };
}

test('Ajustes: sin credencial no se ve conectada ni en verde', () => {
  const { pill, buttons } = renderSettings(LINK());
  assert.equal(pill.tone, 'neutral');
  assert.equal(pill.text, 'Sin vincular');
  assert.ok(buttons.includes('Vincular cuenta'));
  assert.ok(!buttons.includes('Desvincular'));
});

test('Ajustes: estado desconocido tampoco va en verde', () => {
  const { pill } = renderSettings(null);
  assert.equal(pill.tone, 'neutral');
});

test('Ajustes: vinculada sin lastValidatedAt dice "Vinculada", no "Validada"', () => {
  const { pill, buttons } = renderSettings(LINK({ linked: true, status: 'active' }));
  assert.equal(pill.text, 'Vinculada');
  assert.ok(!/Validada/.test(pill.text));
  assert.ok(buttons.includes('Desvincular'));
});

test('Ajustes: con lastValidatedAt dice "Validada" y needs_relink pide la contraseña', () => {
  const validada = renderSettings(LINK({ linked: true, status: 'active', lastValidatedAt: new Date().toISOString() }));
  assert.match(validada.pill.text, /^Validada/);
  assert.equal(validada.pill.tone, 'ok');
  const relink = renderSettings(LINK({ linked: true, status: 'needs_relink' }));
  assert.equal(relink.pill.tone, 'warn');
  assert.equal(relink.pill.text, 'Requiere tu contraseña');
  assert.ok(relink.buttons.includes('Actualizar contraseña'));
});

// ── App ─────────────────────────────────────────────────────────────────────

function appBackend({ link = LINK({ linked: true, status: 'active' }), del = () => ({ ok: true, status: 204 }) } = {}) {
  const calls = [];
  const fetchImpl = async (url, options = {}) => {
    const ruta = url.replace('https://api.test', '');
    const method = options.method ?? 'GET';
    calls.push({ ruta, method });
    if (ruta === '/auth/google/session') return json({ connected: true, email: 'alumna@example.test' });
    if (ruta === '/api/me') return json({ email: 'alumna@example.test', classroomConnected: true, itsonStatus: 'ok' });
    if (ruta === '/api/notifications') return json([]);
    if (ruta === '/api/credentials/ivirtual' && method === 'GET') return json(link);
    if (ruta === '/api/credentials/ivirtual' && method === 'DELETE') return del();
    return { ok: true, status: 204 };
  };
  return { calls, fetchImpl };
}

async function appEnAjustes(opciones) {
  const b = appBackend(opciones);
  const h = harness('', b.fetchImpl, { useMock: false });
  await h.start();
  find(h.render(), 'AppLayout').props.onGo('configuracion');
  return { ...b, h };
}
const settingsOf = h => find(h.render(), 'SettingsPage');
const toastOf = h => find(h.render(), 'ToastView').props.toast?.text;

test('App pasa el estado real a Ajustes y onFix abre el sheet de vinculación', async () => {
  const { h } = await appEnAjustes();
  try {
    assert.deepEqual(settingsOf(h).props.ivirtualLink, LINK({ linked: true, status: 'active' }));
    assert.equal(find(h.render(), 'IvirtualLinkSheet'), null);
    settingsOf(h).props.onFix();
    assert.ok(find(h.render(), 'IvirtualLinkSheet'));
  } finally { h.restore(); }
});

test('el aviso de itsonStatus error abre el mismo sheet', async () => {
  const b = appBackend({ link: LINK({ linked: true, status: 'needs_relink' }) });
  const h = harness('', b.fetchImpl, { useMock: false });
  try {
    await h.start();
    find(h.render(), 'HomePage').props.sync.onFix();
    assert.ok(find(h.render(), 'IvirtualLinkSheet'));
  } finally { h.restore(); }
});

test('desvincular pide confirmación, llama a DELETE y actualiza Ajustes', async () => {
  const { h, calls } = await appEnAjustes();
  try {
    settingsOf(h).props.onUnlinkItson();
    assert.equal(calls.filter(c => c.method === 'DELETE').length, 0);
    const confirm = find(h.render(), 'ConfirmDialog');
    assert.ok(confirm);
    assert.equal(confirm.props.req.danger, true);
    await confirm.props.req.onConfirm();
    assert.equal(calls.filter(c => c.method === 'DELETE' && c.ruta === '/api/credentials/ivirtual').length, 1);
    assert.equal(settingsOf(h).props.ivirtualLink.linked, false);
    assert.equal(toastOf(h), 'Cuenta de iVirtual desvinculada');
  } finally { h.restore(); }
});

test('desvincular con 404 se trata como "ya estaba desvinculada"', async () => {
  const { h } = await appEnAjustes({ del: () => json({ error: 'no_encontrado' }, 404) });
  try {
    settingsOf(h).props.onUnlinkItson();
    await find(h.render(), 'ConfirmDialog').props.req.onConfirm();
    assert.equal(settingsOf(h).props.ivirtualLink.linked, false);
    assert.equal(toastOf(h), 'Tu cuenta de iVirtual ya estaba desvinculada');
  } finally { h.restore(); }
});

test('desvincular con 500 avisa sin cambiar el estado', async () => {
  const { h } = await appEnAjustes({ del: () => json({ error: 'error_interno' }, 500) });
  try {
    settingsOf(h).props.onUnlinkItson();
    await find(h.render(), 'ConfirmDialog').props.req.onConfirm();
    assert.equal(settingsOf(h).props.ivirtualLink.linked, true);
    assert.equal(toastOf(h), 'No se pudo desvincular tu cuenta de iVirtual');
  } finally { h.restore(); }
});
