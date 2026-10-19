// Pruebas del diff puro. Datos inventados.
const { test, describe } = require("node:test");
const assert = require("node:assert/strict");

const { diffSnapshots } = require("../../src/services/gradeDiff");

const item = (externalItemId, value, extra = {}) => ({
  subjectId: "subj-a",
  externalItemId,
  label: "Tarea 1",
  value,
  text: value === null ? "-" : String(value),
  ...extra,
});

describe("diffSnapshots", () => {
  test("primera corrida: línea base sin 'created' masivos", () => {
    const result = diffSnapshots(null, [item("9001", 85), item("9002", 70)]);
    assert.deepEqual(result, { baseline: true, changes: [] });
  });

  test("sin cambios no genera registros", () => {
    const items = [item("9001", 85), item("9002", null)];
    assert.deepEqual(diffSnapshots(items, items.map((i) => ({ ...i }))), {
      baseline: false,
      changes: [],
    });
  });

  test("ítems con el mismo nombre se distinguen por id", () => {
    const prev = [item("9001", 85), item("9002", 70)];
    const curr = [item("9001", 85), item("9002", 75)];
    const { changes } = diffSnapshots(prev, curr);

    assert.deepEqual(
      changes.map((c) => [c.externalItemId, c.fieldName, c.previousValue, c.currentValue]),
      [
        ["9002", "grade_value", "70", "75"],
        ["9002", "grade_text", "70", "75"],
      ],
    );
  });

  test("cambio de valor: un registro por campo, valores como texto", () => {
    const prev = [item("9001", 85.5, { text: "85.50" })];
    const curr = [item("9001", 90, { text: "90.00", label: "Tarea 1 (final)" })];
    const { changes } = diffSnapshots(prev, curr);

    assert.deepEqual(changes, [
      { changeType: "updated", fieldName: "grade_value", previousValue: "85.5", currentValue: "90", externalItemId: "9001", subjectId: "subj-a" },
      { changeType: "updated", fieldName: "grade_text", previousValue: "85.50", currentValue: "90.00", externalItemId: "9001", subjectId: "subj-a" },
      { changeType: "updated", fieldName: "grade_label", previousValue: "Tarea 1", currentValue: "Tarea 1 (final)", externalItemId: "9001", subjectId: "subj-a" },
    ]);
  });

  test("tolerancia a 2 decimales (y numeric que llega como texto)", () => {
    const prev = [item("9001", "85.50", { text: "85.50" })];
    const curr = [item("9001", 85.501, { text: "85.50" })];
    assert.deepEqual(diffSnapshots(prev, curr).changes, []);

    const curr2 = [item("9001", 85.51, { text: "85.50" })];
    assert.equal(diffSnapshots(prev, curr2).changes.length, 1);
  });

  test("null -> valor es 'updated' del campo, no 'created' del ítem", () => {
    const prev = [item("9003", null)];
    const curr = [item("9003", 9, { text: "9.00" })];
    const { changes } = diffSnapshots(prev, curr);

    assert.ok(changes.every((c) => c.changeType === "updated"));
    assert.deepEqual(changes[0], {
      changeType: "updated", fieldName: "grade_value", previousValue: null, currentValue: "9", externalItemId: "9003", subjectId: "subj-a",
    });
  });

  test("ítem nuevo: 'created' por cada campo con valor", () => {
    const prev = [item("9001", 85)];
    const curr = [item("9001", 85), item("9010", 100, { label: "Proyecto", text: "100.00" })];
    const { changes } = diffSnapshots(prev, curr);

    assert.deepEqual(
      changes.map((c) => [c.changeType, c.externalItemId, c.fieldName, c.previousValue, c.currentValue]),
      [
        ["created", "9010", "grade_value", null, "100"],
        ["created", "9010", "grade_text", null, "100.00"],
        ["created", "9010", "grade_label", null, "Proyecto"],
      ],
    );
  });

  test("ítem nuevo sin ningún valor deja un solo registro", () => {
    const { changes } = diffSnapshots([], [item("9011", null, { text: null, label: null })]);
    assert.deepEqual(changes, [
      { changeType: "created", fieldName: "grade_value", previousValue: null, currentValue: null, externalItemId: "9011", subjectId: "subj-a" },
    ]);
  });

  test("ítem ausente en el actual es 'deleted'", () => {
    const prev = [item("9001", 85), item("9002", 70)];
    const curr = [item("9001", 85)];
    const { changes } = diffSnapshots(prev, curr);

    assert.ok(changes.length > 0);
    assert.ok(changes.every((c) => c.changeType === "deleted" && c.externalItemId === "9002"));
    assert.equal(changes[0].previousValue, "70");
    assert.equal(changes[0].currentValue, null);
  });

  test("el mismo id en otra materia es otro ítem", () => {
    const prev = [item("9001", 85, { subjectId: "subj-a" })];
    const curr = [item("9001", 85, { subjectId: "subj-b" })];
    const types = diffSnapshots(prev, curr).changes.map((c) => `${c.subjectId}:${c.changeType}`);

    assert.ok(types.includes("subj-a:deleted"));
    assert.ok(types.includes("subj-b:created"));
  });

  test("rechaza ítems sin id o duplicados", () => {
    assert.throws(() => diffSnapshots([], [item(null, 1)]), /sin externalItemId/);
    assert.throws(() => diffSnapshots([], [item("1", 1), item("1", 2)]), /duplicado/);
  });
});
