// ITN-28 - Simula un cambio de calificación de un usuario de prueba y verifica
// el registro en notifications_log. Datos inventados; ningún dato real.
const { test, describe } = require("node:test");
const assert = require("node:assert/strict");

const { detectChanges, changeKey } = require("../../src/services/gradeChangeService");
const { notifyGradeChange, buildMessage, MAX_ATTEMPTS } = require("../../src/services/notificationService");
const { buildChannels, RESEND_URL } = require("../../src/services/notificationChannels");

const USUARIO_PRUEBA = { id: "u-prueba", email: "alumno.prueba@test.local" };

// Repo en memoria de grade_changes (mismo contrato que en las pruebas de ITN-24).
function gradeRepo(snapshots) {
  const gradeChanges = [];
  return {
    gradeChanges,
    async getPreviousSnapshotItems(userId, currentSnapshotId) {
      const propios = snapshots.filter((s) => s.userId === userId);
      const i = propios.findIndex((s) => s.id === currentSnapshotId);
      if (i <= 0) return null;
      return { snapshotId: propios[i - 1].id, items: propios[i - 1].items };
    },
    async getSnapshotItems(snapshotId) {
      return snapshots.find((s) => s.id === snapshotId)?.items ?? [];
    },
    async insertGradeChanges(rows) {
      const existentes = new Set(gradeChanges.map(changeKey));
      const nuevas = [];
      for (const row of rows) {
        if (existentes.has(changeKey(row))) continue;
        const saved = { id: `gc-${gradeChanges.length + 1}`, ...row };
        gradeChanges.push(saved);
        existentes.add(changeKey(row));
        nuevas.push(saved);
      }
      return nuevas;
    },
  };
}

// Repo en memoria de notifications_log. Respeta el unique
// (grade_change_id, channel) de la migración 002: claimNotification inserta si
// no existe y, si ya existe, devuelve la fila existente sin tocarla.
function notificationsRepo() {
  const log = [];
  return {
    log,
    async claimNotification(row) {
      const existente = log.find(
        (r) => r.grade_change_id === row.grade_change_id && r.channel === row.channel,
      );
      if (existente) return { ...existente };
      const saved = {
        id: `nl-${log.length + 1}`,
        status: "pending",
        attempts: 0,
        error: null,
        sent_at: null,
        ...row,
      };
      log.push(saved);
      return { ...saved };
    },
    async updateNotification(id, patch) {
      Object.assign(log.find((r) => r.id === id), patch);
    },
  };
}

const silentLogger = () => {
  const lines = [];
  const push = (l) => lines.push(l);
  return { lines, info: push, warn: push, error: push };
};

// Simula dos corridas del worker: 70 -> 75 en una tarea del usuario de prueba.
async function simularCambio() {
  const items = (value) => [
    { subjectId: "subj-prueba", externalItemId: "9002", label: "Tarea 2", value, text: null },
  ];
  const repo = gradeRepo([
    { id: "snap-1", userId: USUARIO_PRUEBA.id, items: items(70) },
    { id: "snap-2", userId: USUARIO_PRUEBA.id, items: items(75) },
  ]);
  const { inserted } = await detectChanges(
    { userId: USUARIO_PRUEBA.id, currentSnapshotId: "snap-2" },
    repo,
  );
  assert.equal(inserted.length, 1);
  return inserted[0];
}

const context = { subjectName: "Materia de prueba", itemLabel: "Tarea 2" };

