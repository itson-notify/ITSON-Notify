// Canal email por alumno: cada aviso va al correo del alumno dueño
// (app_users.email) y NOTIFY_EMAIL_TO es solo un override de pruebas. Usa el repo
// real de notifications_log sobre el Supabase simulado y un fetch de Resend
// simulado. Datos inventados: ningún correo, llave ni alumno real.
const { test, describe } = require("node:test");
const assert = require("node:assert/strict");

const {
  notifyGroupedChanges,
  retryPendingNotifications,
} = require("../../src/services/notificationService");
const {
  buildChannels,
  emailChannel,
  motivoCorreoNoEnviable,
  RESEND_URL,
} = require("../../src/services/notificationChannels");
const { createNotificationRepository } = require("../../src/repositories/notificationRepository");
const { createFakeSupabase } = require("../helpers/fakeSupabase");

const API_KEY = "re_prueba_falsa_por_alumno";
const ALUMNO_A = { id: "u-a", email: "alumna.a@correo-prueba.mx" };
const ALUMNO_B = { id: "u-b", email: "alumno.b@otro-prueba.mx" };
const OVERRIDE = "pruebas.override@correo-prueba.mx";

const silentLogger = () => {
  const lines = [];
  const push = (event, fields = {}) => lines.push(JSON.stringify({ event, ...fields }));
  return { lines, info: push, warn: push, error: push };
};

// Resend simulado: guarda cada body enviado.
function resend() {
  const enviados = [];
  const fetchImpl = async (url, init) => {
    assert.equal(url, RESEND_URL);
    enviados.push(JSON.parse(init.body));
    return { ok: true };
  };
  return { enviados, fetchImpl };
}

function setup(usuarios = [ALUMNO_A, ALUMNO_B]) {
  const db = createFakeSupabase();
  for (const u of usuarios) db.tables.app_users.push({ ...u });
  const repo = createNotificationRepository(db.client);
  return { db, repo };
}

const cambio = (extra) => ({
  user_id: ALUMNO_A.id,
  subject_id: "s-1",
  external_item_id: "9002",
  previous_snapshot_id: "snap-1",
  current_snapshot_id: "snap-2",
  change_type: "updated",
  field_name: "grade_value",
  previous_value: "8",
  current_value: "9",
  ...extra,
});

const estados = (r) => r.results.map((x) => `${x.channel}:${x.status}`);

