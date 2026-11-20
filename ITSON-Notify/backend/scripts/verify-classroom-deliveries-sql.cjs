// Standalone offline PostgreSQL cluster integration verifier for 019_classroom_notification_deliveries.sql.
// Supports either a local PostgreSQL bin directory or a disposable postgres:16 Docker container:
//   node scripts/verify-classroom-deliveries-sql.cjs "C:/Program Files/PostgreSQL/16/bin"
//   node scripts/verify-classroom-deliveries-sql.cjs docker
const fs = require("node:fs");
const path = require("node:path");
const net = require("node:net");
const { spawnSync, spawn } = require("node:child_process");
const assert = require("node:assert/strict");

const arg = process.argv[2];
if (!arg) throw new Error("Provide a local PostgreSQL bin directory or 'docker'");

const useDocker = arg === "docker";
const root = fs.mkdtempSync(path.resolve(__dirname, "../../../.itn50-sql-"));
const data = path.join(root, "data");
const env = {
  SystemRoot: process.env.SystemRoot,
  PATH: process.env.PATH,
  TEMP: root,
  TMP: root,
  LC_ALL: "C",
  PGCONNECT_TIMEOUT: "5",
};
const executable = (name) => path.join(arg, name + (process.platform === "win32" ? ".exe" : ""));

function runFile(cmd, args, input) {
  const output = path.join(root, `command-output-${Date.now()}-${Math.random().toString(16).slice(2)}.txt`);
  const fd = fs.openSync(output, "w");
  let result;
  try {
    result = spawnSync(cmd, args, {
      env,
      input,
      encoding: "utf8",
      windowsHide: true,
      timeout: 30000,
      stdio: [input === undefined ? "ignore" : "pipe", fd, fd],
    });
  } finally {
    fs.closeSync(fd);
  }
  const text = fs.readFileSync(output, "utf8");
  try {
    fs.unlinkSync(output);
  } catch {}
  if (result.error || result.status !== 0) throw Error(`${cmd} failed: ${result.error ?? text}`);
  return text;
}

// Inline definition of disable_classroom_tasks from 018_classroom_tasks_authorization.sql
// so 019 can be verified against 018's exact lock order even before PR #41 merges to main.
const DISABLE_TASKS_018_SQL = `
create or replace function public.disable_classroom_tasks(p_user_id uuid, p_google_id text)
returns jsonb
language plpgsql security invoker set search_path = pg_catalog, public as $$
declare
  work_scopes constant text[] := array[
    'https://www.googleapis.com/auth/classroom.coursework.me.readonly',
    'https://www.googleapis.com/auth/classroom.student-submissions.me.readonly'
  ];
  removed_events integer;
  removed_work integer;
  reset_courses integer;
begin
  perform 1 from public.app_users where id = p_user_id for update;
  if not found then raise exception 'classroom_authorization_required' using errcode = '42501'; end if;
  perform 1 from public.google_authorizations
    where user_id = p_user_id and google_id = p_google_id
    for update;
  if not found then raise exception 'classroom_authorization_required' using errcode = '42501'; end if;

  update public.google_authorizations
    set scope = array_to_string(array(
          select s from unnest(string_to_array(scope, ' ')) with ordinality as t(s, n)
          where s <> '' and not (s = any(work_scopes)) order by n), ' '),
        updated_at = now()
    where user_id = p_user_id and google_id = p_google_id
      and string_to_array(scope, ' ') && work_scopes;

  delete from public.classroom_task_events where user_id = p_user_id;
  get diagnostics removed_events = row_count;
  delete from public.classroom_coursework where user_id = p_user_id;
  get diagnostics removed_work = row_count;
  update public.classroom_courses set coursework_baseline_at = null
    where user_id = p_user_id and coursework_baseline_at is not null;
  get diagnostics reset_courses = row_count;

  return jsonb_build_object('events', removed_events, 'coursework', removed_work, 'courses', reset_courses);
end;
$$;
revoke all on function public.disable_classroom_tasks(uuid, text) from public, anon, authenticated;
grant execute on function public.disable_classroom_tasks(uuid, text) to service_role;
`;

