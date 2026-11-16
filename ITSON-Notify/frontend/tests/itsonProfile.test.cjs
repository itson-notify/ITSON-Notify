// ITN-55: matrícula y carrera para las calificaciones finales. Cliente de
// /api/itson-profile, textos de error, el formulario (con hooks y red controlados) y la
// fila de Ajustes. Datos inventados; la matrícula se arma en tiempo de ejecución.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { compile, find } = require('./harness.cjs');

const MATRICULA = ['00000', '12', '34', '56'].join('');
const OTRA = ['00000', '65', '43', '21'].join('');
const CARRERA = 'INSOF';
const ENV = { VITE_BACKEND_URL: 'https://api.test/' };
const PERFIL = { configured: true, matriculaHint: '•••••••3456', career: CARRERA, updatedAt: '2026-11-13T12:00:00.000Z' };

const json = (body, status = 200, headers = {}) => ({
  ok: status < 400, status, json: async () => body, headers: { get: k => headers[k] ?? null },
});

function findAll(node, pred, out = []) {
  if (!node || typeof node !== 'object') return out;
  if (Array.isArray(node)) { node.forEach(n => findAll(n, pred, out)); return out; }
  if (node.type !== undefined && pred(node)) out.push(node);
  for (const value of Object.values(node.props ?? {})) {
    if (value && typeof value === 'object') findAll(value, pred, out);
  }
  return out;
}
const textOf = node => findAll(node, () => true).flatMap(n => [n.props?.children].flat(Infinity))
  .filter(c => typeof c === 'string').join(' ');

function withFetch(fetchImpl, fn) {
  const original = global.fetch;
  global.fetch = fetchImpl;
  return Promise.resolve().then(fn).finally(() => { global.fetch = original; });
}

function clients(env = ENV) {
  const backend = compile('services/backend.ts', require, env);
  const api = compile('services/api.ts', id => (id === '@/services/backend' ? backend : require(id)), env);
  const utils = compile('utils/itsonProfile.ts', id => (id === '@/services/api' ? api : require(id)), env);
  return { backend, api, utils };
}

function profileBackend({ get = () => json({ configured: false, matriculaHint: null, career: null, updatedAt: null }), put = () => json(PERFIL), del = () => ({ ok: true, status: 204 }) } = {}) {
  const calls = [];
  const fetchImpl = async (url, options = {}) => {
    const ruta = url.replace('https://api.test', '');
    calls.push({ ruta, method: options.method ?? 'GET', credentials: options.credentials, body: options.body });
    if (ruta !== '/api/itson-profile') return { ok: true, status: 204 };
    if ((options.method ?? 'GET') === 'GET') return get();
    if (options.method === 'PUT') return put(options);
    return del();
  };
  return { calls, fetchImpl };
}

// ── Cliente ─────────────────────────────────────────────────────────────────

test('GET, PUT y DELETE de /api/itson-profile con la cookie de sesión', async () => {
  const { api } = clients();
  const b = profileBackend();
  await withFetch(b.fetchImpl, async () => {
    assert.equal((await api.getItsonProfile()).configured, false);
    assert.deepEqual(await api.saveItsonProfile(MATRICULA, CARRERA), PERFIL);
    assert.equal(await api.deleteItsonProfile(), 'deleted');
  });
  assert.deepEqual(b.calls.map(c => [c.method, c.ruta, c.credentials]), [
    ['GET', '/api/itson-profile', 'include'],
    ['PUT', '/api/itson-profile', 'include'],
    ['DELETE', '/api/itson-profile', 'include'],
  ]);
  assert.deepEqual(JSON.parse(b.calls[1].body), { matricula: MATRICULA, career: CARRERA });
});

test('DELETE con 404 es "ya no estaba"', async () => {
  const { api } = clients();
  await withFetch(profileBackend({ del: () => json({ error: 'no_encontrado' }, 404) }).fetchImpl, async () => {
    assert.equal(await api.deleteItsonProfile(), 'already_deleted');
  });
});

