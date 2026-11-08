// ITN-41 y Web Push: regresiones de navegación, cierre de sesión, revocación Push
// y configuración centralizada del backend sin dependencias nuevas.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const ts = require('typescript');

function compile(file, requireImpl, env = {}) {
  const source = fs.readFileSync(path.join(__dirname, '../src', file), 'utf8')
    .replace(/import\.meta\.env/g, JSON.stringify(env));
  const output = ts.transpileModule(source, { compilerOptions: {
    module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.ReactJSX, target: ts.ScriptTarget.ES2022,
  } }).outputText;
  const module = { exports: {} };
  new Function('require', 'module', 'exports', output)(requireImpl, module, module.exports);
  return module.exports;
}

function harness(search, fetchImpl, { navigatorImpl } = {}) {
  const originals = {
    window: global.window,
    fetch: global.fetch,
    setTimeout: global.setTimeout,
    navigator: Object.getOwnPropertyDescriptor(global, 'navigator'),
  };
  const assigned = [];
  const history = [];
  global.window = {
    location: { search, pathname: '/app', assign: url => assigned.push(url) },
    history: { replaceState: (...args) => history.push(args) },
    addEventListener() {},
    removeEventListener() {},
    scrollTo() {},
    atob: str => Buffer.from(str, 'base64').toString('binary'),
    PushManager: function PushManager() {},
  };
  global.fetch = fetchImpl;
  global.setTimeout = () => 1;
  global.document = { title: 'ITSON Notify' };
  if (navigatorImpl !== undefined) {
    Object.defineProperty(global, 'navigator', { value: navigatorImpl, configurable: true, writable: true });
  } else {
    Object.defineProperty(global, 'navigator', { value: {}, configurable: true, writable: true });
  }

  const env = { VITE_BACKEND_URL: 'https://api.test/' };
  const backendMod = compile('services/backend.ts', require, env);
  const resolveModule = id => {
    if (id === '@/services/backend') return backendMod;
    return require(id);
  };
  const client = compile('services/googleAuth.ts', resolveModule, env);
  const pushMod = compile('services/pushNotifications.ts', resolveModule, env);

  const states = []; const effects = []; let cursor = 0; let mounted = false;
  const hooks = {
    useState(initial) {
      const index = cursor++;
      if (!(index in states)) states[index] = typeof initial === 'function' ? initial() : initial;
      return [states[index], value => { states[index] = typeof value === 'function' ? value(states[index]) : value; }];
    },
    useEffect(effect) { if (!mounted) effects.push(effect); },
  };
  const jsx = (type, props) => ({ type, props });
  const App = compile('App.tsx', id => {
    if (id === 'react') return hooks;
    if (id === 'react/jsx-runtime') return { jsx, jsxs: jsx, Fragment: 'Fragment' };
    if (id === '@/services/backend') return backendMod;
    if (id === '@/services/googleAuth') return client;
    if (id === '@/services/pushNotifications') return pushMod;
    if (id === '@/services/mockData') return { DEFAULT_SETTINGS: {
      categories: {}, classroomConnected: false, itsonStatus: 'ok',
    }, INITIAL_NOTIFS: [] };
    return new Proxy({}, { get: (_, key) => key });
  }).default;
  return {
    backendMod, client, pushMod, assigned, history,
    render() { cursor = 0; const tree = App(); mounted = true; return tree; },
    async start() { const tree = this.render(); effects.forEach(effect => effect()); await new Promise(setImmediate); return tree; },
    restore() {
      global.window = originals.window;
      global.fetch = originals.fetch;
      global.setTimeout = originals.setTimeout;
      delete global.document;
      if (originals.navigator) Object.defineProperty(global, 'navigator', originals.navigator);
      else delete global.navigator;
    },
  };
}
function find(node, type) {
  if (!node || typeof node !== 'object') return null;
  if (node.type === type) return node;
  const children = [node.props?.children].flat(Infinity);
  for (const child of children) { const found = find(child, type); if (found) return found; }
  return null;
}

test('cancelar Google desde Configuración vuelve a Configuración con sesión ausente o error de red', async () => {
  for (const fetchImpl of [async () => ({ status: 401 }), async () => { throw new Error('sin red'); }]) {
    const h = harness('?classroom=error&from=settings', fetchImpl);
    try {
      await h.start();
      const tree = h.render();
      assert.equal(find(tree, 'Onboarding'), null);
      assert.equal(find(tree, 'AppLayout').props.page, 'configuracion');
      assert.ok(find(tree, 'SettingsPage'));
      assert.equal(h.history.length, 1);
    } finally { h.restore(); }
  }
});

