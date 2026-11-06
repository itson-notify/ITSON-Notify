// ITN-28 - Agrupación de cambios por ítem y reintento de pendientes. Usa el
// repo real de notifications_log sobre el Supabase simulado. Datos inventados.
const { test, describe } = require("node:test");
const assert = require("node:assert/strict");

const {
  buildGroupedMessage,
  groupChanges,
  notifyGroupedChanges,
  retryPendingNotifications,
  MAX_ATTEMPTS,
} = require("../../src/services/notificationService");
const { logChannel } = require("../../src/services/notificationChannels");
const { createNotificationRepository } = require("../../src/repositories/notificationRepository");
const { createLogger } = require("../../src/utils/logger");
const { createFakeSupabase } = require("../helpers/fakeSupabase");

const cambio = (extra) => ({
  user_id: "u-1",
  subject_id: "s-1",
  external_item_id: "9002",
  previous_snapshot_id: "snap-1",
  current_snapshot_id: "snap-2",
  change_type: "updated",
  ...extra,
});

const canal = (name, falla = false) => {
  const enviados = [];
  return {
    name,
    enviados,
    async send(message, meta) {
      if (falla) throw new Error("canal caído");
      enviados.push({ message, meta });
    },
  };
};

describe("buildGroupedMessage", () => {
  test("grade_value y grade_text salen en un solo texto, con el valor numérico", () => {
    const rows = [
      cambio({ id: "b", field_name: "grade_text", previous_value: "8.00", current_value: "9.00" }),
      cambio({ id: "a", field_name: "grade_value", previous_value: "8", current_value: "9" }),
    ];
    assert.equal(
      buildGroupedMessage(rows, { subjectName: "Cálculo", itemLabel: "Tarea 3" }).text,
      "Tarea 3 en Cálculo: calificación de 8 a 9.",
    );
  });

  test("solo grade_text también se notifica", () => {
    const rows = [cambio({ id: "a", field_name: "grade_text", previous_value: "-", current_value: "Aprobado" })];
    assert.equal(
      buildGroupedMessage(rows, { subjectName: "Cálculo", itemLabel: "Proyecto" }).text,
      "Proyecto en Cálculo: calificación de - a Aprobado.",
    );
  });

  test("label nuevo, total del curso y respaldo sin contexto", () => {
    const label = [
      cambio({ id: "a", field_name: "grade_label", previous_value: "Tarea", current_value: "Tarea 4" }),
    ];
    assert.equal(
      buildGroupedMessage(label, { itemLabel: "Tarea 4" }).text,
      "Tarea 4: nombre de la actividad de Tarea a Tarea 4.",
    );
    const total = [cambio({ id: "a", field_name: "grade_value", previous_value: "70", current_value: "72" })];
    assert.equal(buildGroupedMessage(total, { itemLabel: null }).text, "Total del curso: calificación de 70 a 72.");
    assert.equal(buildGroupedMessage(total).text, "Una actividad: calificación de 70 a 72.");
    const borrado = [cambio({ id: "a", field_name: "grade_value", change_type: "deleted", previous_value: "60", current_value: null })];
    assert.equal(buildGroupedMessage(borrado, { itemLabel: "Quiz" }).text, "Quiz: ya no tiene calificación (antes: 60).");
  });
});

describe("groupChanges", () => {
  test("agrupa por (subject_id, external_item_id) y reclama con el id menor", () => {
    const grupos = groupChanges([
      cambio({ id: "id-c", field_name: "grade_text" }),
      cambio({ id: "id-x", external_item_id: "9003", field_name: "grade_value" }),
      cambio({ id: "id-a", field_name: "grade_value" }),
      // Mismo external_item_id en otra materia: otro ítem.
      cambio({ id: "id-b", subject_id: "s-2", field_name: "grade_value" }),
    ]);
    assert.equal(grupos.length, 3);
    const g = grupos.find((x) => x.subjectId === "s-1" && x.externalItemId === "9002");
    assert.equal(g.claimId, "id-a");
    assert.deepEqual(g.ids, ["id-a", "id-c"]);
    assert.equal(g.snapshotId, "snap-2");
  });

  test("un ítem borrado busca su label en el snapshot anterior", () => {
    const [g] = groupChanges([cambio({ id: "a", field_name: "grade_value", change_type: "deleted" })]);
    assert.equal(g.snapshotId, "snap-1");
  });
});

