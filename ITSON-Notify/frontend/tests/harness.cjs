// Ejercita App y los clientes HTTP reales con hooks/JSX y red controlados, sin
// dependencias nuevas. No sustituye una prueba de navegador.
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

// Sin `useMock: false`, la app corre con VITE_USE_MOCK=true. `navigatorImpl`
// simula el Service Worker para las pruebas de Web Push.
function harness(search, fetchImpl, { useMock = true, initialNotifs = [], navigatorImpl = {} } = {}) {
  const originals = {
    window: global.window, fetch: global.fetch, setTimeout: global.setTimeout,
    navigator: Object.getOwnPropertyDescriptor(global, 'navigator'),
  };
  const assigned = [];
  const history = [];
  global.window = { location: { search, pathname: '/app', assign: url => assigned.push(url) },
    history: { replaceState: (...args) => history.push(args) },
    addEventListener() {}, removeEventListener() {}, scrollTo() {},
    atob: str => Buffer.from(str, 'base64').toString('binary'),
    PushManager: function PushManager() {} };
  global.fetch = fetchImpl;
  global.setTimeout = () => 1;
  global.document = { title: 'ITSON Notify' };
  Object.defineProperty(global, 'navigator', { value: navigatorImpl, configurable: true, writable: true });
  const env = { VITE_BACKEND_URL: 'https://api.test/', ...(useMock ? { VITE_USE_MOCK: 'true' } : {}) };
  const backend = compile('services/backend.ts', require, env);
  const clientRequire = id => (id === '@/services/backend' ? backend : require(id));
  const client = compile('services/googleAuth.ts', clientRequire, env);
  const api = compile('services/api.ts', clientRequire, env);
  const push = compile('services/pushNotifications.ts', clientRequire, env);
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
    if (id === '@/services/backend') return backend;
    if (id === '@/services/googleAuth') return client;
    if (id === '@/services/api') return api;
    if (id === '@/services/pushNotifications') return push;
    if (id === '@/services/mockData') return { DEFAULT_SETTINGS: {
      categories: { calificaciones: true }, classroomConnected: false, itsonStatus: 'ok',
    }, INITIAL_NOTIFS: initialNotifs };
    return new Proxy({}, { get: (_, key) => key });
  }, env).default;
  return {
    backend, client, api, push, assigned, history,
    render() { cursor = 0; const tree = App(); mounted = true; return tree; },
    async start() { const tree = this.render(); effects.forEach(effect => effect()); await settle(); return tree; },
    settle,
    restore() {
      global.window = originals.window; global.fetch = originals.fetch; global.setTimeout = originals.setTimeout;
      delete global.document;
      if (originals.navigator) Object.defineProperty(global, 'navigator', originals.navigator);
      else delete global.navigator;
    },
  };
}

const settle = () => new Promise(setImmediate);

function find(node, type) {
  if (!node || typeof node !== 'object') return null;
  if (node.type === type) return node;
  const children = [node.props?.children].flat(Infinity);
  for (const child of children) { const found = find(child, type); if (found) return found; }
  return null;
}

module.exports = { compile, harness, find };
