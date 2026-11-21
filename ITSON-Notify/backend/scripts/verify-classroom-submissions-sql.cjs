// ITN-58f. Clúster desechable solamente: sin URL de BD, sin variables PG heredadas ni datos reales.
//   node scripts/verify-classroom-submissions-sql.cjs "/ruta/a/postgresql/bin"
//   node scripts/verify-classroom-submissions-sql.cjs --docker postgres:16
// El modo --docker usa una imagen YA presente (--pull never), sin puertos publicados, y borra
// el contenedor al terminar.
const fs = require('node:fs');
const path = require('node:path');
const net = require('node:net');
const crypto = require('node:crypto');
const { spawnSync } = require('node:child_process');
const assert = require('node:assert/strict');

const migrations = path.resolve(__dirname, '../../database/migrations');
const tests = path.resolve(__dirname, '../tests/sql');
const read = file => fs.readFileSync(file, 'utf8');

function runner(argv) {
  if (argv[0] === '--docker') {
    const image = argv[1];
    if (!image || !/^[a-z0-9./:_-]+$/i.test(image)) throw Error('BLOCKED: provide a local docker image');
    const name = `itn58f-sql-${crypto.randomBytes(4).toString('hex')}`;
    const docker = (args, input) => {
      const r = spawnSync('docker', args, { input, encoding: 'utf8', timeout: 60000,
        stdio: [input === undefined ? 'ignore' : 'pipe', 'pipe', 'pipe'] });
      if (r.error || r.status !== 0) throw Error(`docker failed: ${r.error ?? r.stderr}`);
      return r.stdout;
    };
    return {
      async start() {
        docker(['run', '-d', '--rm', '--pull', 'never', '--name', name, '--network', 'none',
          '-e', 'POSTGRES_HOST_AUTH_METHOD=trust', '-e', 'POSTGRES_USER=classroom_test', image]);
        const end = Date.now() + 30000;
        for (;;) {
          const r = spawnSync('docker', ['exec', name, 'pg_isready', '-h', '127.0.0.1', '-U', 'classroom_test'], { encoding: 'utf8' });
          // El entrypoint reinicia el servidor una vez; se espera a una conexión TCP estable.
          if (r.status === 0 && spawnSync('docker', ['exec', name, 'psql', '-h', '127.0.0.1', '-U', 'classroom_test',
            '-d', 'postgres', '-c', 'select 1'], { encoding: 'utf8' }).status === 0) break;
          if (Date.now() > end) throw Error('FAIL: postgres container not ready');
          await new Promise(resolve => setTimeout(resolve, 500));
        }
      },
      sql: text => docker(['exec', '-i', name, 'psql', '-X', '-q', '-A', '-t', '-h', '127.0.0.1', '-U', 'classroom_test',
        '-d', 'postgres', '-v', 'ON_ERROR_STOP=1', '-v', 'VERBOSITY=verbose'], text),
      stop() { spawnSync('docker', ['rm', '-f', name], { stdio: 'ignore' }); },
    };
  }
  const bin = argv[0];
  if (!bin) throw Error('BLOCKED: provide an existing PostgreSQL bin directory or --docker <local image>');
  const executable = n => path.join(bin, n + (process.platform === 'win32' ? '.exe' : ''));
  for (const n of ['psql', 'initdb', 'pg_ctl']) {
    if (!fs.existsSync(executable(n))) throw Error(`BLOCKED: missing local ${n}`);
  }
  const root = fs.mkdtempSync(path.resolve(__dirname, '../../../.itn58f-submissions-sql-'));
  const data = path.join(root, 'data');
  const env = { SystemRoot: process.env.SystemRoot, PATH: process.env.PATH, TEMP: root, TMP: root,
    LC_ALL: 'C', PGCONNECT_TIMEOUT: '5' };
  let started = false;
  let args;
  const run = (n, a, input) => {
    const r = spawnSync(executable(n), a, { env, input, encoding: 'utf8', windowsHide: true, timeout: 30000,
      stdio: [input === undefined ? 'ignore' : 'pipe', 'pipe', 'pipe'] });
    if (r.error || r.status !== 0) throw Error(`${n} failed: ${r.error ?? r.stdout + r.stderr}`);
    return r.stdout;
  };
  return {
    async start() {
      run('initdb', ['-D', data, '-U', 'classroom_test', '--auth=trust', '--no-locale', '--encoding=UTF8']);
      const port = await new Promise(resolve => {
        const server = net.createServer();
        server.listen(0, '127.0.0.1', () => { const p = server.address().port; server.close(() => resolve(p)); });
      });
      run('pg_ctl', ['-D', data, '-l', path.join(root, 'server.log'), '-o', `-h 127.0.0.1 -p ${port} -F`, '-w', 'start']);
      started = true;
      args = ['-X', '-q', '-A', '-t', '-h', '127.0.0.1', '-p', String(port), '-U', 'classroom_test',
        '-d', 'postgres', '-v', 'ON_ERROR_STOP=1', '-v', 'VERBOSITY=verbose'];
    },
    sql: text => run('psql', args, text),
    stop() {
      if (started) run('pg_ctl', ['-D', data, '-m', 'fast', '-w', 'stop']);
      // Solo se borra el directorio exacto creado arriba.
      assert.ok(path.basename(root).startsWith('.itn58f-submissions-sql-'));
      fs.rmSync(root, { recursive: true, force: true });
    },
  };
}

