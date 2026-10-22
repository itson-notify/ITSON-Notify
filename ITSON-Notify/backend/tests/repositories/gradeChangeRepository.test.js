// Pruebas del repo de Supabase de detectChanges (contrato en
// backend/src/services/README.md) con un Supabase simulado. Datos inventados.
const { test, describe } = require("node:test");
const assert = require("node:assert/strict");

const { createGradeChangeRepository } = require("../../src/repositories/gradeChangeRepository");
const { createFakeSupabase } = require("../helpers/fakeSupabase");

const U1 = "00000000-0000-4000-8000-000000000001";
const U2 = "00000000-0000-4000-8000-000000000002";
const id = (n) => `10000000-0000-4000-8000-${String(n).padStart(12, "0")}`;

function seed() {
  const db = createFakeSupabase();
  const snap = (n, userId, capturedAt, source = "ivirtual") => ({
    id: id(n), user_id: userId, source, captured_at: new Date(capturedAt).toISOString(), raw_payload: null,
  });
  db.tables.grade_snapshots.push(
    snap(1, U1, "2026-10-21T14:00:00Z"),
    snap(2, U1, "2026-10-21T16:00:00Z"),
    snap(3, U1, "2026-10-21T16:00:00Z"), // empate con 2
    snap(4, U1, "2026-10-21T15:00:00Z", "classroom"),
    snap(5, U2, "2026-10-21T15:30:00Z"),
  );
  db.tables.snapshot_grades.push(
    { id: id(101), snapshot_id: id(1), subject_id: "s-a", external_item_id: "9001", grade_label: "Tarea 1", grade_value: 85.5, grade_text: "85.50", partial_period: null, raw_payload: null },
    { id: id(102), snapshot_id: id(1), subject_id: "s-a", external_item_id: "9006", grade_label: null, grade_value: null, grade_text: "-", partial_period: null, raw_payload: null },
  );
  return { db, repo: createGradeChangeRepository(db.client) };
}

describe("getPreviousSnapshotItems", () => {
  test("primer snapshot del usuario: null", async () => {
    const { repo } = seed();
    assert.equal(await repo.getPreviousSnapshotItems(U1, id(1)), null);
    assert.equal(await repo.getPreviousSnapshotItems(U2, id(5)), null);
  });

  test("el anterior por captured_at, ignorando otra source y otro usuario", async () => {
    const { repo } = seed();
    const prev = await repo.getPreviousSnapshotItems(U1, id(2));
    assert.equal(prev.snapshotId, id(1)); // no el 4 (classroom) ni el 5 (otro usuario)
    assert.equal(prev.items.length, 2);
  });

  test("empate de captured_at: desempata por id y nunca devuelve el mismo", async () => {
    const { repo } = seed();
    assert.equal((await repo.getPreviousSnapshotItems(U1, id(3))).snapshotId, id(2));
    assert.equal((await repo.getPreviousSnapshotItems(U1, id(2))).snapshotId, id(1));
  });

  test("lanza si el snapshot actual es de otro usuario", async () => {
    const { repo } = seed();
    await assert.rejects(repo.getPreviousSnapshotItems(U2, id(1)));
  });
});

describe("getSnapshotItems", () => {
  test("mapea las columnas al formato del diff", async () => {
    const { repo } = seed();
    const items = await repo.getSnapshotItems(id(1));
    assert.deepEqual(items, [
      { subjectId: "s-a", externalItemId: "9001", label: "Tarea 1", value: 85.5, text: "85.50" },
      { subjectId: "s-a", externalItemId: "9006", label: null, value: null, text: "-" },
    ]);
  });

  test("pagina más allá de 1000 filas", async () => {
    const { db, repo } = seed();
    for (let i = 0; i < 1500; i++) {
      db.tables.snapshot_grades.push({
        id: id(10000 + i), snapshot_id: id(2), subject_id: "s-a", external_item_id: String(i),
        grade_label: null, grade_value: i % 100, grade_text: null, partial_period: null, raw_payload: null,
      });
    }
    assert.equal((await repo.getSnapshotItems(id(2))).length, 1500);
  });
});

describe("insertGradeChanges", () => {
  const row = (field) => ({
    user_id: U1, subject_id: "s-a", previous_snapshot_id: id(1), current_snapshot_id: id(2),
    external_item_id: "9001", field_name: field, previous_value: "85.5", current_value: "90", change_type: "updated",
  });

  test("devuelve solo las filas insertadas e ignora duplicados de la llave natural", async () => {
    const { db, repo } = seed();
    const primera = await repo.insertGradeChanges([row("grade_value")]);
    assert.equal(primera.length, 1);
    assert.ok(primera[0].id);

    const segunda = await repo.insertGradeChanges([row("grade_value"), row("grade_text")]);
    assert.deepEqual(segunda.map((r) => r.field_name), ["grade_text"]);
    assert.equal(db.tables.grade_changes.length, 2);
  });

  test("sin filas no llama a Supabase", async () => {
    const { db, repo } = seed();
    assert.deepEqual(await repo.insertGradeChanges([]), []);
    assert.equal(db.calls.length, 0);
  });
});
