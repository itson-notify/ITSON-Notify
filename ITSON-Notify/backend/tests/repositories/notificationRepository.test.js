// ITN-28 - Repo de notifications_log sobre el Supabase simulado. Datos
// inventados.
const { test, describe } = require("node:test");
const assert = require("node:assert/strict");

const { createNotificationRepository, contextKey } = require("../../src/repositories/notificationRepository");
const { createFakeSupabase } = require("../helpers/fakeSupabase");

const fila = (extra) => ({
  user_id: "u-1",
  grade_change_id: "gc-1",
  channel: "log",
  payload: { subject: "s", text: "t" },
  ...extra,
});

describe("notificationRepository", () => {
  test("claimNotification inserta en pending y, si ya existe, devuelve la fila sin tocarla", async () => {
    const db = createFakeSupabase();
    const repo = createNotificationRepository(db.client);

    const nueva = await repo.claimNotification(fila());
    assert.equal(nueva.status, "pending");
    assert.equal(nueva.attempts, 0);

    await repo.updateNotification(nueva.id, { status: "failed", attempts: 2, error: "x" });
    const otra = await repo.claimNotification(fila({ payload: { subject: "otro", text: "otro" } }));
    assert.equal(otra.id, nueva.id);
    assert.equal(otra.status, "failed");
    assert.equal(otra.attempts, 2);
    assert.equal(db.tables.notifications_log.length, 1);
    assert.deepEqual(db.tables.notifications_log[0].payload, { subject: "s", text: "t" });

    // Otro canal del mismo grade_change es otra fila.
    await repo.claimNotification(fila({ channel: "email" }));
    assert.equal(db.tables.notifications_log.length, 2);
  });

  test("listPendingNotifications filtra usuario, status, attempts y grade_change_id", async () => {
    const db = createFakeSupabase();
    const base = { channel: "log", payload: { subject: "s", text: "t" }, created_at: "2026-10-30T10:00:00Z" };
    db.tables.notifications_log.push(
      { ...base, id: "n1", user_id: "u-1", grade_change_id: "gc-1", status: "failed", attempts: 1 },
      { ...base, id: "n2", user_id: "u-1", grade_change_id: "gc-2", status: "pending", attempts: 0 },
      { ...base, id: "n3", user_id: "u-1", grade_change_id: "gc-3", status: "sent", attempts: 1 },
      { ...base, id: "n4", user_id: "u-1", grade_change_id: "gc-4", status: "failed", attempts: 5 },
      { ...base, id: "n5", user_id: "u-1", grade_change_id: null, status: "failed", attempts: 1 },
      { ...base, id: "n6", user_id: "u-2", grade_change_id: "gc-6", status: "failed", attempts: 1 },
    );
    const repo = createNotificationRepository(db.client);

    const pendientes = await repo.listPendingNotifications("u-1", 5);
    assert.deepEqual(pendientes.map((p) => p.id).sort(), ["n1", "n2"]);
  });

  test("getItemContext lee materia y label en una consulta por tabla", async () => {
    const db = createFakeSupabase();
    db.tables.subjects.push({ id: "s-1", user_id: "u-1", name: "Materia X" });
    db.tables.snapshot_grades.push(
      { id: "g1", snapshot_id: "snap-2", subject_id: "s-1", external_item_id: "1", grade_label: "Tarea A" },
      { id: "g2", snapshot_id: "snap-1", subject_id: "s-1", external_item_id: "2", grade_label: "Tarea B" },
      { id: "g3", snapshot_id: "snap-2", subject_id: "s-1", external_item_id: "9", grade_label: null },
      // Mismo ítem en el otro snapshot, con otro label: no debe usarse.
      { id: "g4", snapshot_id: "snap-1", subject_id: "s-1", external_item_id: "1", grade_label: "Viejo" },
    );
    const repo = createNotificationRepository(db.client);

    const ctx = await repo.getItemContext([
      { subjectId: "s-1", externalItemId: "1", snapshotId: "snap-2" },
      { subjectId: "s-1", externalItemId: "2", snapshotId: "snap-1" }, // borrado: snapshot anterior
      { subjectId: "s-1", externalItemId: "9", snapshotId: "snap-2" }, // total del curso
      { subjectId: "s-x", externalItemId: "3", snapshotId: "snap-2" }, // sin datos
    ]);

    assert.deepEqual(ctx.get(contextKey("s-1", "1")), { subjectName: "Materia X", itemLabel: "Tarea A" });
    assert.deepEqual(ctx.get(contextKey("s-1", "2")), { subjectName: "Materia X", itemLabel: "Tarea B" });
    assert.deepEqual(ctx.get(contextKey("s-1", "9")), { subjectName: "Materia X", itemLabel: null });
    assert.deepEqual(ctx.get(contextKey("s-x", "3")), { subjectName: undefined, itemLabel: undefined });
    const lecturas = db.calls.filter((c) => c.op === "select");
    assert.deepEqual(lecturas.map((c) => c.table), ["subjects", "snapshot_grades"]);
  });
});