describe("canal email por alumno", () => {
  test("sin NOTIFY_EMAIL_TO, Resend recibe el correo del alumno", async () => {
    const { db, repo } = setup();
    const r = resend();
    const channels = buildChannels({
      env: { RESEND_API_KEY: API_KEY },
      logger: silentLogger(),
      fetchImpl: r.fetchImpl,
      emailRepo: repo,
    });
    assert.deepEqual(channels.map((c) => c.name), ["log", "email"]);

    const res = await notifyGroupedChanges([cambio({ id: "gc-1" })], { repo, channels });

    assert.deepEqual(estados(res), ["log:sent", "email:sent"]);
    assert.equal(r.enviados.length, 1);
    assert.deepEqual(r.enviados[0].to, [ALUMNO_A.email]);
    assert.equal(r.enviados[0].from, "ITSON Notify <onboarding@resend.dev>");
    assert.equal(r.enviados[0].subject, "ITSON Notify: cambio de calificación");
    assert.equal(db.tables.notifications_log.find((n) => n.channel === "email").status, "sent");
  });

  test("getUserEmail lee solo la columna email de app_users filtrando por id", async () => {
    const { db } = setup();
    const consultas = [];
    const from = db.client.from.bind(db.client);
    const client = {
      ...db.client,
      from(table) {
        const builder = from(table);
        const consulta = { table, select: null, eq: [] };
        consultas.push(consulta);
        const select = builder.select.bind(builder);
        const eq = builder.eq.bind(builder);
        builder.select = (cols) => ((consulta.select = cols), select(cols));
        builder.eq = (col, val) => (consulta.eq.push([col, val]), eq(col, val));
        return builder;
      },
    };
    const repo = createNotificationRepository(client);

    assert.equal(await repo.getUserEmail(ALUMNO_B.id), ALUMNO_B.email);
    assert.equal(await repo.getUserEmail("u-inexistente"), null);
    assert.deepEqual(consultas[0], { table: "app_users", select: "email", eq: [["id", ALUMNO_B.id]] });
  });

  test("con NOTIFY_EMAIL_TO, todo va a esa dirección y no se consulta app_users", async () => {
    const { db, repo } = setup();
    const r = resend();
    const channels = buildChannels({
      env: { RESEND_API_KEY: API_KEY, NOTIFY_EMAIL_TO: OVERRIDE },
      logger: silentLogger(),
      fetchImpl: r.fetchImpl,
      emailRepo: repo,
    });
    db.calls.length = 0;

    const res = await notifyGroupedChanges([cambio({ id: "gc-1" })], { repo, channels });

    assert.deepEqual(estados(res), ["log:sent", "email:sent"]);
    assert.deepEqual(r.enviados.map((e) => e.to), [[OVERRIDE]]);
    assert.ok(!db.calls.some((c) => c.table === "app_users"), "no consulta app_users");
  });

  test("dos alumnos en la misma corrida: cada uno recibe en su propio correo", async () => {
    const { repo } = setup();
    const r = resend();
    const channels = buildChannels({
      env: { RESEND_API_KEY: API_KEY },
      logger: silentLogger(),
      fetchImpl: r.fetchImpl,
      emailRepo: repo,
    });

    const res = await notifyGroupedChanges(
      [
        cambio({ id: "gc-1", user_id: ALUMNO_A.id }),
        cambio({ id: "gc-2", user_id: ALUMNO_B.id, subject_id: "s-2" }),
      ],
      { repo, channels },
    );

    assert.equal(res.failed, 0);
    assert.deepEqual(
      r.enviados.map((e) => e.to).sort(),
      [[ALUMNO_A.email], [ALUMNO_B.email]].sort(),
    );
    assert.ok(r.enviados.every((e) => e.to.length === 1), "un solo destinatario por correo");
  });

  for (const [caso, email, motivo] of [
    ["sin correo", null, /sin correo/],
    ["correo vacío", "   ", /sin correo/],
    ["correo inválido", "no-es-un-correo", /inválido/],
    ["dominio .test (ensayo sintético)", "ensayo.itn56.1763300000000@example.test", /dominio reservado/],
    ["dominio example.com", "alguien@example.com", /dominio reservado/],
    ["subdominio de example.org", "alguien@mail.example.org", /dominio reservado/],
    ["dominio .invalid", "alguien@algo.invalid", /dominio reservado/],
    ["dominio .localhost", "alguien@maquina.localhost", /dominio reservado/],
  ]) {
    test(`alumno con ${caso}: no llama a Resend, queda failed y el error no trae el correo`, async () => {
      const { db, repo } = setup([{ id: ALUMNO_A.id, email }]);
      const r = resend();
      const channels = buildChannels({
        env: { RESEND_API_KEY: API_KEY },
        logger: silentLogger(),
        fetchImpl: r.fetchImpl,
        emailRepo: repo,
      });

      const res = await notifyGroupedChanges([cambio({ id: "gc-1" })], { repo, channels });

      assert.deepEqual(estados(res), ["log:sent", "email:failed"], "el log sigue enviándose");
      assert.equal(r.enviados.length, 0, "no se llama a Resend");
      const fila = db.tables.notifications_log.find((n) => n.channel === "email");
      assert.equal(fila.status, "failed");
      assert.match(fila.error, motivo);
      if (email && email.trim()) {
        assert.ok(!fila.error.includes(email.trim()), "el error no incluye el correo");
        assert.ok(!res.results.some((x) => String(x.error ?? "").includes(email.trim())));
      }
    });
  }

  test("el ensayo sintético falla solo en email; log y web_push siguen", async () => {
    const { db, repo } = setup([{ id: ALUMNO_A.id, email: "ensayo.itn56.1@example.test" }]);
    const r = resend();
    const push = [];
    const channels = [
      ...buildChannels({ env: { RESEND_API_KEY: API_KEY }, logger: silentLogger(), fetchImpl: r.fetchImpl, emailRepo: repo }),
      { name: "web_push", send: async (m, meta) => push.push(meta.userId) },
    ];

    const res = await notifyGroupedChanges([cambio({ id: "gc-1" })], { repo, channels });

    assert.deepEqual(estados(res), ["log:sent", "email:failed", "web_push:sent"]);
    assert.deepEqual(push, [ALUMNO_A.id]);
    assert.equal(r.enviados.length, 0);
    assert.ok(!db.tables.notifications_log.some((n) => String(n.error ?? "").includes("@")));
  });

  test("retryPendingNotifications reenvía al correo del alumno dueño", async () => {
    const { db, repo } = setup();
    const payload = { subject: "ITSON Notify: cambio de calificación", text: "Tarea 3 en Cálculo: calificación de 8 a 9.", grade_change_ids: ["gc-9"] };
    db.tables.notifications_log.push({
      id: "n1", user_id: ALUMNO_B.id, grade_change_id: "gc-9", channel: "email", payload,
      status: "failed", attempts: 1, error: "previo", sent_at: null, created_at: "2026-11-01T10:00:00Z",
    });
    const r = resend();
    const channels = buildChannels({
      env: { RESEND_API_KEY: API_KEY },
      logger: silentLogger(),
      fetchImpl: r.fetchImpl,
      emailRepo: repo,
    });

    const res = await retryPendingNotifications(ALUMNO_B.id, { repo, channels });

    assert.deepEqual({ retried: res.retried, notified: res.notified, failed: res.failed }, { retried: 1, notified: 1, failed: 0 });
    assert.deepEqual(r.enviados.map((e) => e.to), [[ALUMNO_B.email]]);
    assert.equal(r.enviados[0].text, payload.text);
    assert.equal(db.tables.notifications_log[0].status, "sent");
  });

  test("una falla al leer app_users deja failed sin datos de la fila", async () => {
    const { db, repo } = setup();
    const r = resend();
    const channels = buildChannels({ env: { RESEND_API_KEY: API_KEY }, logger: silentLogger(), fetchImpl: r.fetchImpl, emailRepo: repo });
    db.failNext("app_users", "select");

    const res = await notifyGroupedChanges([cambio({ id: "gc-1" })], { repo, channels });

    assert.deepEqual(estados(res), ["log:sent", "email:failed"]);
    assert.equal(r.enviados.length, 0);
    const fila = db.tables.notifications_log.find((n) => n.channel === "email");
    assert.ok(!fila.error.includes("@"));
  });
});

