const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const backend = path.resolve(__dirname, '../..');
const workspace = path.resolve(backend, '../..');

function artifact(t) {
  // No automation sibling, .env, real secrets or ancestor npm modules.
  const root = fs.mkdtempSync(path.join(workspace, '.itn42-artifact-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  fs.cpSync(path.join(backend, 'src'), path.join(root, 'src'), { recursive: true });
  fs.copyFileSync(path.join(backend, 'package.json'), path.join(root, 'package.json'));
  fs.copyFileSync(path.join(backend, 'tests/helpers/offlineNetwork.cjs'), path.join(root, 'offlineNetwork.cjs'));
  return root;
}

function environment() {
  // Do not inherit service credentials or NODE_OPTIONS from the host.
  return {
    SystemRoot: process.env.SystemRoot,
    PATH: process.env.PATH,
    NODE_PATH: path.join(backend, 'node_modules'),
    PORT: '3000', INTERNAL_API_KEY: 'synthetic-packaging-key-'.repeat(2),
    SUPABASE_URL: 'https://synthetic.supabase.test',
    SUPABASE_SERVICE_ROLE_KEY: 'synthetic-service-role',
    CREDENTIALS_ENCRYPTION_KEY: Buffer.alloc(32, 7).toString('base64'),
    GOOGLE_AUTH_SECRET: 'synthetic-packaging-secret-'.repeat(2),
    GOOGLE_OAUTH_ENABLED: 'false',
  };
}

test('backend-only artifact starts the actual server and serves health offline', t => {
  const root = artifact(t);
  assert.equal(fs.existsSync(path.join(root, '../automation')), false);
  // Bind an ephemeral local port and verify health without changing production code.
  fs.writeFileSync(path.join(root, 'smoke.cjs'), `
    const assert = require('node:assert/strict');
    const http = require('node:http');
    const listen = http.Server.prototype.listen;
    http.Server.prototype.listen = function (_port, callback) {
      return listen.call(this, 0, '127.0.0.1', () => {
        callback?.();
        http.get('http://127.0.0.1:' + this.address().port + '/health', res => {
          let body = '';
          res.on('data', data => { body += data; });
          res.on('end', () => {
            assert.equal(res.statusCode, 200);
            assert.deepEqual(JSON.parse(body), { status: 'ok' });
            this.close(() => { process.stdout.write('PACKAGING_HEALTH_OK\\n'); });
          });
        }).on('error', error => { throw error; });
      });
    };
    require('./src/server');
  `);
  const result = spawnSync(process.execPath, ['--require', './offlineNetwork.cjs', 'smoke.cjs'], {
    cwd: root, env: environment(), encoding: 'utf8', timeout: 10000, windowsHide: true,
  });
  assert.equal(result.error, undefined);
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /PACKAGING_HEALTH_OK/);
  assert.doesNotMatch(result.stderr, /MODULE_NOT_FOUND|External network forbidden/);
});

test('artifact startup fails with MODULE_NOT_FOUND when the shared client is absent', t => {
  const root = artifact(t);
  fs.unlinkSync(path.join(root, 'src/services/classroomClient.js'));
  const result = spawnSync(process.execPath, ['--require', './offlineNetwork.cjs', 'src/server.js'], {
    cwd: root, env: environment(), encoding: 'utf8', timeout: 10000, windowsHide: true,
  });
  assert.equal(result.error, undefined);
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /MODULE_NOT_FOUND/);
  assert.match(result.stderr, /classroomClient/);
});