describe("notifyGradeChange", () => {
  test("(1) escribe en notifications_log con status sent", async () => {
    const cambio = await simularCambio();
    const repo = notificationsRepo();
    const logger = silentLogger();
    const channels = buildChannels({ env: {}, logger });

    const results = await notifyGradeChange(cambio, { repo, channels, context });

    assert.deepEqual(results, [{ channel: "log", status: "sent", attempts: 1 }]);
    assert.equal(repo.log.length, 1);
    const [fila] = repo.log;
    assert.equal(fila.grade_change_id, cambio.id);
    assert.equal(fila.user_id, USUARIO_PRUEBA.id);
    assert.equal(fila.channel, "log");
    assert.equal(fila.status, "sent");
    assert.ok(fila.sent_at);
    assert.equal(fila.payload.text, "Tarea 2 en Materia de prueba cambió de 70 a 75 (calificación).");
    assert.ok(logger.lines.some((l) => l.includes(`grade_change=${cambio.id}`)));
  });

  test("(2) un segundo envío del mismo cambio no se duplica", async () => {
    const cambio = await simularCambio();
    const repo = notificationsRepo();
    let envios = 0;
    const channels = [{ name: "log", send: async () => envios++ }];

    await notifyGradeChange(cambio, { repo, channels, context });
    const segunda = await notifyGradeChange(cambio, { repo, channels, context });

    assert.equal(envios, 1);
    assert.equal(repo.log.length, 1);
    assert.deepEqual(segunda, [{ channel: "log", status: "duplicate", attempts: 1 }]);
  });

  test("(3) sin RESEND_API_KEY solo funciona el canal log", async () => {
    const cambio = await simularCambio();
    const repo = notificationsRepo();
    const logger = silentLogger();
    let llamadasFetch = 0;
    const fetchImpl = async () => (llamadasFetch++, { ok: true });

    const channels = buildChannels({
      env: { NOTIFY_EMAIL_TO: "destino@test.local" },
      logger,
      fetchImpl,
    });
    const results = await notifyGradeChange(cambio, { repo, channels, context });

    assert.deepEqual(channels.map((c) => c.name), ["log"]);
    assert.deepEqual(results.map((r) => `${r.channel}:${r.status}`), ["log:sent"]);
    assert.deepEqual(repo.log.map((r) => r.channel), ["log"]);
    assert.equal(llamadasFetch, 0);
    assert.ok(logger.lines.some((l) => l.includes("canal email omitido")));
  });

  test("con RESEND_API_KEY también envía por email a Resend", async () => {
    const cambio = await simularCambio();
    const repo = notificationsRepo();
    const peticiones = [];
    const fetchImpl = async (url, init) => (peticiones.push({ url, init }), { ok: true });

    const channels = buildChannels({
      env: { RESEND_API_KEY: "re_prueba_falsa", NOTIFY_EMAIL_TO: "destino@test.local" },
      logger: silentLogger(),
      fetchImpl,
    });
    const results = await notifyGradeChange(cambio, { repo, channels, context });

    assert.deepEqual(results.map((r) => `${r.channel}:${r.status}`), ["log:sent", "email:sent"]);
    assert.equal(peticiones.length, 1);
    assert.equal(peticiones[0].url, RESEND_URL);
    const body = JSON.parse(peticiones[0].init.body);
    assert.deepEqual(body.to, ["destino@test.local"]);
    assert.equal(body.subject, "ITSON Notify: cambio de calificación");
  });

  test("un email fallido queda failed, no detiene al log y se reintenta después", async () => {
    const cambio = await simularCambio();
    const repo = notificationsRepo();
    let falla = true;
    const fetchImpl = async () =>
      falla ? { ok: false, status: 500, json: async () => ({ message: "error interno" }) } : { ok: true };
    const env = { RESEND_API_KEY: "re_prueba_falsa", NOTIFY_EMAIL_TO: "destino@test.local" };
    const channels = buildChannels({ env, logger: silentLogger(), fetchImpl });

    const primera = await notifyGradeChange(cambio, { repo, channels, context });
    assert.deepEqual(primera.map((r) => `${r.channel}:${r.status}`), ["log:sent", "email:failed"]);
    const email = repo.log.find((r) => r.channel === "email");
    assert.equal(email.error, "Resend respondió 500: error interno");
    assert.ok(!email.error.includes(env.RESEND_API_KEY), "el error no expone la llave");

    falla = false;
    const segunda = await notifyGradeChange(cambio, { repo, channels, context });
    assert.deepEqual(segunda.map((r) => `${r.channel}:${r.status}`), ["log:duplicate", "email:sent"]);
    assert.equal(repo.log.length, 2, "el reintento usa la misma fila");
    assert.equal(email.attempts, 2);
    assert.equal(email.error, null);
  });

  test("deja de reintentar al llegar a MAX_ATTEMPTS", async () => {
    const cambio = await simularCambio();
    const repo = notificationsRepo();
    const channels = [{ name: "email", send: async () => { throw new Error("caído"); } }];

    for (let i = 0; i < MAX_ATTEMPTS; i++) {
      await notifyGradeChange(cambio, { repo, channels, context });
    }
    const final = await notifyGradeChange(cambio, { repo, channels, context });

    assert.deepEqual(final, [{ channel: "email", status: "max_attempts", attempts: MAX_ATTEMPTS }]);
  });

  test("el mensaje no incluye datos personales ni ids", async () => {
    const cambio = await simularCambio();
    const { subject, text } = buildMessage(cambio, context);
    const todo = `${subject} ${text}`;

    for (const dato of [USUARIO_PRUEBA.email, USUARIO_PRUEBA.id, cambio.id, cambio.subject_id]) {
      assert.ok(!todo.includes(dato), `el mensaje no debe incluir ${dato}`);
    }
  });

  test("textos de created, deleted y total del curso", () => {
    const base = { field_name: "grade_value", previous_value: null, current_value: null };
    assert.equal(
      buildMessage({ ...base, change_type: "created", current_value: "90" }, { itemLabel: "Examen" }).text,
      "Examen tiene calificación nueva: 90.",
    );
    assert.equal(
      buildMessage({ ...base, change_type: "deleted", previous_value: "60" }, { itemLabel: null }).text,
      "Total del curso ya no tiene calificación (antes: 60).",
    );
  });

  test("rechaza repo incompleto y grade_change sin id", async () => {
    const channels = [{ name: "log", send: async () => {} }];
    await assert.rejects(notifyGradeChange({ id: "x", user_id: "u" }, { repo: {}, channels }), /faltan/);
    await assert.rejects(
      notifyGradeChange({ user_id: "u" }, { repo: notificationsRepo(), channels }),
      /requiere un grade_change/,
    );
  });
});
