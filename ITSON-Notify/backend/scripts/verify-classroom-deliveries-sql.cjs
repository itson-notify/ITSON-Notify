// Standalone offline PostgreSQL cluster integration verifier for 019_classroom_notification_deliveries.sql.
// Supports either a local PostgreSQL bin directory or a disposable Docker container (postgres:16 / postgres:18):
//   node scripts/verify-classroom-deliveries-sql.cjs "C:/Program Files/PostgreSQL/18/bin"
//   node scripts/verify-classroom-deliveries-sql.cjs docker
//   node scripts/verify-classroom-deliveries-sql.cjs docker postgres:18
//
// Concurrency tests use observable PostgreSQL barriers (pg_stat_activity + pg_blocking_pids)
// with zero pg_sleep timing assumptions, and log full final DB/session state on failure.
const fs = require("node:fs");
const path = require("node:path");
const net = require("node:net");
const { spawnSync, spawn } = require("node:child_process");
const assert = require("node:assert/strict");

const arg = process.argv[2];
if (!arg) throw new Error("Provide a local PostgreSQL bin directory or 'docker' [image]");

const useDocker = arg === "docker";
const dockerImage = process.argv[3] || "postgres:16";
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

const STUDENT_ID = "00000000-0000-4000-8000-000000000011";
const STUDENT_GOOGLE_ID = "g-ledger-1";

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
  const containerName = `itn50-pg-${Date.now()}`;
  let startedDocker = false;
  const activeChildren = new Set();

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
        dockerImage,
      ]);
      startedDocker = true;
      psqlCmd = "docker";
      psqlBaseArgs = [
        "exec",
        "-i",
        containerName,
        "psql",
        "-X",
        "-U",
        "classroom_test",
        "-d",
        "postgres",
        "-v",
        "ON_ERROR_STOP=1",
      ];

      let ready = false;
      for (let i = 0; i < 40; i += 1) {
        try {
          runFile(psqlCmd, psqlBaseArgs, "select 1;");
          ready = true;
          break;
        } catch {
          await new Promise((r) => setTimeout(r, 500));
        }
      }
      if (!ready) throw new Error(`${dockerImage} container did not become ready`);
    } else {
      runFile(executable("initdb"), [
        "-D",
        data,
        "-U",
        "classroom_test",
        "--auth=trust",
        "--no-locale",
        "--encoding=UTF8",
      ]);
      const port = await new Promise((resolve) => {
        const server = net.createServer();
        server.listen(0, "127.0.0.1", () => {
          const p = server.address().port;
          server.close(() => resolve(p));
        });
      });
      runFile(executable("pg_ctl"), [
        "-D",
        data,
        "-l",
        path.join(root, "server.log"),
        "-o",
        `-h 127.0.0.1 -p ${port} -F`,
        "-w",
        "start",
      ]);
      startedLocal = true;
      psqlCmd = executable("psql");
      psqlBaseArgs = [
        "-X",
        "-h",
        "127.0.0.1",
        "-p",
        String(port),
        "-U",
        "classroom_test",
        "-d",
        "postgres",
        "-v",
        "ON_ERROR_STOP=1",
      ];
    }

    const sql = (text) => runFile(psqlCmd, psqlBaseArgs, text);

    // Persistent interactive psql session for deterministic lock barriers (no pg_sleep).
    function openSession(appName) {
      const child = spawn(psqlCmd, psqlBaseArgs, {
        env,
        windowsHide: true,
        stdio: ["pipe", "pipe", "pipe"],
      });
      activeChildren.add(child);
      let stdout = "";
      let stderr = "";
      let closed = false;
      let exitCode = null;
      const waiters = [];

      const flushWaiters = () => {
        for (let i = waiters.length - 1; i >= 0; i -= 1) {
          const w = waiters[i];
          if (w.predicate()) {
            clearTimeout(w.timer);
            waiters.splice(i, 1);
            w.resolve();
          }
        }
      };

      const done = new Promise((resolve, reject) => {
        child.stdout.on("data", (chunk) => {
          stdout += chunk.toString("utf8");
          flushWaiters();
        });
        child.stderr.on("data", (chunk) => {
          stderr += chunk.toString("utf8");
          flushWaiters();
        });
        child.on("error", (err) => {
          closed = true;
          activeChildren.delete(child);
          for (const w of waiters.splice(0)) {
            clearTimeout(w.timer);
            w.reject(err);
          }
          reject(err);
        });
        child.on("close", (code) => {
          closed = true;
          exitCode = code;
          activeChildren.delete(child);
          for (const w of waiters.splice(0)) {
            clearTimeout(w.timer);
            if (w.predicate()) w.resolve();
            else {
              w.reject(
                new Error(
                  `Session ${appName} closed early (code=${code}) while waiting for ${w.label}.\nstdout:\n${stdout}\nstderr:\n${stderr}`,
                ),
              );
            }
          }
          resolve({ code, stdout, stderr });
        });
      });

      const send = (statement) => {
        child.stdin.write(`${statement}\n`);
      };

      const end = (statement = "") => {
        if (statement) child.stdin.write(`${statement}\n`);
        child.stdin.end();
      };

      const waitForOutput = (pattern, label, timeoutMs = 15000) => {
        const predicate = () => pattern.test(stdout);
        if (predicate()) return Promise.resolve();
        if (closed) {
          return Promise.reject(
            new Error(
              `Session ${appName} already closed (code=${exitCode}) before ${label}.\nstdout:\n${stdout}\nstderr:\n${stderr}`,
            ),
          );
        }
        return new Promise((resolve, reject) => {
          const entry = { predicate, resolve, reject, label };
          entry.timer = setTimeout(() => {
            const idx = waiters.indexOf(entry);
            if (idx >= 0) waiters.splice(idx, 1);
            reject(
              new Error(`Timeout waiting for ${label} on ${appName}.\nstdout:\n${stdout}\nstderr:\n${stderr}`),
            );
          }, timeoutMs);
          waiters.push(entry);
        });
      };

      send(`set application_name = '${appName}';`);

      return {
        appName,
        send,
        end,
        waitForOutput,
        done,
        getOutput: () => ({ stdout, stderr, exitCode, closed }),
        kill: () => {
          try {
            child.kill();
          } catch {}
        },
      };
    }

    async function waitForBarrier(query, label, timeoutMs = 15000) {
      const deadline = Date.now() + timeoutMs;
      while (Date.now() < deadline) {
        const out = sql(query);
        const m = /BARRIER_JSON=(\{.*\})/.exec(out);
        if (m) return JSON.parse(m[1]);
        await new Promise((r) => setTimeout(r, 20));
      }
      const activity = sql(`
        select pid, application_name, state, wait_event_type, wait_event, pg_blocking_pids(pid) as blocking_pids
          from pg_stat_activity
         where application_name like 'itn50_%'
         order by application_name;
      `);
      throw new Error(`Observable barrier timeout (${label}). pg_stat_activity:\n${activity}`);
    }

    function snapshotStudentState(eventId = null, deliveryId = null) {
      const eventCond = eventId ? `id = '${eventId}'::uuid` : `user_id = '${STUDENT_ID}'::uuid`;
      const deliveryCond = deliveryId
        ? `id = '${deliveryId}'::uuid`
        : eventId
          ? `event_id = '${eventId}'::uuid`
          : `user_id = '${STUDENT_ID}'::uuid`;
      const out = sql(`
        set role service_role;
        select 'STATE_JSON=' || jsonb_build_object(
          'events_left', (select count(*) from public.classroom_task_events where ${eventCond}),
          'auth_scope', (select scope from public.google_authorizations where user_id = '${STUDENT_ID}'::uuid),
          'deliveries', coalesce((
            select jsonb_agg(jsonb_build_object(
              'id', id,
              'channel', channel,
              'state', state,
              'attempts', attempts,
              'cancel_requested', cancel_requested,
              'last_error_code', last_error_code,
              'provider_reference', provider_reference
            ) order by channel, id)
            from public.classroom_notification_deliveries
            where ${deliveryCond}
          ), '[]'::jsonb)
        )::text;
        reset role;
      `);
      const m = /STATE_JSON=(\{.*\})/.exec(out);
      return m ? JSON.parse(m[1]) : { raw: out };
    }

    let barrierSeq = 0;

    // Executes firstSql in S1 (held uncommitted until S2 is positively observed blocked on S1's PID
    // via pg_stat_activity + pg_blocking_pids), then commits S1, waits for both commits, asserts
    // zero 40P01 deadlocks and validates final state — logging full diagnostic state on any failure.
    async function runSerializedOverlap({ label, firstSql, secondSql, eventId = null, deliveryId = null, assertFinal }) {
      const seq = ++barrierSeq;
      const app1 = `itn50_s1_${seq}`;
      const app2 = `itn50_s2_${seq}`;
      const s1 = openSession(app1);
      let s2 = null;
      let barrier1 = null;
      let barrier2 = null;
      let r1 = null;
      let r2 = null;

      try {
        s1.send(`begin; set local role service_role; ${firstSql} select 'S1_HELD';`);
        await s1.waitForOutput(/S1_HELD/, `${label} S1_HELD`);

        // Barrier 1: verify S1 is holding the open transaction in pg_stat_activity.
        barrier1 = await waitForBarrier(
          `
          select 'BARRIER_JSON=' || jsonb_build_object(
            's1_pid', pid,
            's1_state', state
          )::text
          from pg_stat_activity
          where application_name = '${app1}'
            and state = 'idle in transaction';
          `,
          `${label}: S1 idle in transaction`,
        );

        s2 = openSession(app2);
        s2.end(`begin; set local role service_role; ${secondSql} commit; select 'S2_DONE';`);

        // Barrier 2: positively observe S2 blocked waiting on S1's PID via pg_blocking_pids.
        barrier2 = await waitForBarrier(
          `
          select 'BARRIER_JSON=' || jsonb_build_object(
            's1_pid', a.pid,
            's2_pid', b.pid,
            's2_state', b.state,
            'wait_event_type', b.wait_event_type,
            'wait_event', b.wait_event,
            'blocking_pids', to_jsonb(pg_blocking_pids(b.pid))
          )::text
          from pg_stat_activity b
          join pg_stat_activity a on a.pid = any(pg_blocking_pids(b.pid))
          where a.application_name = '${app1}'
            and b.application_name = '${app2}';
          `,
          `${label}: S2 blocked by S1 via pg_blocking_pids`,
        );

        // Release S1 so both transactions complete cleanly without lock cycles.
        s1.end("commit;\nselect 'S1_COMMITTED';");
        [r1, r2] = await Promise.all([s1.done, s2.done]);

        const combined = `${r1.stdout}\n${r1.stderr}\n${r2.stdout}\n${r2.stderr}`;
        assert.doesNotMatch(combined, /40P01|deadlock/i, `${label}: detected 40P01 deadlock`);
        assert.equal(r1.code, 0, `${label}: S1 exited with code ${r1.code}`);
        assert.equal(r2.code, 0, `${label}: S2 exited with code ${r2.code}`);

        const finalState = snapshotStudentState(eventId, deliveryId);
        await assertFinal({ r1, r2, barrier1, barrier2, finalState });

        return { r1, r2, barrier1, barrier2, finalState };
      } catch (err) {
        s1.kill();
        if (s2) s2.kill();
        let diagState = null;
        try {
          diagState = snapshotStudentState(eventId, deliveryId);
        } catch (snapErr) {
          diagState = { snapshotError: snapErr.message };
        }
        console.error(
          `[FAILURE DIAGNOSTIC] ${label}\n` +
            `  barrier1=${JSON.stringify(barrier1)}\n` +
            `  barrier2=${JSON.stringify(barrier2)}\n` +
            `  s1=${JSON.stringify(r1 ?? s1.getOutput())}\n` +
            `  s2=${JSON.stringify(r2 ?? (s2 ? s2.getOutput() : null))}\n` +
            `  finalState=${JSON.stringify(diagState)}`,
        );
        throw err;
      }
    }

    const pgVersionOut = sql("select 'PG_VERSION=' || current_setting('server_version');");
    const pgVersion = /PG_VERSION=([^\r\n]+)/.exec(pgVersionOut)?.[1]?.trim() ?? "unknown";

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
    const hasReal018 = fs.existsSync(m018Path);
    if (hasReal018) {
      sql(`begin;\n${fs.readFileSync(m018Path, "utf8")}\ncommit;`);
    } else {
      sql(`begin;\n${DISABLE_TASKS_018_SQL}\ncommit;`);
    }

    const m021Path = path.join(migrations, "021_classroom_revoke_sync.sql");
    const hasReal021 = fs.existsSync(m021Path);
    if (hasReal021) {
      sql(`begin;\n${fs.readFileSync(m021Path, "utf8")}\ncommit;`);
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

    console.log(
      `[ENV] PostgreSQL ${pgVersion} | migrations: 018=${hasReal018 ? "real" : "inline"}, 021=${hasReal021 ? "real" : "absent"}, 019=applied+replayed (PASS)`,
    );

    sql(fs.readFileSync(path.resolve(__dirname, "../tests/sql/classroomDeliveries.sql"), "utf8"));

    // Helper to reset student 1 with a fresh baseline and one new task event (returns event_id).
    const seedOneNewEvent = (taskExtId) => {
      const out = sql(`
        set role service_role;
        delete from public.classroom_notification_deliveries where user_id = '${STUDENT_ID}';
        delete from public.classroom_task_events where user_id = '${STUDENT_ID}';
        delete from public.classroom_coursework where user_id = '${STUDENT_ID}';
        delete from public.classroom_courses where user_id = '${STUDENT_ID}';
        update public.google_authorizations
          set scope = 'https://www.googleapis.com/auth/classroom.courses.readonly https://www.googleapis.com/auth/classroom.coursework.me.readonly',
              status = 'active'
          where user_id = '${STUDENT_ID}';
        select public.sync_classroom(
          '${STUDENT_ID}',
          '${STUDENT_GOOGLE_ID}',
          '[{"id":"c-conc","name":"Curso Concurrente","coursework":[{"id":"w-base","title":"Base","state":"PUBLISHED"}]}]'::jsonb
        );
        select public.sync_classroom(
          '${STUDENT_ID}',
          '${STUDENT_GOOGLE_ID}',
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

    // (A) Real two-session concurrent claim test (FOR UPDATE SKIP LOCKED) with observable barrier
    {
      const evClaim = seedOneNewEvent("w-conc-claim");
      sql(
        `set role service_role; select public.materialize_classroom_deliveries('${evClaim}'::uuid, array['email'], 'v1'); reset role;`,
      );
      const claimApp1 = "itn50_claim_s1";
      const s1 = openSession(claimApp1);
      try {
        s1.send(
          `begin; set local role service_role; select 'CLAIM1=' || coalesce(public.claim_classroom_delivery(60, 5)->>'state', 'EMPTY'); select 'S1_HELD';`,
        );
        await s1.waitForOutput(/S1_HELD/, "CONCURRENCY A S1_HELD");
        const b1 = await waitForBarrier(
          `select 'BARRIER_JSON=' || jsonb_build_object('s1_pid', pid, 's1_state', state)::text from pg_stat_activity where application_name = '${claimApp1}' and state = 'idle in transaction';`,
          "CONCURRENCY A: S1 holds row lock",
        );

        // S2 runs while S1 holds the row lock uncommitted -> SKIP LOCKED must return EMPTY without blocking.
        const s2Out = sql(
          `set role service_role; select 'CLAIM2=' || coalesce(public.claim_classroom_delivery(60, 5)->>'state', 'EMPTY'); reset role;`,
        );
        assert.match(s2Out, /CLAIM2=EMPTY/, `Expected S2 SKIP LOCKED EMPTY, got: ${s2Out}`);

        // Confirm S1 was still uncommitted when S2 completed.
        const stillOpen = sql(
          `select count(*) from pg_stat_activity where application_name = '${claimApp1}' and state = 'idle in transaction';`,
        );
        assert.match(stillOpen, /\b1\b/, "S1 must remain open while S2 skips locked row");

        s1.end("commit;\nselect 'S1_COMMITTED';");
        const r1 = await s1.done;
        assert.equal(r1.code, 0);
        assert.match(r1.stdout, /CLAIM1=claimed/);
        console.log(
          `[CONCURRENCY A] claim_classroom_delivery vs claim_classroom_delivery (SKIP LOCKED): s1_pid=${b1.s1_pid} held lock, s2 returned EMPTY without blocking (PASS)`,
        );
      } catch (err) {
        s1.kill();
        console.error(`[FAILURE DIAGNOSTIC] CONCURRENCY A state=${JSON.stringify(snapshotStudentState(evClaim))}`);
        throw err;
      }
    }

    const disableSql = `select public.disable_classroom_tasks('${STUDENT_ID}'::uuid, '${STUDENT_GOOGLE_ID}');`;

    // (B) Two-session concurrency: disable_classroom_tasks vs materialize_classroom_deliveries (both orders)
    for (const disableFirst of [true, false]) {
      const evMat = seedOneNewEvent(disableFirst ? "w-mat-1" : "w-mat-2");
      const matSql = `select public.materialize_classroom_deliveries('${evMat}'::uuid, array['email'], 'v1') - 'deliveries';`;
      const [firstSql, secondSql] = disableFirst ? [disableSql, matSql] : [matSql, disableSql];

      const { barrier2, finalState } = await runSerializedOverlap({
        label: `[CONCURRENCY B] disable vs materialize (disableFirst=${disableFirst})`,
        firstSql,
        secondSql,
        eventId: evMat,
        assertFinal: ({ finalState: st }) => {
          assert.equal(st.events_left, 0, "disable vs materialize must leave zero events");
          if (disableFirst) {
            assert.equal(st.deliveries.length, 0, "disable before materialize leaves zero deliveries");
          } else {
            assert.equal(st.deliveries.length, 1, "materialize before disable preserves cancelled delivery audit");
            assert.equal(st.deliveries[0].state, "cancelled");
            assert.equal(st.deliveries[0].cancel_requested, true);
            assert.equal(st.deliveries[0].last_error_code, "event_deleted");
          }
        },
      });
      console.log(
        `[CONCURRENCY B] disable_classroom_tasks vs materialize_classroom_deliveries (disableFirst=${disableFirst}): observed block s1_pid=${barrier2.s1_pid} -> s2_pid=${barrier2.s2_pid} (${barrier2.wait_event_type}:${barrier2.wait_event}, blocking_pids=${JSON.stringify(barrier2.blocking_pids)}), no 40P01, final=${JSON.stringify({ events_left: finalState.events_left, deliveries: finalState.deliveries.map((d) => ({ state: d.state, cancel_requested: d.cancel_requested, last_error_code: d.last_error_code })) })} (PASS)`,
      );
    }

    // (C) Two-session concurrency: disable_classroom_tasks vs begin_classroom_delivery_send (both orders)
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

      const beginSql = `select public.begin_classroom_delivery_send('${delivId}'::uuid, '${claimTok}'::uuid, 30, 5, 'v1:' || repeat('a', 64), 'v1');`;
      const [firstSql, secondSql] = disableFirst ? [disableSql, beginSql] : [beginSql, disableSql];

      const { barrier2, finalState } = await runSerializedOverlap({
        label: `[CONCURRENCY C] disable vs begin_send (disableFirst=${disableFirst})`,
        firstSql,
        secondSql,
        eventId: evBegin,
        deliveryId: delivId,
        assertFinal: ({ r1, r2, finalState: st }) => {
          assert.equal(st.events_left, 0, "disable vs begin_send must leave zero events");
          assert.equal(st.deliveries.length, 1);
          const d = st.deliveries[0];
          if (disableFirst) {
            assert.match(r2.stdout, /"allowed":\s*false/, "begin_send after disable must return allowed: false");
            assert.equal(d.state, "cancelled", "disable before begin_send cancels delivery");
            assert.equal(d.cancel_requested, true);
            assert.equal(d.last_error_code, "event_deleted");
          } else {
            assert.match(r1.stdout, /"allowed":\s*true/, "begin_send before disable must return allowed: true");
            assert.equal(d.state, "sending", "disable after begin_send keeps sending state");
            assert.equal(d.cancel_requested, true, "disable after begin_send flags cancel_requested on sending delivery");
          }
        },
      });
      const d = finalState.deliveries[0];
      console.log(
        `[CONCURRENCY C] disable_classroom_tasks vs begin_classroom_delivery_send (disableFirst=${disableFirst}): observed block s1_pid=${barrier2.s1_pid} -> s2_pid=${barrier2.s2_pid} (${barrier2.wait_event_type}:${barrier2.wait_event}, blocking_pids=${JSON.stringify(barrier2.blocking_pids)}), no 40P01, final=${JSON.stringify({ events_left: finalState.events_left, delivery: { state: d.state, cancel_requested: d.cancel_requested, last_error_code: d.last_error_code } })} (PASS)`,
      );
    }

    // (D) Two-session concurrency: disable_classroom_tasks vs ack_classroom_delivery (both orders)
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

      const ackSql = `select public.ack_classroom_delivery('${delivId}'::uuid, '${claimTok}'::uuid, 'sent', 'resend-ref', null, 60, 5);`;
      const [firstSql, secondSql] = disableFirst ? [disableSql, ackSql] : [ackSql, disableSql];

      const { barrier2, finalState } = await runSerializedOverlap({
        label: `[CONCURRENCY D] disable vs ack (disableFirst=${disableFirst})`,
        firstSql,
        secondSql,
        eventId: evAck,
        deliveryId: delivId,
        assertFinal: ({ finalState: st }) => {
          assert.equal(st.events_left, 0, "disable vs ack removes task event");
          assert.equal(st.deliveries.length, 1);
          assert.equal(st.deliveries[0].state, "sent", "disable vs ack preserves sent delivery fact in ledger");
          assert.equal(st.deliveries[0].provider_reference, "resend-ref");
          assert.equal(st.deliveries[0].cancel_requested, disableFirst);
        },
      });
      const d = finalState.deliveries[0];
      console.log(
        `[CONCURRENCY D] disable_classroom_tasks vs ack_classroom_delivery (disableFirst=${disableFirst}): observed block s1_pid=${barrier2.s1_pid} -> s2_pid=${barrier2.s2_pid} (${barrier2.wait_event_type}:${barrier2.wait_event}, blocking_pids=${JSON.stringify(barrier2.blocking_pids)}), no 40P01, final=${JSON.stringify({ events_left: finalState.events_left, delivery: { state: d.state, cancel_requested: d.cancel_requested, provider_reference: d.provider_reference } })} (PASS)`,
      );
    }

    // (E) Real SQL-to-JS contract test: pipe actual PostgreSQL begin_classroom_delivery_send JSON
    // directly into createClassroomEmailTransport to verify persisted created_at & TTL fail-closed behavior.
    const {
      createClassroomEmailTransport,
      formatClassroomTaskMessage,
      RESEND_IDEMPOTENCY_TTL_MS,
    } = require("../src/services/classroomDeliveryService");

    const evTtl = seedOneNewEvent("w-ttl-contract");
    const beginContractOut = sql(`
      set role service_role;
      select public.materialize_classroom_deliveries('${evTtl}'::uuid, array['email'], 'v1');
      with c as (select public.claim_classroom_delivery(60, 5) as row)
      select 'BEGIN_JSON=' || public.begin_classroom_delivery_send(
        (c.row->>'id')::uuid,
        (c.row->>'claim_token')::uuid,
        30, 5, 'v1:' || repeat('b', 64), 'v1'
      )::text
      from c;
      reset role;
    `);
    const beginMatch = /BEGIN_JSON=(\{.*\})/.exec(beginContractOut);
    assert.ok(beginMatch, `Failed to capture BEGIN_JSON: ${beginContractOut}`);
    const pgSession = JSON.parse(beginMatch[1]);
    assert.equal(pgSession.allowed, true);
    assert.equal(typeof pgSession.created_at, "string");
    const persistedCreatedAtMs = Date.parse(pgSession.created_at);
    assert.ok(Number.isFinite(persistedCreatedAtMs), "PostgreSQL created_at parses as finite epoch ms");

    const timeoutTransport = createClassroomEmailTransport({
      apiKey: "re_contract_test",
      fetchImpl: async () => {
        const err = new Error("Simulated timeout");
        err.name = "TimeoutError";
        throw err;
      },
    });
    const pgMessage = formatClassroomTaskMessage(pgSession.payload);

    // 1) Timeout within TTL -> retryable with same Idempotency-Key
    const withinRes = await timeoutTransport.send(pgMessage, pgSession, {
      now: () => persistedCreatedAtMs + 60_000,
    });
    assert.equal(withinRes.status, "not_accepted");
    assert.equal(withinRes.permanent, false);
    assert.equal(withinRes.errorCode, "resend_transient_with_idempotency");

    // 2) Timeout after TTL -> fail closed as unknown
    const afterTtlRes = await timeoutTransport.send(pgMessage, pgSession, {
      now: () => persistedCreatedAtMs + RESEND_IDEMPOTENCY_TTL_MS + 60_000,
    });
    assert.equal(afterTtlRes.status, "unknown");
    assert.equal(afterTtlRes.errorCode, "resend_ambiguous_timeout");

    // 3) Missing created_at -> fail closed as unknown
    const sessionWithoutDate = { ...pgSession };
    delete sessionWithoutDate.created_at;
    const missingDateRes = await timeoutTransport.send(pgMessage, sessionWithoutDate, {
      now: () => persistedCreatedAtMs + 1_000,
    });
    assert.equal(missingDateRes.status, "unknown");
    assert.equal(missingDateRes.errorCode, "resend_ambiguous_timeout");

    console.log(
      `[CONTRACT E] real PG begin_classroom_delivery_send -> createClassroomEmailTransport: created_at=${pgSession.created_at}, withinTTL=${withinRes.status}, afterTTL=${afterTtlRes.status} (${afterTtlRes.errorCode}), missingDate=${missingDateRes.status} (PASS)`,
    );

    console.log(
      `CLASSROOM_DELIVERIES_SQL_OK (PostgreSQL ${pgVersion}): 019 rollback/replay, RLS/ACL, unified lock order (app_users->google_authorizations->event->delivery), observable pg_stat_activity/pg_blocking_pids barriers for concurrent disable vs materialize/begin_send/ack without 40P01 deadlock, ack sent only from sending/unknown, exhausted retry_wait->dead in claim, concurrent SKIP LOCKED claim, beginSend created_at TTL contract`,
    );
  } finally {
    for (const child of activeChildren) {
      try {
        child.kill();
      } catch {}
    }
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
  console.error(error.stack || error.message);
  process.exitCode = 1;
});