async function main() {
  let startedLocal = false;
  const containerName = `itn50-pg16-${Date.now()}`;
  let startedDocker = false;

  try {
    let psqlCmd;
    let psqlBaseArgs;

    if (useDocker) {
      runFile("docker", [
        "run",
        "-d",
        "--rm",
        "--name",
        containerName,
        "-e",
        "POSTGRES_USER=classroom_test",
        "-e",
        "POSTGRES_HOST_AUTH_METHOD=trust",
        "postgres:16",
      ]);
      startedDocker = true;
      psqlCmd = "docker";
      psqlBaseArgs = ["exec", "-i", containerName, "psql", "-X", "-U", "classroom_test", "-d", "postgres", "-v", "ON_ERROR_STOP=1"];

      // Wait for Postgres inside container to accept connections
      let ready = false;
      for (let i = 0; i < 30; i += 1) {
        try {
          runFile(psqlCmd, psqlBaseArgs, "select 1;");
          ready = true;
          break;
        } catch {
          await new Promise((r) => setTimeout(r, 500));
        }
      }
      if (!ready) throw new Error("postgres:16 container did not become ready");
    } else {
      runFile(executable("initdb"), ["-D", data, "-U", "classroom_test", "--auth=trust", "--no-locale", "--encoding=UTF8"]);
      const port = await new Promise((resolve) => {
        const server = net.createServer();
        server.listen(0, "127.0.0.1", () => {
          const p = server.address().port;
          server.close(() => resolve(p));
        });
      });
      runFile(executable("pg_ctl"), ["-D", data, "-l", path.join(root, "server.log"), "-o", `-h 127.0.0.1 -p ${port} -F`, "-w", "start"]);
      startedLocal = true;
      psqlCmd = executable("psql");
      psqlBaseArgs = ["-X", "-h", "127.0.0.1", "-p", String(port), "-U", "classroom_test", "-d", "postgres", "-v", "ON_ERROR_STOP=1"];
    }

    const sql = (text) => runFile(psqlCmd, psqlBaseArgs, text);
    const concurrent = (text) =>
      new Promise((resolve, reject) => {
        const child = spawn(psqlCmd, psqlBaseArgs, { env, windowsHide: true, stdio: ["pipe", "pipe", "pipe"] });
        let out = "";
        let err = "";
        child.stdout.on("data", (s) => {
          out += s;
        });
        child.stderr.on("data", (s) => {
          err += s;
        });
        child.on("error", reject);
        child.on("close", (code) => (code === 0 ? resolve(out) : reject(Error(err || `exit ${code}`))));
        child.stdin.end(text);
      });

    sql(`
      create role anon;
      create role authenticated;
      create role service_role bypassrls;
      create table public.app_users(id uuid primary key);
      grant select, update on public.app_users to service_role;
    `);

    const migrations = path.resolve(__dirname, "../../database/migrations");
    for (const file of [
      "006_classroom_courses_coursework.sql",
      "008_google_classroom_authorization.sql",
      "014_google_authorization_status.sql",
      "016_classroom_sync.sql",
      "017_classroom_baseline.sql",
    ]) {
      sql(`begin;\n${fs.readFileSync(path.join(migrations, file), "utf8")}\ncommit;`);
    }

    const m018Path = path.join(migrations, "018_classroom_tasks_authorization.sql");
    if (fs.existsSync(m018Path)) {
      sql(`begin;\n${fs.readFileSync(m018Path, "utf8")}\ncommit;`);
    } else {
      sql(`begin;\n${DISABLE_TASKS_018_SQL}\ncommit;`);
    }

    const m019 = fs.readFileSync(path.join(migrations, "019_classroom_notification_deliveries.sql"), "utf8");
    assert.doesNotMatch(m019, /^\s*(begin|commit)\s*;/im);
    assert.match(m019, /set local lock_timeout = '5s'/);

    const absent = () =>
      assert.match(
        sql(`
          select case
            when to_regclass('public.classroom_notification_deliveries') is null
             and to_regprocedure('public.materialize_classroom_deliveries(uuid,text[],text)') is null
             and to_regprocedure('public.claim_classroom_delivery(integer,integer)') is null
             and to_regprocedure('public.begin_classroom_delivery_send(uuid,uuid,integer,integer,text,text)') is null
             and to_regprocedure('public.ack_classroom_delivery(uuid,uuid,text,text,text,integer,integer)') is null
            then 'MIGRATION_019_ROLLBACK_OK'
            else 'FAILED'
          end;
        `),
        /MIGRATION_019_ROLLBACK_OK/,
      );

    sql(`begin;\n${m019}\nrollback;`);
    absent();
    assert.throws(() => sql(`begin;\n${m019}\nselect 1/0;\ncommit;`), /failed/);
    absent();

    // Replayable twice without error
    for (let attempt = 0; attempt < 2; attempt += 1) {
      sql(`begin;\n${m019}\ncommit;`);
    }

    sql(fs.readFileSync(path.resolve(__dirname, "../tests/sql/classroomDeliveries.sql"), "utf8"));

    // Helper to reset student 1 with a fresh baseline and one new task event (returns event_id).
    const seedOneNewEvent = (taskExtId) => {
      const out = sql(`
        set role service_role;
        delete from public.classroom_notification_deliveries where user_id = '00000000-0000-4000-8000-000000000011';
        delete from public.classroom_task_events where user_id = '00000000-0000-4000-8000-000000000011';
        delete from public.classroom_coursework where user_id = '00000000-0000-4000-8000-000000000011';
        delete from public.classroom_courses where user_id = '00000000-0000-4000-8000-000000000011';
        update public.google_authorizations
          set scope = 'https://www.googleapis.com/auth/classroom.courses.readonly https://www.googleapis.com/auth/classroom.coursework.me.readonly',
              status = 'active'
          where user_id = '00000000-0000-4000-8000-000000000011';
        select public.sync_classroom(
          '00000000-0000-4000-8000-000000000011',
          'g-ledger-1',
          '[{"id":"c-conc","name":"Curso Concurrente","coursework":[{"id":"w-base","title":"Base","state":"PUBLISHED"}]}]'::jsonb
        );
        select public.sync_classroom(
          '00000000-0000-4000-8000-000000000011',
          'g-ledger-1',
          jsonb_build_array(jsonb_build_object(
            'id', 'c-conc',
            'name', 'Curso Concurrente',
            'coursework', jsonb_build_array(
              jsonb_build_object('id', 'w-base', 'title', 'Base', 'state', 'PUBLISHED'),
              jsonb_build_object('id', '${taskExtId}', 'title', 'Nueva', 'state', 'PUBLISHED')
            )
          ))
        );
        select 'EVENT_ID=' || e.id::text
          from public.classroom_task_events e
          join public.classroom_coursework w on w.id = e.coursework_id
          where w.external_coursework_id = '${taskExtId}';
        reset role;
      `);
      const m = /EVENT_ID=([0-9a-f-]{36})/i.exec(out);
      assert.ok(m, `Failed to seed event for ${taskExtId}: ${out}`);
      return m[1];
    };

    // (A) Real two-process concurrent claim test (FOR UPDATE SKIP LOCKED)
    const evClaim = seedOneNewEvent("w-conc-claim");
    sql(`set role service_role; select public.materialize_classroom_deliveries('${evClaim}'::uuid, array['email'], 'v1'); reset role;`);
    const claimCall = "set role service_role; select coalesce(public.claim_classroom_delivery(60, 5)->>'state', 'EMPTY');";
    const claimResults = await Promise.all([
      concurrent(`begin; ${claimCall} select pg_sleep(0.2); commit;`),
      concurrent(claimCall),
    ]);
    assert.equal(claimResults.filter((out) => /claimed/.test(out)).length, 1);
    assert.equal(claimResults.filter((out) => /EMPTY/.test(out)).length, 1);

    // (B) Two-session concurrency: disable_classroom_tasks vs materialize_classroom_deliveries (both orders, no 40P01 deadlock)
    for (const disableFirst of [true, false]) {
      const evMat = seedOneNewEvent(disableFirst ? "w-mat-1" : "w-mat-2");
      const disableSql = `set role service_role; select public.disable_classroom_tasks('00000000-0000-4000-8000-000000000011'::uuid, 'g-ledger-1');`;
      const matSql = `set role service_role; select public.materialize_classroom_deliveries('${evMat}'::uuid, array['email'], 'v1');`;
      const [first, second] = disableFirst
        ? [`begin; ${disableSql} select pg_sleep(0.2); commit;`, `select pg_sleep(0.05); begin; ${matSql} commit;`]
        : [`begin; ${matSql} select pg_sleep(0.2); commit;`, `select pg_sleep(0.05); begin; ${disableSql} commit;`];

      const res = await Promise.all([concurrent(first), concurrent(second)]);
      assert.doesNotMatch(res.join("\n"), /40P01|deadlock/i);

      // Final state: zero events left, and zero pending/claimed/retry_wait deliveries
      sql(`
        set role service_role;
        select public.test_assert(
          (select count(*) = 0 from public.classroom_task_events where user_id = '00000000-0000-4000-8000-000000000011'),
          'disable vs materialize leaves zero events'
        );
        select public.test_assert(
          (select count(*) = 0 from public.classroom_notification_deliveries
             where event_id = '${evMat}'::uuid and state not in ('cancelled')),
          'disable vs materialize leaves no active deliveries'
        );
        reset role;
      `);
    }

    // (C) Two-session concurrency: disable_classroom_tasks vs begin_classroom_delivery_send (both orders, no 40P01 deadlock)
    for (const disableFirst of [true, false]) {
      const evBegin = seedOneNewEvent(disableFirst ? "w-begin-1" : "w-begin-2");
      const claimOut = sql(`
        set role service_role;
        select public.materialize_classroom_deliveries('${evBegin}'::uuid, array['email'], 'v1');
        select 'CLAIM=' || (c->>'id') || ':' || (c->>'claim_token')
          from (select public.claim_classroom_delivery(60, 5) as c) x;
        reset role;
      `);
      const [, delivId, claimTok] = /CLAIM=([0-9a-f-]{36}):([0-9a-f-]{36})/i.exec(claimOut);

      const disableSql = `set role service_role; select public.disable_classroom_tasks('00000000-0000-4000-8000-000000000011'::uuid, 'g-ledger-1');`;
      const beginSql = `set role service_role; select public.begin_classroom_delivery_send('${delivId}'::uuid, '${claimTok}'::uuid, 30, 5, 'v1:' || repeat('a', 64), 'v1');`;
      const [first, second] = disableFirst
        ? [`begin; ${disableSql} select pg_sleep(0.2); commit;`, `select pg_sleep(0.05); begin; ${beginSql} commit;`]
        : [`begin; ${beginSql} select pg_sleep(0.2); commit;`, `select pg_sleep(0.05); begin; ${disableSql} commit;`];

      const res = await Promise.all([concurrent(first), concurrent(second)]);
      assert.doesNotMatch(res.join("\n"), /40P01|deadlock/i);

      if (disableFirst) {
        // When disable commits first, begin_send must return allowed: false and state in DB is cancelled
        sql(`
          set role service_role;
          select public.test_assert(
            (select state = 'cancelled' and cancel_requested = true from public.classroom_notification_deliveries where id = '${delivId}'::uuid),
            'disable before begin_send cancels delivery'
          );
          reset role;
        `);
      } else {
        // When begin_send commits first, delivery is 'sending' and disable's trigger marks cancel_requested = true
        sql(`
          set role service_role;
          select public.test_assert(
            (select state = 'sending' and cancel_requested = true from public.classroom_notification_deliveries where id = '${delivId}'::uuid),
            'disable after begin_send flags cancel_requested on sending delivery'
          );
          reset role;
        `);
      }
    }

    // (D) Two-session concurrency: disable_classroom_tasks vs ack_classroom_delivery (both orders, no 40P01 deadlock)
    for (const disableFirst of [true, false]) {
      const evAck = seedOneNewEvent(disableFirst ? "w-ack-1" : "w-ack-2");
      const prepOut = sql(`
        set role service_role;
        select public.materialize_classroom_deliveries('${evAck}'::uuid, array['email'], 'v1');
        select 'CLAIM=' || (c->>'id') || ':' || (c->>'claim_token')
          from (select public.claim_classroom_delivery(60, 5) as c) x;
        reset role;
      `);
      const [, delivId, claimTok] = /CLAIM=([0-9a-f-]{36}):([0-9a-f-]{36})/i.exec(prepOut);
      sql(`
        set role service_role;
        select public.begin_classroom_delivery_send('${delivId}'::uuid, '${claimTok}'::uuid, 30, 5, 'v1:' || repeat('a', 64), 'v1');
        reset role;
      `);

      const disableSql = `set role service_role; select public.disable_classroom_tasks('00000000-0000-4000-8000-000000000011'::uuid, 'g-ledger-1');`;
      const ackSql = `set role service_role; select public.ack_classroom_delivery('${delivId}'::uuid, '${claimTok}'::uuid, 'sent', 'resend-ref', null, 60, 5);`;
      const [first, second] = disableFirst
        ? [`begin; ${disableSql} select pg_sleep(0.2); commit;`, `select pg_sleep(0.05); begin; ${ackSql} commit;`]
        : [`begin; ${ackSql} select pg_sleep(0.2); commit;`, `select pg_sleep(0.05); begin; ${disableSql} commit;`];

      const res = await Promise.all([concurrent(first), concurrent(second)]);
      assert.doesNotMatch(res.join("\n"), /40P01|deadlock/i);

      // In both orders, the already-completed external send is recorded as 'sent' and preserved in the ledger,
      // while the event row is deleted by disable_classroom_tasks.
      sql(`
        set role service_role;
        select public.test_assert(
          (select count(*) = 0 from public.classroom_task_events where id = '${evAck}'::uuid),
          'disable vs ack removes task event'
        );
        select public.test_assert(
          (select state = 'sent' from public.classroom_notification_deliveries where id = '${delivId}'::uuid),
          'disable vs ack preserves sent delivery fact in ledger'
        );
        reset role;
      `);
    }

    console.log(
      "CLASSROOM_DELIVERIES_SQL_OK: 019 rollback/replay, RLS/ACL, unified lock order (app_users->google_authorizations->event->delivery), concurrent disable vs materialize/begin_send/ack without 40P01 deadlock, ack sent only from sending/unknown, exhausted retry_wait->dead in claim, concurrent SKIP LOCKED claim",
    );
  } finally {
    if (startedDocker) {
      try {
        runFile("docker", ["rm", "-f", containerName]);
      } catch {}
    }
    if (startedLocal || fs.existsSync(path.join(data, "postmaster.pid"))) {
      try {
        runFile(executable("pg_ctl"), ["-D", data, "-m", "fast", "-w", "stop"]);
      } catch {}
    }
    fs.rmSync(root, { recursive: true, force: true });
  }
}

main().catch((error) => {
  console.error(error.message);
  process.exitCode = 1;
});