test('ApiError lleva el código y Retry-After, pero nunca texto libre del body', async () => {
  const { api } = clients();
  const casos = [
    [json({ error: 'matricula_no_coincide' }, 400), { status: 400, code: 'matricula_no_coincide', retryAfter: undefined }],
    [json({ error: 'demasiados_intentos' }, 429, { 'Retry-After': '120' }), { status: 429, code: 'demasiados_intentos', retryAfter: 120 }],
    [json({ error: `Matrícula ${MATRICULA} inválida` }, 400), { status: 400, code: undefined, retryAfter: undefined }],
    [{ ok: false, status: 413, json: async () => { throw new SyntaxError('x'); } }, { status: 413, code: undefined, retryAfter: undefined }],
  ];
  for (const [respuesta, esperado] of casos) {
    await withFetch(async () => respuesta, async () => {
      const error = await api.saveItsonProfile(MATRICULA, CARRERA).catch(e => e);
      assert.ok(error instanceof api.ApiError);
      assert.deepEqual({ status: error.status, code: error.code, retryAfter: error.retryAfter }, esperado);
      assert.ok(!error.message.includes(MATRICULA) && !JSON.stringify(error).includes(MATRICULA));
    });
  }
});

test('con VITE_USE_MOCK=true no sale a la red y solo guarda la pista', async () => {
  const { api } = clients({ ...ENV, VITE_USE_MOCK: 'true' });
  let llamadas = 0;
  await withFetch(async () => { llamadas += 1; return json({}); }, async () => {
    assert.equal((await api.getItsonProfile()).configured, false);
    const guardado = await api.saveItsonProfile(MATRICULA, CARRERA);
    assert.equal(guardado.matriculaHint, '•••••••3456');
    assert.ok(!JSON.stringify(await api.getItsonProfile()).includes(MATRICULA));
    assert.equal(await api.deleteItsonProfile(), 'deleted');
    assert.equal(await api.deleteItsonProfile(), 'already_deleted');
  });
  assert.equal(llamadas, 0);
});

// ── Textos y validación ─────────────────────────────────────────────────────

test('mensajes legibles por código y status, sin el valor escrito', () => {
  const { api, utils } = clients();
  const texto = (status, code, retryAfter) => utils.itsonProfileErrorText(new api.ApiError(status, code, retryAfter));
  const casos = [
    [texto(400, 'correo_no_institucional'), /correo institucional \(@potros\.itson\.edu\.mx\)/],
    [texto(400, 'correo_sin_matricula'), /no termina con tu matrícula/],
    [texto(400, 'matricula_no_coincide'), /no corresponde a tu correo institucional/],
    [texto(400, 'cuerpo_invalido'), /Revisa la matrícula y la carrera/],
    [texto(400), /Revisa la matrícula y la carrera/],
    [texto(413), /demasiado grandes/],
    [texto(429, 'demasiados_intentos', 120), /Espera 2 minutos/],
    [texto(429, 'demasiados_intentos', 30), /Espera 1 minuto /],
    [texto(429), /Espera unos minutos/],
    [texto(500), /Intenta de nuevo más tarde/],
    [utils.itsonProfileErrorText(new TypeError(MATRICULA)), /Revisa tu conexión/],
  ];
  for (const [t, re] of casos) {
    assert.match(t, re);
    assert.ok(!t.includes(MATRICULA) && !t.includes('3456'));
  }
});

test('validación: matrícula de 11 dígitos con 00000 y carrera de 2 a 8 letras', () => {
  const { utils } = clients();
  assert.equal(utils.matriculaError(MATRICULA), undefined);
  assert.match(utils.matriculaError('00001123456'), /11 dígitos y empezar con 00000/);
  assert.match(utils.matriculaError('123'), /11 dígitos/);
  assert.equal(utils.careerError(CARRERA), undefined);
  assert.match(utils.careerError('I'), /2 a 8 letras/);
  assert.equal(utils.normalizeCareer(' in-sof9 '), 'INSOF');
  assert.equal(utils.onlyDigits('00000 12-34 567'), '00000123456');
});

