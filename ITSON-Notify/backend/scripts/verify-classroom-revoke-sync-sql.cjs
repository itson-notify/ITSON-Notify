// Disposable localhost cluster only. No URL, inherited PG settings, or production data.
// node scripts/verify-classroom-revoke-sync-sql.cjs "C:/Program Files/PostgreSQL/18/bin"
const fs = require('node:fs');
const path = require('node:path');
const net = require('node:net');
const { spawnSync, spawn } = require('node:child_process');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const bin = process.argv[2];
if (!bin) throw Error('BLOCKED: provide an existing PostgreSQL bin directory');
for (const name of ['psql', 'initdb', 'pg_ctl']) {
  if (!fs.existsSync(path.join(bin, name + (process.platform === 'win32' ? '.exe' : '')))) {
    throw Error(`BLOCKED: missing local ${name}`);
  }
}
const root = fs.mkdtempSync(path.resolve(__dirname, '../../../.itn43-revoke-sql-'));
const data = path.join(root, 'data');
const env = { SystemRoot: process.env.SystemRoot, PATH: process.env.PATH, TEMP: root, TMP: root,
  LC_ALL: 'C', PGCONNECT_TIMEOUT: '5' };
const executable = name => path.join(bin, name + (process.platform === 'win32' ? '.exe' : ''));
function run(name, args, input) {
  const output = path.join(root, 'command-output.txt');
  const fd = fs.openSync(output, 'w');
  let result;
  try {
    result = spawnSync(executable(name), args, { env, input, encoding: 'utf8', windowsHide: true,
      timeout: 30000, stdio: [input === undefined ? 'ignore' : 'pipe', fd, fd] });
  } finally { fs.closeSync(fd); }
  const out = fs.readFileSync(output, 'utf8');
  if (result.error || result.status !== 0) throw Error(`${name} failed: ${result.error ?? out}`);
  return out;
}
async function main() {
  let started = false;
  const children = new Set();
  try {
    run('initdb', ['-D', data, '-U', 'classroom_test', '--auth=trust', '--no-locale', '--encoding=UTF8']);
    const port = await new Promise(resolve => {
      const server = net.createServer();
      server.listen(0, '127.0.0.1', () => { const p = server.address().port; server.close(() => resolve(p)); });
    });
    run('pg_ctl', ['-D', data, '-l', path.join(root, 'server.log'), '-o', `-h 127.0.0.1 -p ${port} -F`, '-w', 'start']);
    started = true;
    const args = ['-X', '-q', '-A', '-t', '-h', '127.0.0.1', '-p', String(port), '-U', 'classroom_test',
      '-d', 'postgres', '-v', 'ON_ERROR_STOP=1', '-v', 'VERBOSITY=verbose'];
    const sql = text => run('psql', args, text);
    const migrations = path.resolve(__dirname, '../../database/migrations');
    const tests = path.resolve(__dirname, '../tests/sql');
    const read = file => fs.readFileSync(file, 'utf8');
    const course = 'https://www.googleapis.com/auth/classroom.courses.readonly';
    const work = 'https://www.googleapis.com/auth/classroom.coursework.me.readonly';
    const alias = 'https://www.googleapis.com/auth/classroom.student-submissions.me.readonly';
    const u = '00000000-0000-4000-8000-000000000001';
    const v = '00000000-0000-4000-8000-000000000002';
    const sync = `select test_snapshot('${u}','g1',array['w1','race']);`;
    const disable = `select disable_classroom_tasks('${u}','g1');`;
    const activate = `select activate_classroom_tasks('${u}','g1','${work}');`;
    const check = (expression, label) => sql(`select test_assert(${expression}, '${label}');`);
    const empty = () => check(`not exists(select 1 from classroom_coursework where user_id='${u}')
      and not exists(select 1 from classroom_task_events where user_id='${u}')
      and not exists(select 1 from classroom_courses where user_id='${u}' and coursework_baseline_at is not null)`,
    'no resurrection after confirmed revocation');
    sql(`create role anon; create role authenticated; create role service_role bypassrls;
      create table public.app_users(id uuid primary key); grant select, update on app_users to service_role;`);
    for (const f of ['006_classroom_courses_coursework.sql', '008_google_classroom_authorization.sql',
      '014_google_authorization_status.sql']) sql(read(path.join(migrations, f)));
    for (const f of ['016_classroom_sync.sql', '017_classroom_baseline.sql']) {
      sql(`begin; ${read(path.join(migrations, f))} commit;`);
    }
    for (const [f, sha] of [['18.sql', '8855972195329b6d69edcc0c9255d3347cd9de63'],
      ['19.sql', '0ab13751f4545a0023db41b78b65652b94d2734b']]) {
      const content = read(path.join(tests, 'fixtures/revokeSync', f)).replaceAll('\r\n', '\n');
      assert.equal(crypto.createHash('sha1').update(`blob ${Buffer.byteLength(content)}\0`).update(content).digest('hex'),
        sha, 'fixture must match reviewed PR blob');
      sql(`begin; ${content} commit;`);
    }
    // Negative control: prove 017 really resurrects a stale snapshot after 018 COMMIT.
    const probe = '00000000-0000-4000-8000-000000000009';
    sql(`insert into app_users values('${probe}');
      insert into google_authorizations(user_id,google_id,email,scope,refresh_token)
      values('${probe}','probe','probe@example.test','${course} ${work}','not-a-token');`);
    const stale = `select sync_classroom('${probe}','probe',
      '[{"id":"probe-course","name":"Synthetic","coursework":[{"id":"probe-work","title":"Synthetic","state":"PUBLISHED"}]}]');`;
    sql(`set role service_role; ${stale}`);
    sql(`set role service_role; select disable_classroom_tasks('${probe}','probe');`);
    sql(`set role service_role; ${stale}`);
    assert.equal(sql(`select count(*) from classroom_coursework where user_id='${probe}';`).trim(), '1',
      'negative control must reproduce 017 resurrection');
    sql(`delete from app_users where id='${probe}';`);
    console.log('PASS: negative control reproduces stale-task resurrection on original 017 + 018');
    const m021 = read(path.join(migrations, '021_classroom_revoke_sync.sql'));
    assert.doesNotMatch(m021, /^\s*(begin|commit)\s*;/im);
    const definition = () => sql("select pg_get_functiondef('sync_classroom(uuid,text,jsonb)'::regprocedure);");
    const before = definition();
    sql(`begin; ${m021} rollback;`);
    assert.equal(definition(), before, 'external migration rollback');
    assert.throws(() => sql(`begin; ${m021} select 1/0; commit;`), /22012/);
    assert.equal(definition(), before, 'failed migration rollback');
    for (let i=0; i<2; i++) sql(`begin; ${m021} commit;`);
    // Existing 017 regression suite, changing ONLY its synthetic grants to valid scopes.
    sql(read(path.join(tests, 'classroomSync.sql')).replaceAll("'synthetic','not-a-token'", `'${course} ${work}','not-a-token'`));
    console.log('PASS: 017 regression suite with real scoped grants; rollback and migration replay');
    sql(read(path.join(tests, 'classroomRevokeSync.sql')));
    console.log('PASS: scope matrix, no task writes, permissions, identity/status, RLS and isolation');

    function session(name, text) {
      const child = spawn(executable('psql'), args, { env: { ...env, PGAPPNAME: name }, windowsHide: true,
        stdio: ['pipe', 'pipe', 'pipe'] });
      children.add(child);
      let out = '', err = '';
      const done = new Promise((resolve, reject) => {
        child.stdout.on('data', s => { out += s; });
        child.stderr.on('data', s => { err += s; });
        child.on('error', reject);
        child.on('close', code => { children.delete(child); code === 0 ? resolve(out) : reject(Error(err)); });
      });
      // Attach a handler immediately, even while polling the lock barrier.
      done.catch(() => {});
      child.stdin.end(`set statement_timeout='8s'; set lock_timeout='6s'; set role service_role; ${text}`);
      return done;
    }
    async function until(query, label) {
      const end = Date.now() + 4000;
      while (Date.now() < end) {
        if (sql(query).trim() === 't') return;
        await new Promise(resolve => setTimeout(resolve, 25));
      }
      throw Error(`FAIL: barrier not observed: ${label}`);
    }
    let sequence = 0;
    async function overlap(first, second, label) {
      const a = `revoke_a_${++sequence}`, b = `revoke_b_${sequence}`;
      // The first RPC finishes but its transaction retains all locks until COMMIT.
      // No timing assumption counts as coverage: observe PgSleep, then blocking PID.
      const one = session(a, `begin; ${first} select pg_sleep(2); commit;`);
      await until(`select exists(select 1 from pg_stat_activity where application_name='${a}' and wait_event='PgSleep');`, label);
      const two = session(b, second);
      await until(`select exists(select 1 from pg_stat_activity b join pg_stat_activity a
        on a.pid=any(pg_blocking_pids(b.pid)) where a.application_name='${a}' and b.application_name='${b}');`, label);
      const outputs = await Promise.all([one, two]);
      console.log(`PASS: ${label}; observed blocking and both commits, no 40P01`);
      return outputs;
    }
    const prepare = () => sql(`set role service_role; ${disable} ${activate}
      select test_snapshot('${u}','g1',array['w1']);`);
    // Preserve the other student's complete rows across every activation/revocation.
    sql(`create table other_before as select to_jsonb(w) row from classroom_coursework w where user_id='${v}';`);
    prepare();
    await overlap(sync, disable, 'sync -> disable'); empty();
    sql(`set role service_role; ${sync} ${sync}`); empty();
    prepare();
    const results = await overlap(disable, sync, 'disable -> sync with stale task payload');
    assert.match(results[1], /"coursework": 0/); empty();
    sql(`set role service_role; ${sync}`); empty();
    const activationFirst = await overlap(activate, sync, 'activate -> sync');
    assert.match(activationFirst[1], /"newTasks": 0/);
    check(`(select count(*)=2 from classroom_coursework where user_id='${u}')
      and not exists(select 1 from classroom_task_events where user_id='${u}')`, 'activation silent baseline');
    sql(`set role service_role; ${disable}`);
    const syncFirst = await overlap(sync, activate, 'sync -> activate');
    assert.match(syncFirst[0], /"coursework": 0/); empty();
    sql(`set role service_role; ${sync}`);
    check(`not exists(select 1 from classroom_task_events where user_id='${u}')`, 'next sync silent baseline');

    // Real ledger materialization, cancellation, and same-user serialization with sync.
    prepare(); sql(`set role service_role; ${sync}`);
    const event = sql(`select id from classroom_task_events where user_id='${u}';`).trim();
    const materialize = `select materialize_classroom_deliveries('${event}',array['email']);`;
    await overlap(sync, materialize, 'sync -> ledger materialize');
    await overlap(materialize, sync, 'ledger materialize -> sync');
    check(`exists(select 1 from classroom_notification_deliveries where event_id='${event}' and state='pending')`, 'real ledger pending');
    sql(`set role service_role; ${disable} ${sync}`); empty();
    check(`exists(select 1 from classroom_notification_deliveries where event_id='${event}'
      and state='cancelled' and cancel_requested and last_error_code='event_deleted')`, '019 audit preserved and cancelled');
    check(`not exists((select to_jsonb(w) from classroom_coursework w where user_id='${v}')
      except select row from other_before) and not exists(select row from other_before except
      (select to_jsonb(w) from classroom_coursework w where user_id='${v}'))`, 'other student unchanged');
    // Infrastructure privilege errors retain 42501 without the business marker.
    for (const [table, privilege] of [['app_users','update'], ['google_authorizations','select']]) {
      sql(`revoke ${privilege} on ${table} from service_role;`);
      assert.throws(() => sql(`set role service_role; ${sync}`), error => /42501/.test(error.message)
        && !/classroom_authorization_required/.test(error.message));
      sql(`grant ${privilege} on ${table} to service_role;`);
    }
    console.log('PASS: 018/019 compatibility, ledger cancellation, isolation and infrastructure ACL errors');
    console.log('CLASSROOM_REVOKE_SYNC_SQL_OK (PostgreSQL real, disposable localhost cluster)');
  } finally {
    for (const child of children) child.kill();
    if (started || fs.existsSync(path.join(data, 'postmaster.pid'))) run('pg_ctl', ['-D', data, '-m', 'fast', '-w', 'stop']);
    // Only the exact mkdtemp directory created above may be removed.
    const workspace = path.resolve(__dirname, '../../..');
    assert.equal(path.dirname(root), workspace);
    assert.ok(path.basename(root).startsWith('.itn43-revoke-sql-'));
    fs.rmSync(root, { recursive: true, force: true });
  }
}
main().catch(error => { console.error(`FAIL: ${error.stack}`); process.exitCode = 1; });