async function main() {
  const pg = runner(process.argv.slice(2));
  try {
    await pg.start();
    const sql = pg.sql;
    const version = sql("select current_setting('server_version');").trim();
    sql(`create role anon; create role authenticated; create role service_role bypassrls;
      create table public.app_users(id uuid primary key); grant select, update on app_users to service_role;`);
    for (const f of ['006_classroom_courses_coursework.sql', '008_google_classroom_authorization.sql',
      '014_google_authorization_status.sql']) sql(read(path.join(migrations, f)));
    for (const f of ['016_classroom_sync.sql', '017_classroom_baseline.sql', '018_classroom_tasks_authorization.sql',
      '019_classroom_notification_deliveries.sql', '021_classroom_revoke_sync.sql']) {
      sql(`begin; ${read(path.join(migrations, f))} commit;`);
    }
    const m022 = read(path.join(migrations, '022_classroom_submissions.sql'));
    assert.doesNotMatch(m022, /^\s*(begin|commit)\s*;/im, '022 lets the runner own the transaction');
    // 022 no redefine funciones ni tablas de 017/018/019/021.
    assert.doesNotMatch(m022, /create\s+(or\s+replace\s+)?function\s+public\.(sync_classroom|disable_classroom_tasks|activate_classroom_tasks|materialize_classroom_deliveries)\s*\(/i);
    const snapshot = () => sql(`select string_agg(p.oid::regprocedure::text || md5(pg_get_functiondef(p.oid)), ',' order by 1)
      from pg_proc p where p.pronamespace = 'public'::regnamespace;`);
    const before = snapshot();
    const absent = () => assert.equal(sql(`select to_regclass('public.classroom_submissions') is null
      and to_regprocedure('public.sync_classroom_submissions(uuid,text,jsonb)') is null;`).trim(), 't');
    sql(`begin; ${m022} rollback;`); absent();
    assert.throws(() => sql(`begin; ${m022} select 1/0; commit;`), /22012/); absent();
    for (let i = 0; i < 2; i++) sql(`begin; ${m022} commit;`);
    console.log(`PASS: 022 rollback, failed-transaction rollback and replay (PostgreSQL ${version})`);
    const after = snapshot();
    const existing = before.split(',');
    assert.ok(existing.every(entry => after.split(',').includes(entry)), 'existing functions unchanged by 022');
    console.log('PASS: sync_classroom, disable/activate_classroom_tasks and 019 functions unchanged');

    sql(read(path.join(tests, 'classroomSubmissions.sql')));
    console.log('PASS: upsert known tasks, idempotence, validation, authorization, no-op without task scope');
    console.log('PASS: disable_classroom_tasks cascades submissions; stale batch does not resurrect; ACL/RLS');

    // Rollback documentado en la cabecera de 022.
    const rollback = [...m022.matchAll(/^--\s+(drop .+;)$/gim)].map(m => m[1]).join('\n');
    assert.match(rollback, /drop function/); assert.match(rollback, /drop table/);
    sql(`begin; ${rollback} commit;`); absent();
    assert.equal(sql(`select count(*) from pg_proc where oid = 'public.sync_classroom(uuid,text,jsonb)'::regprocedure;`).trim(), '1');
    console.log('PASS: documented rollback removes only 022 objects');
    console.log(`CLASSROOM_SUBMISSIONS_SQL_OK (PostgreSQL ${version} real, disposable cluster)`);
  } finally {
    pg.stop();
  }
}
main().catch(error => { console.error(`FAIL: ${error.stack}`); process.exitCode = 1; });