// ── Formulario ──────────────────────────────────────────────────────────────

function mountForm({ env = ENV, props = {} } = {}) {
  const { backend, api, utils } = clients(env);
  const states = []; let cursor = 0;
  const hooks = {
    useState(initial) {
      const index = cursor++;
      if (!(index in states)) states[index] = typeof initial === 'function' ? initial() : initial;
      return [states[index], value => { states[index] = typeof value === 'function' ? value(states[index]) : value; }];
    },
  };
  const jsx = (type, p) => ({ type, props: p });
  const { ItsonProfileForm } = compile('components/ItsonProfileForm.tsx', id => {
    if (id === 'react') return hooks;
    if (id === 'react/jsx-runtime') return { jsx, jsxs: jsx, Fragment: 'Fragment' };
    if (id === '@/services/api') return api;
    if (id === '@/services/backend') return backend;
    if (id === '@/utils/itsonProfile') return utils;
    return new Proxy({}, { get: (_, key) => key });
  }, env);
  const events = { saved: [], expired: 0 };
  const allProps = { onSaved: p => events.saved.push(p), onSessionExpired: () => { events.expired += 1; }, ...props };
  return { events, states, render() { cursor = 0; return ItsonProfileForm(allProps); } };
}
const settle = () => new Promise(setImmediate);
const campo = (tree, id) => findAll(tree, n => n.type === 'TextField' && n.props.id === id)[0];

async function llenarYEnviar(form, { matricula = MATRICULA, career = 'insof' } = {}) {
  campo(form.render(), 'itson-matricula').props.onChange(matricula);
  campo(form.render(), 'itson-carrera').props.onChange(career);
  const tree = form.render();
  find(tree, 'form').props.onSubmit({ preventDefault() {} });
  return form.render();
}

test('envía matrícula y carrera en mayúsculas, y borra la matrícula antes de la respuesta', async () => {
  const b = profileBackend();
  await withFetch(b.fetchImpl, async () => {
    const form = mountForm();
    const enviando = await llenarYEnviar(form);
    assert.equal(campo(enviando, 'itson-matricula').props.value, '');
    await settle();
    assert.deepEqual(form.events.saved, [PERFIL]);
  });
  assert.deepEqual(JSON.parse(b.calls[0].body), { matricula: MATRICULA, career: CARRERA });
});

test('matrícula que no corresponde: mensaje legible sin repetir lo escrito', async () => {
  const b = profileBackend({ put: () => json({ error: 'matricula_no_coincide' }, 400) });
  await withFetch(b.fetchImpl, async () => {
    const form = mountForm();
    await llenarYEnviar(form, { matricula: OTRA });
    await settle();
    const tree = form.render();
    const alerta = findAll(tree, n => n.props?.role === 'alert')[0];
    assert.match(textOf(alerta), /no corresponde a tu correo institucional/);
    assert.ok(!JSON.stringify(tree).includes(OTRA));
    assert.equal(form.events.saved.length, 0);
  });
});

test('401 al guardar: avisa que la sesión expiró', async () => {
  await withFetch(profileBackend({ put: () => json({ error: 'no_autenticado' }, 401) }).fetchImpl, async () => {
    const form = mountForm();
    await llenarYEnviar(form);
    await settle();
    assert.equal(form.events.expired, 1);
  });
});

test('con datos inválidos no envía y el error de campo no repite el valor', async () => {
  const b = profileBackend();
  await withFetch(b.fetchImpl, async () => {
    const form = mountForm();
    campo(form.render(), 'itson-matricula').props.onChange('00001123456');
    campo(form.render(), 'itson-matricula').props.onBlur();
    const tree = form.render();
    assert.equal(findAll(tree, n => n.type === 'Button' && n.props.type === 'submit')[0].props.disabled, true);
    assert.match(campo(tree, 'itson-matricula').props.error, /11 dígitos/);
    assert.ok(!campo(tree, 'itson-matricula').props.error.includes('00001123456'));
    find(tree, 'form').props.onSubmit({ preventDefault() {} });
  });
  assert.equal(b.calls.length, 0);
});