describe("notifyGroupedChanges", () => {
  function setup() {
    const db = createFakeSupabase();
    db.tables.subjects.push({ id: "s-1", user_id: "u-1", name: "Cálculo" });
    db.tables.snapshot_grades.push({
      id: "g1", snapshot_id: "snap-2", subject_id: "s-1", external_item_id: "9002", grade_label: "Tarea 3",
    });
    return { db, repo: createNotificationRepository(db.client) };
  }
  const inserted = () => [
    cambio({ id: "gc-2", field_name: "grade_text", previous_value: "8.00", current_value: "9.00" }),
    cambio({ id: "gc-1", field_name: "grade_value", previous_value: "8", current_value: "9" }),
  ];

  test("dos filas del mismo ítem salen en un solo mensaje y una fila de log por canal", async () => {
    const { db, repo } = setup();
    const log = canal("log");

    const r = await notifyGroupedChanges(inserted(), { repo, channels: [log] });

    assert.equal(r.notified, 1);
    assert.equal(r.failed, 0);
    assert.equal(log.enviados.length, 1);
    assert.equal(log.enviados[0].message.text, "Tarea 3 en Cálculo: calificación de 8 a 9.");
    
    // Se añade userId a la aserción estricta de meta para coincidir con la actualización
    assert.deepEqual(log.enviados[0].meta, { userId: "u-1", gradeChangeId: "gc-1", gradeChangeIds: ["gc-1", "gc-2"] });

    assert.equal(db.tables.notifications_log.length, 1);
    const [fila] = db.tables.notifications_log;
    assert.equal(fila.grade_change_id, "gc-1");
    assert.equal(fila.status, "sent");
    assert.equal(fila.attempts, 1);
    assert.deepEqual(fila.payload.grade_change_ids, ["gc-1", "gc-2"]);
    assert.equal(fila.payload.text, "Tarea 3 en Cálculo: calificación de 8 a 9.");
  });

  test("si falla el contexto, usa los textos de respaldo y no falla", async () => {
    const { db, repo } = setup();
    db.failNext("subjects", "select");
    const log = canal("log");

    const r = await notifyGroupedChanges(inserted(), { repo, channels: [log] });
    assert.equal(r.notified, 1);
    assert.equal(log.enviados[0].message.text, "Una actividad: calificación de 8 a 9.");
  });

  test("un canal que falla queda failed y no detiene a los demás", async () => {
    const { db, repo } = setup();
    const r = await notifyGroupedChanges(inserted(), { repo, channels: [canal("log"), canal("email", true)] });

    assert.equal(r.notified, 1);
    assert.equal(r.failed, 1);
    const email = db.tables.notifications_log.find((f) => f.channel === "email");
    assert.equal(email.status, "failed");
    assert.equal(email.attempts, 1);
    assert.equal(email.error, "canal caído");
  });

  test("una falla de Supabase al reclamar cuenta como fallida sin lanzar", async () => {
    const { db, repo } = setup();
    db.failNext("notifications_log", "upsert");
    const r = await notifyGroupedChanges(inserted(), { repo, channels: [canal("log")] });
    assert.equal(r.failed, 1);
    assert.equal(r.notified, 0);
  });
});

