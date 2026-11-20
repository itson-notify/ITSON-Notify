// Standalone offline PostgreSQL cluster integration verifier for 019_classroom_notification_deliveries.sql.
// Usage: node scripts/verify-classroom-deliveries-sql.cjs "C:/Program Files/PostgreSQL/16/bin"
const fs = require("node:fs");
const path = require("node:path");
const net = require("node:net");
const { spawnSync, spawn } = require("node:child_process");
const assert = require("node:assert/strict");

const bin = process.argv[2];
if (!bin) throw new Error("Provide a local PostgreSQL bin directory");

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
const executable = (name) => path.join(bin, name + (process.platform === "win32" ? ".exe" : ""));

function run(name, args, input) {
  const output = path.join(root, "command-output.txt");
  const fd = fs.openSync(output, "w");
  let result;
  try {
    result = spawnSync(executable(name), args, {
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
  if (result.error || result.status !== 0) throw Error(`${name} failed: ${result.error ?? text}`);
  return text;
}

async function main() {
  let started = false;
  try {
    run("initdb", ["-D", data, "-U", "classroom_test", "--auth=trust", "--no-locale", "--encoding=UTF8"]);
    const port = await new Promise((resolve) => {
      const server = net.createServer();
      server.listen(0, "127.0.0.1", () => {
        const p = server.address().port;
        server.close(() => resolve(p));
      });
    });
    run("pg_ctl", ["-D", data, "-l", path.join(root, "server.log"), "-o", `-h 127.0.0.1 -p ${port} -F`, "-w", "start"]);
    started = true;

    const args = ["-X", "-h", "127.0.0.1", "-p", String(port), "-U", "classroom_test", "-d", "postgres", "-v", "ON_ERROR_STOP=1"];
    const sql = (text) => run("psql", args, text);

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
    assert.throws(() => sql(`begin;\n${m019}\nselect 1/0;\ncommit;`), /psql failed/);
    absent();

    // Replayable twice without error
    for (let attempt = 0; attempt < 2; attempt += 1) {
      sql(`begin;\n${m019}\ncommit;`);
    }

    sql(fs.readFileSync(path.resolve(__dirname, "../tests/sql/classroomDeliveries.sql"), "utf8"));

    // Real two-process concurrent claim test (FOR UPDATE SKIP LOCKED):
    // Seed 1 pending delivery and have two concurrent psql workers claim simultaneously.
    sql(`
      set role service_role;
      update public.google_authorizations
        set scope = 'https://www.googleapis.com/auth/classroom.courses.readonly https://www.googleapis.com/auth/classroom.coursework.me.readonly',
            status = 'active'
        where user_id = '00000000-0000-4000-8000-000000000011';
      delete from public.classroom_notification_deliveries;
      select public.sync_classroom(
        '00000000-0000-4000-8000-000000000011',
        'g-ledger-1',
        '[{"id":"c-ledger-1","name":"Arquitectura de Software","coursework":[
          {"id":"w-base","title":"Tarea base","state":"PUBLISHED"},
          {"id":"w-new-1","title":"Proyecto Unidad 1","state":"PUBLISHED"},
          {"id":"w-new-2","title":"Proyecto Unidad 2","state":"PUBLISHED"},
          {"id":"w-new-3","title":"Proyecto Unidad 3","state":"PUBLISHED"},
          {"id":"w-conc-1","title":"Tarea Concurrente","state":"PUBLISHED"}
        ]}]'::jsonb
      );
      select public.materialize_classroom_deliveries(
        (select e.id from public.classroom_task_events e join public.classroom_coursework w on w.id = e.coursework_id where w.external_coursework_id = 'w-conc-1'),
        array['email'],
        'v1'
      );
      reset role;
    `);

    const concurrent = (text) =>
      new Promise((resolve, reject) => {
        const child = spawn(executable("psql"), args, { env, windowsHide: true, stdio: ["pipe", "pipe", "pipe"] });
        let out = "";
        let err = "";
        child.stdout.on("data", (s) => {
          out += s;
        });
        child.stderr.on("data", (s) => {
          err += s;
        });
        child.on("error", reject);
        child.on("close", (code) => (code === 0 ? resolve(out) : reject(Error(err))));
        child.stdin.end(text);
      });

    const claimCall = "set role service_role; select coalesce(public.claim_classroom_delivery(60, 5)->>'state', 'EMPTY');";
    const results = await Promise.all([
      concurrent(`begin; ${claimCall} select pg_sleep(0.2); commit;`),
      concurrent(claimCall),
    ]);

    assert.equal(results.filter((out) => /claimed/.test(out)).length, 1);
    assert.equal(results.filter((out) => /EMPTY/.test(out)).length, 1);

    console.log(
      "CLASSROOM_DELIVERIES_SQL_OK: 019 rollback/replay, RLS/ACL, manifest freeze, lease recovery, sending->unknown, late ACK, multi-channel delivered_at, scope revocation, event deletion trigger, concurrent SKIP LOCKED claim",
    );
  } finally {
    if (started || fs.existsSync(path.join(data, "postmaster.pid"))) {
      run("pg_ctl", ["-D", data, "-m", "fast", "-w", "stop"]);
    }
    fs.rmSync(root, { recursive: true, force: true });
  }
}

main().catch((error) => {
  console.error(error.message);
  process.exitCode = 1;
});