test('el retorno desde onboarding conserva onboarding y verifica la sesión en backend', async () => {
  const calls = [];
  const h = harness('?classroom=auth_success&from=onboarding', async (url, options) => {
    calls.push({ url, options }); return { ok: true, json: async () => ({ connected: true, email: 'alumno@gmail.com' }) };
  });
  try {
    await h.start(); const tree = h.render();
    assert.equal(find(tree, 'Onboarding').props.settings.classroomConnected, true);
    assert.equal(calls[0].url, 'https://api.test/auth/google/session');
    assert.equal(calls[0].options.credentials, 'include');
  } finally { h.restore(); }
});

test('cerrar sesión llama al backend y solo cambia a onboarding si la invalidación tiene éxito', async () => {
  for (const ok of [true, false]) {
    const calls = [];
    const h = harness('?classroom=error&from=settings', async (url, options) => {
      calls.push({ url, options });
      return options.method === 'POST' ? { ok } : { status: 401 };
    });
    try {
      await h.start(); find(h.render(), 'AppLayout').props.onLogout();
      await find(h.render(), 'ConfirmDialog').props.req.onConfirm();
      const tree = h.render();
      assert.equal(Boolean(find(tree, 'Onboarding')), ok);
      if (!ok) assert.ok(find(tree, 'AppLayout'));
      assert.equal(calls[1].url, 'https://api.test/auth/google/logout');
      assert.equal(calls[1].options.method, 'POST');
      assert.equal(calls[1].options.credentials, 'include');
      assert.equal(calls.some(call => call.options.method === 'DELETE'), false);
    } finally { h.restore(); }
  }
});

test('cerrar sesión con suscripción Push activa la revoca en backend y navegador antes del logout, y aborta si falla', async () => {
  for (const deleteOk of [true, false]) {
    const calls = [];
    let browserUnsubscribed = 0;
    const navigatorImpl = {
      serviceWorker: {
        async getRegistration() {
          return {
            pushManager: {
              async getSubscription() {
                return {
                  endpoint: 'https://fcm.test/sub-activa',
                  async unsubscribe() {
                    browserUnsubscribed++;
                    return true;
                  },
                };
              },
            },
          };
        },
      },
    };
    const h = harness('?classroom=error&from=settings', async (url, options = {}) => {
      calls.push({ url, options });
      if (options.method === 'DELETE') return { ok: deleteOk };
      if (options.method === 'POST') return { ok: true };
      return { status: 401 };
    }, { navigatorImpl });
    try {
      await h.start();
      find(h.render(), 'AppLayout').props.onLogout();
      await find(h.render(), 'ConfirmDialog').props.req.onConfirm();
      const tree = h.render();
      assert.equal(calls[1].url, 'https://api.test/push/subscriptions');
      assert.equal(calls[1].options.method, 'DELETE');
      assert.deepEqual(JSON.parse(calls[1].options.body), { endpoint: 'https://fcm.test/sub-activa' });
      if (deleteOk) {
        assert.equal(browserUnsubscribed, 1);
        assert.equal(calls[2].url, 'https://api.test/auth/google/logout');
        assert.ok(find(tree, 'Onboarding'));
      } else {
        assert.equal(browserUnsubscribed, 0);
        assert.equal(calls.some(call => call.url.endsWith('/auth/google/logout')), false);
        assert.ok(find(tree, 'AppLayout'));
        assert.match(find(tree, 'ToastView').props.toast.text, /No se pudo cerrar la sesión/);
      }
    } finally {
      h.restore();
    }
  }
});

test('conectar inicia OAuth real y desconectar utiliza la ruta de autorización', async () => {
  const calls = [];
  const h = harness('', async (url, options) => { calls.push({ url, options }); return { ok: true }; });
  try {
    h.client.connectGoogle('settings');
    assert.deepEqual(h.assigned, ['https://api.test/auth/google?from=settings']);
    await h.client.disconnectGoogle();
    assert.equal(calls[0].url, 'https://api.test/auth/google/session');
    assert.equal(calls[0].options.method, 'DELETE');
    assert.equal(calls[0].options.credentials, 'include');
  } finally { h.restore(); }
});

test('resolveBackendUrl centraliza VITE_BACKEND_URL y valida el entorno de producción', () => {
  const { resolveBackendUrl } = compile('services/backend.ts', require, {});
  assert.equal(resolveBackendUrl({}), 'http://localhost:3000');
  assert.equal(resolveBackendUrl({ VITE_BACKEND_URL: 'https://api.itson.mx/' }), 'https://api.itson.mx');
  assert.equal(resolveBackendUrl({ PROD: true, VITE_BACKEND_URL: 'https://api.itson.mx/' }), 'https://api.itson.mx');

  assert.throws(() => resolveBackendUrl({ PROD: true }), /VITE_BACKEND_URL es obligatoria/);
  assert.throws(
    () => resolveBackendUrl({ PROD: true, VITE_BACKEND_URL: 'http://localhost:3000' }),
    /HTTPS y un dominio público/,
  );
  assert.throws(
    () => resolveBackendUrl({ PROD: true, VITE_BACKEND_URL: 'http://api.itson.mx' }),
    /HTTPS y un dominio público/,
  );
});
