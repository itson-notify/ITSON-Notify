// ITN-41: regresiones de navegación y cierre de sesión sin dependencias nuevas.
// Se ejercita App y el cliente HTTP reales con hooks/JSX y red controlados;
// no sustituye una prueba de navegador ni una autorización real con Google.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { harness, find } = require('./harness.cjs');

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
