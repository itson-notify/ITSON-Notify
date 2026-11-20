// Standalone offline integration test. Creates its own cluster; never accepts a DB URL.
// node scripts/verify-classroom-sync-sql.cjs "C:/Program Files/PostgreSQL/18/bin"
// node scripts/verify-classroom-sync-sql.cjs --docker postgres:16   (contenedor desechable, --network none)
const fs = require('node:fs');
const path = require('node:path');
const net = require('node:net');
const { spawnSync, spawn } = require('node:child_process');
const assert = require('node:assert/strict');
const dockerImage = process.argv[2] === '--docker' ? process.argv[3] : null;
const bin = dockerImage ? null : process.argv[2];
if (!bin && !dockerImage) throw new Error('Provide a local PostgreSQL bin directory or --docker <image>');
const container = `itn43-sql-${process.pid}-${Date.now()}`;
const root = fs.mkdtempSync(path.resolve(__dirname, '../../../.itn43-sql-'));
const data = path.join(root, 'data');
const env = { SystemRoot: process.env.SystemRoot, PATH: process.env.PATH, TEMP: root, TMP: root,
  LC_ALL: 'C', PGCONNECT_TIMEOUT: '5' };
const executable = name => name === 'docker' ? 'docker'
  : path.join(bin, name + (process.platform === 'win32' ? '.exe' : ''));
