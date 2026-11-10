// ITN-41 y Web Push: regresiones de navegación, cierre de sesión, revocación Push
// y configuración centralizada del backend sin dependencias nuevas. El harness
// (tests/harness.cjs) no sustituye una prueba de navegador ni una autorización real.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { compile, harness, find } = require('./harness.cjs');

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

test('cerrar sesión con suscripción Push activa la revoca en backend y navegador antes del logout, y si falla cierra la sesión igual', async () => {
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
    const originalWarn = console.warn;
    console.warn = () => {};
    try {
      await h.start();
      find(h.render(), 'AppLayout').props.onLogout();
      await find(h.render(), 'ConfirmDialog').props.req.onConfirm();
      const tree = h.render();
      assert.equal(calls[1].url, 'https://api.test/push/subscriptions');
      assert.equal(calls[1].options.method, 'DELETE');
      assert.deepEqual(JSON.parse(calls[1].options.body), { endpoint: 'https://fcm.test/sub-activa' });
      // El navegador solo se desuscribe si el backend ya borró la suscripción;
      // el logout de Google se intenta siempre.
      assert.equal(browserUnsubscribed, deleteOk ? 1 : 0);
      assert.equal(calls[2].url, 'https://api.test/auth/google/logout');
      assert.ok(find(tree, 'Onboarding'));
    } finally {
      console.warn = originalWarn;
      h.restore();
    }
  }
});

test('si unsubscribeBrowserPush rechaza, igual llama a logoutGoogle y termina la sesión sin toast de error', async () => {
  const calls = [];
  const warnings = [];
  const h = harness('?classroom=error&from=settings', async (url, options = {}) => {
    calls.push({ url, options });
    return options.method === 'POST' ? { ok: true } : { status: 401 };
  }, { pushOverrides: { unsubscribeBrowserPush: async () => { throw new Error('error_eliminando_suscripcion'); } } });
  const originalWarn = console.warn;
  console.warn = (...args) => warnings.push(args);
  try {
    await h.start();
    find(h.render(), 'AppLayout').props.onLogout();
    await find(h.render(), 'ConfirmDialog').props.req.onConfirm();
    const tree = h.render();
    const logoutCalls = calls.filter(call => call.url === 'https://api.test/auth/google/logout');
    assert.equal(logoutCalls.length, 1);
    assert.equal(logoutCalls[0].options.method, 'POST');
    assert.ok(find(tree, 'Onboarding'));
    assert.equal(find(tree, 'AppLayout'), null);
    // El único toast es el de ?classroom=error al arrancar, no el del logout.
    assert.doesNotMatch(find(tree, 'ToastView')?.props.toast?.text ?? '', /No se pudo cerrar la sesión/);
    // La advertencia es un código fijo, sin el error ni datos del alumno.
    assert.deepEqual(warnings, [['push_unsubscribe_failed']]);
  } finally {
    console.warn = originalWarn;
    h.restore();
  }
});

test('si falla logoutGoogle tras revocar el Push, avisa y no termina la sesión', async () => {
  const h = harness('?classroom=error&from=settings', async (url, options = {}) => (
    options.method === 'POST' ? { ok: false } : { status: 401 }
  ), { pushOverrides: { unsubscribeBrowserPush: async () => {} } });
  try {
    await h.start();
    find(h.render(), 'AppLayout').props.onLogout();
    await find(h.render(), 'ConfirmDialog').props.req.onConfirm();
    const tree = h.render();
    assert.equal(find(tree, 'Onboarding'), null);
    assert.ok(find(tree, 'AppLayout'));
    assert.match(find(tree, 'ToastView').props.toast.text, /No se pudo cerrar la sesión/);
  } finally { h.restore(); }
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

test('en modo mock resolveBackendUrl no valida producción y conserva la URL', () => {
  const { resolveBackendUrl } = compile('services/backend.ts', require, {});
  const prodMock = { PROD: true, MODE: 'production', VITE_USE_MOCK: 'true' };
  assert.equal(resolveBackendUrl(prodMock), 'http://localhost:3000');
  assert.equal(resolveBackendUrl({ ...prodMock, VITE_BACKEND_URL: 'http://localhost:3000' }), 'http://localhost:3000');
  assert.equal(resolveBackendUrl({ ...prodMock, VITE_BACKEND_URL: 'https://api.itson.mx/' }), 'https://api.itson.mx');
  // Solo 'true' activa el modo mock; cualquier otro valor sigue validando.
  assert.throws(() => resolveBackendUrl({ PROD: true, VITE_USE_MOCK: 'false' }), /VITE_BACKEND_URL es obligatoria/);
});

test('el módulo backend carga en un build de producción mock sin VITE_BACKEND_URL', () => {
  const backend = compile('services/backend.ts', require, { PROD: true, MODE: 'production', VITE_USE_MOCK: 'true' });
  assert.equal(backend.mockMode, true);
  assert.equal(backend.backendUrl, 'http://localhost:3000');
});