describe("buildChannels: canal email", () => {
  test("se arma solo con RESEND_API_KEY (NOTIFY_EMAIL_TO ya no es obligatoria)", () => {
    const { repo } = setup();
    const logger = silentLogger();
    const channels = buildChannels({ env: { RESEND_API_KEY: API_KEY }, logger, emailRepo: repo });
    assert.deepEqual(channels.map((c) => c.name), ["log", "email"]);
    assert.ok(!logger.lines.some((l) => l.includes("canal_email_omitido")));
  });

  test("sin RESEND_API_KEY se omite con canal_email_omitido", () => {
    const { repo } = setup();
    const logger = silentLogger();
    const channels = buildChannels({ env: { NOTIFY_EMAIL_TO: OVERRIDE }, logger, emailRepo: repo });
    assert.deepEqual(channels.map((c) => c.name), ["log"]);
    const linea = JSON.parse(logger.lines.find((l) => l.includes("canal_email_omitido")));
    assert.deepEqual(linea, { event: "canal_email_omitido", reason: "sin_resend_api_key" });
    assert.ok(!logger.lines.join("\n").includes(OVERRIDE), "el log no trae correos");
  });

  test("con llave pero sin emailRepo ni override se omite", () => {
    const logger = silentLogger();
    const channels = buildChannels({ env: { RESEND_API_KEY: API_KEY }, logger });
    assert.deepEqual(channels.map((c) => c.name), ["log"]);
    assert.ok(logger.lines.some((l) => l.includes("sin_email_repo")));
    assert.ok(!logger.lines.join("\n").includes(API_KEY));
  });

  test("emailChannel exige override o repo", () => {
    assert.throws(() => emailChannel({ apiKey: API_KEY, from: "x" }), /overrideTo o emailRepo/);
  });
});

describe("motivoCorreoNoEnviable", () => {
  test("acepta correos normales y rechaza reservados sin repetir el correo", () => {
    assert.equal(motivoCorreoNoEnviable("Alumno.Real@Gmail.com"), null);
    assert.equal(motivoCorreoNoEnviable("alumno@potros.itson.edu.mx"), null);
    assert.equal(motivoCorreoNoEnviable("alguien@notexample.com"), null);
    for (const malo of [undefined, null, "", "a@b", "a b@c.mx", "x@example.net", "x@foo.example"]) {
      const motivo = motivoCorreoNoEnviable(malo);
      assert.ok(motivo, `debe rechazar ${malo}`);
      if (malo) assert.ok(!motivo.includes(malo));
    }
  });
});
