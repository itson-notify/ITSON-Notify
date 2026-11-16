const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const automation = path.resolve(__dirname, '../../..');
const workspace = path.resolve(automation, '../..');
test('isolated automation artifact starts the real cron and imports Classroom without backend', t => {
  const root = fs.mkdtempSync(path.join(workspace, '.itn59-automation-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  fs.cpSync(automation, root, { recursive: true, filter: source =>
    !['node_modules', '.env'].includes(path.basename(source)) });
  fs.writeFileSync(path.join(root, 'offline.cjs'), `
    const forbidden = () => { throw new Error('External network forbidden'); };
    globalThis.fetch = forbidden;
    for (const name of ['node:http', 'node:https']) {
      require(name).request = forbidden; require(name).get = forbidden;
    }
    const Module = require('node:module');
    const resolve = Module._resolveFilename;
    Module._resolveFilename = function (...args) {
      const file = resolve.apply(this, args);
      if (/[\\\\/]backend[\\\\/]/.test(file)) throw new Error('Backend dependency forbidden');
      return file;
    };
    const { createClassroomWorkerClient } = require('./rpa/google-classroom');
    if (typeof createClassroomWorkerClient !== 'function') throw new Error('Missing worker client');
  `);
  const result = spawnSync(process.execPath, ['--require', './offline.cjs', 'schedulers/extraccion-cron.js'], {
    cwd: root, encoding: 'utf8', timeout: 10000, windowsHide: true,
    env: { SystemRoot: process.env.SystemRoot, PATH: process.env.PATH,
      NODE_PATH: path.join(automation, 'node_modules'), RPA_PAUSADO: 'true' },
  });
  assert.equal(result.error, undefined);
  assert.equal(result.status, 0, result.stderr);
  assert.doesNotMatch(result.stderr, /MODULE_NOT_FOUND|Backend dependency|External network/);
  assert.match(result.stdout, /pausado/i);
});
