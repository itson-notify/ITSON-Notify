// Standalone offline integration test. Creates its own cluster; never accepts a DB URL.
// node scripts/verify-classroom-sync-sql.cjs "C:/Program Files/PostgreSQL/18/bin"
const fs = require('node:fs');
const path = require('node:path');
const net = require('node:net');
const { spawnSync, spawn } = require('node:child_process');
const assert = require('node:assert/strict');
const bin = process.argv[2];
if (!bin) throw new Error('Provide a local PostgreSQL bin directory');
const root = fs.mkdtempSync(path.resolve(__dirname, '../../../.itn43-sql-'));
const data = path.join(root, 'data');
const env = { SystemRoot: process.env.SystemRoot, PATH: process.env.PATH, TEMP: root, TMP: root,
  LC_ALL: 'C', PGCONNECT_TIMEOUT: '5' };
const executable = name => path.join(bin, name + (process.platform === 'win32' ? '.exe' : ''));
function run(name, args, input) {
  // On Windows a daemon can inherit pipe handles and keep spawnSync blocked.
  const output = path.join(root, 'command-output.txt');
  const fd = fs.openSync(output, 'w');
  let result;
  try {
    result = spawnSync(executable(name), args, { env, input, encoding: 'utf8', windowsHide: true,
      timeout: 30000, stdio: [input === undefined ? 'ignore' : 'pipe', fd, fd] });
  } finally { fs.closeSync(fd); }
  const text = fs.readFileSync(output, 'utf8');
  if (result.error || result.status !== 0) throw Error(`${name} failed: ${result.error ?? text}`);
  return text;
}
async function main() {
  let started = false;
  try {
    run('initdb', ['-D', data, '-U', 'classroom_test', '--auth=trust', '--no-locale', '--encoding=UTF8']);
    const port = await new Promise(resolve => {
      const server = net.createServer();
      server.listen(0, '127.0.0.1', () => { const p = server.address().port; server.close(() => resolve(p)); });
    });
    run('pg_ctl', ['-D', data, '-l', path.join(root, 'server.log'), '-o', `-h 127.0.0.1 -p ${port} -F`, '-w', 'start']);
    started = true;
    const args = ['-X', '-h', '127.0.0.1', '-p', String(port), '-U', 'classroom_test', '-d', 'postgres', '-v', 'ON_ERROR_STOP=1'];
    const sql = text => run('psql', args, text);
    sql(`create role anon; create role authenticated; create role service_role bypassrls;
      create table public.app_users(id uuid primary key);
      grant select, update on app_users to service_role;`);
    const migrations = path.resolve(__dirname, '../../database/migrations');
    for (const file of ['006_classroom_courses_coursework.sql', '008_google_classroom_authorization.sql',
      '014_google_authorization_status.sql']) {
      sql(fs.readFileSync(path.join(migrations, file), 'utf8'));
    }
    const migration = fs.readFileSync(path.join(migrations, '016_classroom_sync.sql'), 'utf8');
    assert.doesNotMatch(migration, /^\s*(begin|commit)\s*;/im);
    const absent = () => assert.match(sql(`select case when to_regclass('public.classroom_task_events') is null
      and to_regprocedure('public.sync_classroom(uuid,text,jsonb)') is null
      then 'MIGRATION_ROLLBACK_OK' else 'FAILED' end;`), /MIGRATION_ROLLBACK_OK/);
    sql(`begin;\n${migration}\nrollback;`);
    absent();
    assert.throws(() => sql(`begin;\n${migration}\nselect 1/0;\ncommit;`), /psql failed/);
    absent();
    for (let attempt = 0; attempt < 2; attempt++) sql(`begin;\n${migration}\ncommit;`);
    sql(fs.readFileSync(path.resolve(__dirname, '../tests/sql/classroomSync.sql'), 'utf8'));
    // Real privilege failures share 42501 but must never emit the business marker.
    for (const [table, privilege] of [['app_users', 'update'], ['google_authorizations', 'select']]) {
      sql(`revoke ${privilege} on public.${table} from service_role;`);
      sql(`set role service_role; do $$ begin
        begin
          perform sync_classroom('00000000-0000-4000-8000-000000000001','g1','[]'::jsonb);
          raise exception 'missing infrastructure privilege accepted';
        exception when insufficient_privilege then
          if sqlerrm = 'classroom_authorization_required' then
            raise exception 'infrastructure failure used business marker';
          end if;
        end;
      end; $$; reset role;`);
      sql(`grant ${privilege} on public.${table} to service_role;`);
    }
    const concurrent = text => new Promise((resolve, reject) => {
      const child = spawn(executable('psql'), args, { env, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
      let out = '', err = '';
      child.stdout.on('data', s => { out += s; }); child.stderr.on('data', s => { err += s; });
      child.on('error', reject); child.on('close', code => code === 0 ? resolve(out) : reject(Error(err)));
      child.stdin.end(text);
    });
    // Overlap writers for the same student; only one may insert the event.
    const call = `set role service_role; select test_snapshot('00000000-0000-4000-8000-000000000001','g1',array['w1','w2','w3','concurrent']);`;
    const results = await Promise.all([concurrent(`begin; ${call} select pg_sleep(0.2); commit;`), concurrent(call)]);
    assert.equal(results.filter(out => /"newTasks": 1/.test(out)).length, 1);
    assert.equal(results.filter(out => /"newTasks": 0/.test(out)).length, 1);
    sql(`select test_assert((select count(*) = 1 from classroom_task_events e join classroom_coursework w on w.id = e.coursework_id
      where w.external_coursework_id = 'concurrent'), 'concurrent unique event');`);
    console.log('CLASSROOM_SQL_OK: baseline, dedup, timestamps, isolation, relink, rollback, concurrent writers, RLS, migration replay, external transaction rollback');
  } catch (error) {
    console.error(error.message);
    throw error;
  } finally {
    if (started || fs.existsSync(path.join(data, 'postmaster.pid'))) run('pg_ctl', ['-D', data, '-m', 'fast', '-w', 'stop']);
    fs.rmSync(root, { recursive: true, force: true });
  }
}
main().catch(error => { console.error(error.message); process.exitCode = 1; });