test('el formulario no escribe en consola ni en almacenamiento', async () => {
  const capturado = [];
  const originales = { console: { ...console }, localStorage: global.localStorage, sessionStorage: global.sessionStorage };
  for (const nivel of ['log', 'info', 'warn', 'error', 'debug']) console[nivel] = (...a) => capturado.push(a.join(' '));
  const storage = () => ({ setItem: (k, v) => capturado.push(`${k}=${v}`), getItem: () => null, removeItem() {}, clear() {} });
  global.localStorage = storage(); global.sessionStorage = storage();
  try {
    await withFetch(profileBackend({ put: () => json({ error: 'matricula_no_coincide' }, 400) }).fetchImpl, async () => {
      const form = mountForm();
      await llenarYEnviar(form);
      await settle();
    });
  } finally {
    Object.assign(console, originales.console);
    global.localStorage = originales.localStorage; global.sessionStorage = originales.sessionStorage;
  }
  assert.ok(!capturado.join('\n').includes(MATRICULA));
});

// ── Ajustes ─────────────────────────────────────────────────────────────────

function renderSettings(itsonProfile, settings = {}) {
  const jsx = (type, p) => ({ type, props: p });
  const time = compile('utils/time.ts', require);
  const { SettingsPage } = compile('pages/SettingsPage.tsx', id => {
    if (id === 'react/jsx-runtime') return { jsx, jsxs: jsx, Fragment: 'Fragment' };
    if (id === '@/components/icons') return { I: new Proxy({}, { get: () => () => null }) };
    if (id === '@/utils/time') return time;
    return new Proxy({}, { get: (_, key) => key });
  });
  const events = { edit: 0, remove: 0 };
  const tree = SettingsPage({
    settings: { itsonStatus: 'ok', itsonId: MATRICULA, classroomConnected: false, categories: {}, pushOn: true, emailOn: true, ...settings },
    setSettings() {}, onFix() {}, askConfirm() {}, notify() {},
    itsonProfile, onEditItsonProfile: () => { events.edit += 1; }, onRemoveItsonProfile: () => { events.remove += 1; },
  });
  const botones = findAll(tree, n => n.type === 'button');
  const boton = texto => botones.find(n => n.props.children === texto);
  // Todo lo que se pinta: textos y props de texto de cada nodo. No incluye objetos que
  // se pasan a otros componentes (como `settings` a CategoryRows).
  const visible = findAll(tree, () => true)
    .flatMap(n => [n.props?.children, ...Object.values(n.props ?? {})].flat(Infinity))
    .filter(v => typeof v === 'string').join(' ');
  return { tree, texto: textOf(tree), json: visible, boton, events };
}

test('Ajustes muestra la pista de la API y nunca el itsonId local', () => {
  const r = renderSettings(PERFIL);
  assert.ok(!r.json.includes(MATRICULA), 'apareció la matrícula completa');
  assert.match(r.json, /•••••••3456/);
  r.boton('Editar matrícula').props.onClick();
  r.boton('Quitar matrícula').props.onClick();
  assert.deepEqual(r.events, { edit: 1, remove: 1 });
});

test('Ajustes sin perfil ofrece agregar; sin estado no ofrece quitar', () => {
  const sin = renderSettings({ configured: false, matriculaHint: null, career: null, updatedAt: null });
  assert.ok(sin.boton('Agregar matrícula'));
  assert.equal(sin.boton('Quitar matrícula'), undefined);
  const desconocido = renderSettings(null);
  assert.match(desconocido.json, /Estado no disponible/);
  assert.equal(desconocido.boton('Quitar matrícula'), undefined);
  assert.ok(!desconocido.json.includes(MATRICULA));
});