describe("retryPendingNotifications", () => {
  const payload = { subject: "ITSON Notify: cambio de calificación", text: "Tarea 3 en Cálculo: calificación de 8 a 9.", grade_change_ids: ["gc-1", "gc-2"] };

  function setup(filas) {
    const db = createFakeSupabase();
    for (const f of filas) {
      db.tables.notifications_log.push({
        user_id: "u-1", channel: "email", payload, error: "previo", sent_at: null,
        created_at: "2026-10-30T10:00:00Z", ...f,
      });
    }
    return { db, repo: createNotificationRepository(db.client) };
  }

  test("reintento exitoso: reenvía el payload guardado y queda sent", async () => {
    const { db, repo } = setup([{ id: "n1", grade_change_id: "gc-1", status: "failed", attempts: 1 }]);
    const email = canal("email");

    const r = await retryPendingNotifications("u-1", { repo, channels: [canal("log"), email] });

    assert.deepEqual({ retried: r.retried, notified: r.notified, failed: r.failed }, { retried: 1, notified: 1, failed: 0 });
    assert.deepEqual(email.enviados[0].message, { subject: payload.subject, text: payload.text });
    
    // Se añade userId a la aserción estricta de meta para coincidir con la actualización
    assert.deepEqual(email.enviados[0].meta, { userId: "u-1", gradeChangeId: "gc-1", gradeChangeIds: ["gc-1", "gc-2"] });
    
    const [fila] = db.tables.notifications_log;
    assert.equal(fila.status, "sent");
    assert.equal(fila.attempts, 2);
    assert.equal(fila.error, null);
  });

  test("reintento que vuelve a fallar suma un intento", async () => {
    const { db, repo } = setup([{ id: "n1", grade_change_id: "gc-1", status: "pending", attempts: 3 }]);
    const r = await retryPendingNotifications("u-1", { repo, channels: [canal("email", true)] });

    assert.deepEqual({ retried: r.retried, notified: r.notified, failed: r.failed }, { retried: 1, notified: 0, failed: 1 });
    const [fila] = db.tables.notifications_log;
    assert.equal(fila.status, "failed");
    assert.equal(fila.attempts, 4);
  });

  test("ignora filas con attempts = MAX_ATTEMPTS, sin grade_change_id o de otro usuario", async () => {
    const { db, repo } = setup([
      { id: "n1", grade_change_id: "gc-1", status: "failed", attempts: MAX_ATTEMPTS },
      { id: "n2", grade_change_id: null, status: "failed", attempts: 1 },
      { id: "n3", grade_change_id: "gc-3", status: "failed", attempts: 1, user_id: "u-2" },
    ]);
    const antes = JSON.stringify(db.tables.notifications_log);
    const email = canal("email");

    const r = await retryPendingNotifications("u-1", { repo, channels: [email] });

    assert.equal(r.retried, 0);
    assert.equal(email.enviados.length, 0);
    assert.equal(JSON.stringify(db.tables.notifications_log), antes, "no toca ninguna fila");
  });

  test("deja igual una fila cuyo canal ya no está disponible", async () => {
    const { db, repo } = setup([{ id: "n1", grade_change_id: "gc-1", status: "failed", attempts: 1 }]);
    const r = await retryPendingNotifications("u-1", { repo, channels: [canal("log")] });
    assert.equal(r.retried, 0);
    assert.equal(db.tables.notifications_log[0].attempts, 1);
  });
});

describe("logChannel con el logger real", () => {
  test("ninguna línea lleva el texto ni los valores de calificación", async () => {
    const lineas = [];
    const logger = createLogger((l) => lineas.push(l));
    const texto = "Tarea 3 en Cálculo: calificación de 8 a 9.";

    await logChannel(logger).send(
      { subject: "ITSON Notify: cambio de calificación", text: texto },
      { gradeChangeId: "gc-1", gradeChangeIds: ["gc-1", "gc-2"] },
    );

    assert.equal(lineas.length, 1);
    const todo = lineas.join("\n");
    for (const prohibido of [texto, "Tarea 3", "Cálculo", "calificación", "de 8 a 9"]) {
      assert.ok(!todo.includes(prohibido), `apareció en el log: ${prohibido}`);
    }
    const { event, grade_change_id, grade_change_ids } = JSON.parse(lineas[0]);
    assert.deepEqual({ event, grade_change_id, grade_change_ids }, {
      event: "notificacion_enviada",
      grade_change_id: "gc-1",
      grade_change_ids: ["gc-1", "gc-2"],
    });
  });
});