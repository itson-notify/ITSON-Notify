// ITN-41: regresiones de navegación y cierre de sesión sin dependencias nuevas.
// Se ejercita App y el cliente HTTP reales con hooks/JSX y red controlados;
// no sustituye una prueba de navegador ni una autorización real con Google.
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

function harness(search, fetchImpl) {
  const originals = { window: global.window, fetch: global.fetch, setTimeout: global.setTimeout };
  const assigned = [];
  const history = [];
  global.window = { location: { search, pathname: '/app', assign: url => assigned.push(url) },
    history: { replaceState: (...args) => history.push(args) },
    addEventListener() {}, removeEventListener() {}, scrollTo() {} };
  global.fetch = fetchImpl;
  global.setTimeout = () => 1;
  global.document = { title: 'ITSON Notify' };
  const client = compile('services/googleAuth.ts', require, { VITE_BACKEND_URL: 'https://api.test/' });
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
    if (id === '@/services/googleAuth') return client;
    if (id === '@/services/mockData') return { DEFAULT_SETTINGS: {
      categories: {}, classroomConnected: false, itsonStatus: 'ok',
    }, INITIAL_NOTIFS: [] };
    return new Proxy({}, { get: (_, key) => key });
  }).default;
  return {
    client, assigned, history,
    render() { cursor = 0; const tree = App(); mounted = true; return tree; },
    async start() { const tree = this.render(); effects.forEach(effect => effect()); await new Promise(setImmediate); return tree; },
    restore() { global.window = originals.window; global.fetch = originals.fetch; global.setTimeout = originals.setTimeout; delete global.document; },
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
