// Pruebas del servicio con un repo en memoria que cumple el contrato de
// backend/src/services/README.md. Datos inventados.
const { test, describe } = require("node:test");
const assert = require("node:assert/strict");

const { detectChanges, changeKey } = require("../../src/services/gradeChangeService");

// Repo en memoria. snapshots: [{ id, userId, items }] en orden cronológico.
function memoryRepo(snapshots) {
  const gradeChanges = [];
  return {
    gradeChanges,
    async getPreviousSnapshotItems(userId, currentSnapshotId) {
      const propios = snapshots.filter((s) => s.userId === userId);
      const i = propios.findIndex((s) => s.id === currentSnapshotId);
      if (i <= 0) return null;
      const prev = propios[i - 1];
      return { snapshotId: prev.id, items: prev.items.map((it) => ({ ...it })) };
    },
    async getSnapshotItems(snapshotId) {
      const s = snapshots.find((x) => x.id === snapshotId);
      return s ? s.items.map((it) => ({ ...it })) : [];
    },
    // Inserta ignorando las filas que ya existen con la misma llave natural.
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

const item = (externalItemId, value, label = "Tarea 1") => ({
  subjectId: "subj-a",
  externalItemId,
  label,
  value,
  text: value === null ? "-" : value.toFixed(2),
});

describe("detectChanges", () => {
  test("primera corrida: línea base, no escribe nada", async () => {
    const repo = memoryRepo([{ id: "snap-1", userId: "u1", items: [item("9001", 85)] }]);
    const result = await detectChanges({ userId: "u1", currentSnapshotId: "snap-1" }, repo);

    assert.deepEqual(result, { baseline: true, reason: "primera_corrida", changes: [], inserted: [] });
    assert.equal(repo.gradeChanges.length, 0);
  });

  test("escribe filas de grade_changes con ids de ambos snapshots", async () => {
    const repo = memoryRepo([
      { id: "snap-1", userId: "u1", items: [item("9001", 85), item("9002", 70)] },
      { id: "snap-2", userId: "u1", items: [item("9001", 85), item("9002", 75)] },
    ]);
    const result = await detectChanges({ userId: "u1", currentSnapshotId: "snap-2" }, repo);

    assert.equal(result.baseline, false);
    assert.equal(result.inserted.length, 2);
    assert.deepEqual(repo.gradeChanges[0], {
      id: "gc-1",
      user_id: "u1",
      subject_id: "subj-a",
      previous_snapshot_id: "snap-1",
      current_snapshot_id: "snap-2",
      external_item_id: "9002",
      field_name: "grade_value",
      previous_value: "70",
      current_value: "75",
      change_type: "updated",
    });
  });

  test("ítems con el mismo nombre: solo cambia el que cambió", async () => {
    const repo = memoryRepo([
      { id: "snap-1", userId: "u1", items: [item("9001", 85), item("9002", 70)] },
      { id: "snap-2", userId: "u1", items: [item("9001", 90), item("9002", 70)] },
    ]);
    await detectChanges({ userId: "u1", currentSnapshotId: "snap-2" }, repo);

    assert.ok(repo.gradeChanges.length > 0);
    assert.ok(repo.gradeChanges.every((r) => r.external_item_id === "9001"));
  });

  test("ítem nuevo y eliminado", async () => {
    const repo = memoryRepo([
      { id: "snap-1", userId: "u1", items: [item("9001", 85)] },
      { id: "snap-2", userId: "u1", items: [item("9010", 100, "Proyecto")] },
    ]);
    await detectChanges({ userId: "u1", currentSnapshotId: "snap-2" }, repo);
    const tipos = new Set(repo.gradeChanges.map((r) => `${r.external_item_id}:${r.change_type}`));

    assert.deepEqual([...tipos].sort(), ["9001:deleted", "9010:created"]);
  });

  test("sin cambios no llama a insertGradeChanges", async () => {
    const repo = memoryRepo([
      { id: "snap-1", userId: "u1", items: [item("9001", 85)] },
      { id: "snap-2", userId: "u1", items: [item("9001", 85)] },
    ]);
    let llamadas = 0;
    const insert = repo.insertGradeChanges;
    repo.insertGradeChanges = async (rows) => (llamadas++, insert(rows));

    const result = await detectChanges({ userId: "u1", currentSnapshotId: "snap-2" }, repo);
    assert.deepEqual(result, { baseline: false, reason: null, changes: [], inserted: [] });
    assert.equal(llamadas, 0);
  });

  test("idempotente: dos corridas sobre el mismo par no duplican", async () => {
    const repo = memoryRepo([
      { id: "snap-1", userId: "u1", items: [item("9001", 85), item("9002", 70)] },
      { id: "snap-2", userId: "u1", items: [item("9001", 90), item("9003", 50)] },
    ]);
    const args = { userId: "u1", currentSnapshotId: "snap-2" };

    const primera = await detectChanges(args, repo);
    const total = repo.gradeChanges.length;
    const segunda = await detectChanges(args, repo);

    assert.ok(total > 0);
    assert.equal(repo.gradeChanges.length, total);
    assert.equal(primera.inserted.length, total);
    assert.deepEqual(segunda.inserted, [], "la segunda corrida no inserta ni notifica");
    assert.deepEqual(segunda.changes, primera.changes, "el diff es determinista");
  });

  test("snapshot anterior con ítems legacy: línea base", async () => {
    const repo = memoryRepo([
      { id: "snap-1", userId: "u1", items: [item("legacy:abc", 85)] },
      { id: "snap-2", userId: "u1", items: [item("9001", 85)] },
    ]);
    const result = await detectChanges({ userId: "u1", currentSnapshotId: "snap-2" }, repo);

    assert.equal(result.baseline, true);
    assert.equal(result.reason, "snapshot_legacy");
    assert.equal(repo.gradeChanges.length, 0);
  });

  test("rechaza un repo incompleto", async () => {
    await assert.rejects(
      detectChanges({ userId: "u1", currentSnapshotId: "s" }, { getSnapshotItems() {} }),
      /faltan: getPreviousSnapshotItems, insertGradeChanges/,
    );
  });
});