if (dockerImage) env.HOME = process.env.HOME;
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
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
// Docker: sin red (ni puertos publicados); psql corre dentro del contenedor vía docker exec.
async function startDocker() {
  run('docker', ['run', '-d', '--rm', '--network', 'none', '--name', container,
    '-e', 'POSTGRES_USER=classroom_test', '-e', 'POSTGRES_HOST_AUTH_METHOD=trust', dockerImage]);
  for (let i = 0; i < 120; i++) {
    const logs = spawnSync('docker', ['logs', container], { encoding: 'utf8' });
    const text = `${logs.stdout}${logs.stderr}`;
    if (/PostgreSQL init process complete/.test(text) && /ready to accept connections[\s\S]*ready to accept connections/.test(text)
      && spawnSync('docker', ['exec', container, 'pg_isready', '-U', 'classroom_test'], { encoding: 'utf8' }).status === 0) return;
    await sleep(500);
  }
  throw Error('postgres container did not become ready');
}
async function main() {
  let started = false;
  try {
    let psql, args;
    if (dockerImage) {
      started = true;
      await startDocker();
      const network = run('docker', ['inspect', '-f', '{{.HostConfig.NetworkMode}}', container]).trim();
      assert.equal(network, 'none');
      psql = 'docker';
      args = ['exec', '-i', container, 'psql', '-X', '-U', 'classroom_test', '-d', 'postgres', '-v', 'ON_ERROR_STOP=1'];
    } else {
      run('initdb', ['-D', data, '-U', 'classroom_test', '--auth=trust', '--no-locale', '--encoding=UTF8']);
      const port = await new Promise(resolve => {
        const server = net.createServer();
        server.listen(0, '127.0.0.1', () => { const p = server.address().port; server.close(() => resolve(p)); });
      });
      run('pg_ctl', ['-D', data, '-l', path.join(root, 'server.log'), '-o', `-h 127.0.0.1 -p ${port} -F`, '-w', 'start']);
      started = true;
      psql = 'psql';
      args = ['-X', '-h', '127.0.0.1', '-p', String(port), '-U', 'classroom_test', '-d', 'postgres', '-v', 'ON_ERROR_STOP=1'];
    }
    const sql = text => run(psql, args, text);
    sql(`create role anon; create role authenticated; create role service_role bypassrls;
      create table public.app_users(id uuid primary key);
      grant select, update on app_users to service_role;`);
    const migrations = path.resolve(__dirname, '../../database/migrations');
    for (const file of ['006_classroom_courses_coursework.sql', '008_google_classroom_authorization.sql',
      '014_google_authorization_status.sql']) {
      sql(fs.readFileSync(path.join(migrations, file), 'utf8'));
    }
    const m016 = fs.readFileSync(path.join(migrations, '016_classroom_sync.sql'), 'utf8');
    const m017 = fs.readFileSync(path.join(migrations, '017_classroom_baseline.sql'), 'utf8');
    const m018 = fs.readFileSync(path.join(migrations, '018_disable_classroom_tasks.sql'), 'utf8');
    for (const text of [m016, m017, m018]) assert.doesNotMatch(text, /^\s*(begin|commit)\s*;/im);
    for (const text of [m017, m018]) assert.match(text, /set local lock_timeout = '5s'/);
    // 016 + 017 + 018 en UNA sola transacción.
    const migration = `${m016}\n${m017}\n${m018}`;
    const absent = () => assert.match(sql(`select case when to_regclass('public.classroom_task_events') is null
      and to_regprocedure('public.sync_classroom(uuid,text,jsonb)') is null
      and to_regprocedure('public.disable_classroom_tasks(uuid,text)') is null
      and not exists (select 1 from information_schema.columns where table_schema = 'public'
        and table_name = 'classroom_courses' and column_name = 'coursework_baseline_at')
      then 'MIGRATION_ROLLBACK_OK' else 'FAILED' end;`), /MIGRATION_ROLLBACK_OK/);
    sql(`begin;\n${migration}\nrollback;`);
    absent();
    assert.throws(() => sql(`begin;\n${migration}\nselect 1/0;\ncommit;`), /(psql|docker) failed: .*division by zero/s);
    absent();
    for (let attempt = 0; attempt < 2; attempt++) sql(`begin;\n${migration}\ncommit;`);
    // 017 and 018 alone are also replayable on top of the applied set.
    sql(`begin;\n${m017}\ncommit;`);
    for (let attempt = 0; attempt < 2; attempt++) sql(`begin;\n${m018}\ncommit;`);
    assert.match(sql(`select count(*) from pg_proc where proname = 'disable_classroom_tasks';`), /^\s*1\s*$/m);
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
      const child = spawn(executable(psql), args, { env, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
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
    // ITN-43c (018): disable_classroom_tasks comparte el candado de sync_classroom (app_users FOR UPDATE).
    sql(fs.readFileSync(path.resolve(__dirname, '../tests/sql/classroomTasksDisable.sql'), 'utf8')
      .replace(/^select 'DISABLE_CHECKS_1_TO_5_OK';$/m, ''));
    const u1 = "'00000000-0000-4000-8000-000000000001'";
    const stamp = "select 'AT=' || to_char(clock_timestamp(), 'HH24:MI:SS.US');";
    const at = out => /AT=(\S+)/.exec(out)[1];
    const u1State = () => JSON.parse(/(\{.*\})/.exec(sql(`select test_user_state(${u1})::text;`))[1]);
    // (a) disable tiene el candado; una sync que llega en medio espera y luego hace baseline silencioso.
    sql(`select test_seed_tasks(${u1}, 'g1');`);
    const holder = concurrent(`set role service_role; begin; select disable_classroom_tasks(${u1}, 'g1'); select pg_sleep(1.5); ${stamp} commit;`);
    await sleep(500);
    const [disableOut, syncOut] = await Promise.all([holder,
      concurrent(`set role service_role; select test_snapshot(${u1}, 'g1', array['d-w1', 'during-disable'], 'd1'); ${stamp}`)]);
    assert.ok(at(syncOut) > at(disableOut), 'sync did not wait for disable_classroom_tasks');
    assert.match(syncOut, /"newTasks": 0/);
    let state = u1State();
    assert.equal(state.events, 0, 'sync after disable created events');
    // (b) sync tiene el candado; disable espera y borra TODO lo que la sync escribió (nada a medias).
    sql(`select test_seed_tasks(${u1}, 'g1');`);
    const syncHolder = concurrent(`set role service_role; begin; select test_snapshot(${u1}, 'g1', array['d-w1', 'mid-sync-' || gen_random_uuid()], 'd1'); select pg_sleep(1.5); ${stamp} commit;`);
    await sleep(500);
    const [syncHeldOut, disableAfterOut] = await Promise.all([syncHolder,
      concurrent(`set role service_role; select disable_classroom_tasks(${u1}, 'g1'); ${stamp}`)]);
    assert.ok(at(disableAfterOut) > at(syncHeldOut), 'disable did not wait for sync_classroom');
    assert.match(syncHeldOut, /"newTasks": 1/);
    state = u1State();
    assert.deepEqual([state.events, state.coursework, state.baselines], [0, 0, 0], 'rows left behind by concurrent sync');
    console.log('DISABLE_CHECKS_1_TO_5_OK: 016+017+018 one transaction + replay, scope/tasks/events/baseline, isolation, shared lock, service_role + invoker');
    // (6) Autorización inactiva o google_id distinto: no se borra nada.
    const check6 = sql(fs.readFileSync(path.resolve(__dirname, '../tests/sql/classroomTasksDisableAuth.sql'), 'utf8'));
    console.log(check6.trim().split('\n').filter(line => /CHECK6|OK/.test(line)).join('\n'));
    console.log('CLASSROOM_SQL_OK: courses-only, per-course task baseline (017), baseline, dedup, timestamps, isolation, relink, rollback, concurrent writers, RLS, migration replay, external transaction rollback');
  } catch (error) {
    console.error(error.message);
    throw error;
  } finally {
    if (dockerImage) {
      if (started) spawnSync('docker', ['rm', '-f', container], { encoding: 'utf8' });
    } else if (started || fs.existsSync(path.join(data, 'postmaster.pid'))) run('pg_ctl', ['-D', data, '-m', 'fast', '-w', 'stop']);
    fs.rmSync(root, { recursive: true, force: true });
  }
}
main().catch(error => { console.error(error.message); process.exitCode = 1; });
