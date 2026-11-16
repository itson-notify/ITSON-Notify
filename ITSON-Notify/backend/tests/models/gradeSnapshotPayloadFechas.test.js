// ITN-56 - Fechas de entrega en el contrato de POST /internal/grade-snapshots.
// Omitida = desconocida (se copia del snapshot anterior); null = sin fecha.
const { test, describe } = require("node:test");
const assert = require("node:assert/strict");

const { parseGradeSnapshotPayload } = require("../../src/models/gradeSnapshotPayload");
const { payload, payloadItsonApi } = require("../helpers/payloads");

const primerItem = (r) => r.data.courses[0].items[0];

describe("fechas de la tarea en el payload", () => {
  test("una fecha omitida queda ausente y null queda null", () => {
    const body = payload();
    body.courses[0].items[0].dueAt = "2026-11-21T06:59:00Z";
    body.courses[0].items[0].opensAt = null;
    const r = parseGradeSnapshotPayload(body);

    assert.equal(r.success, true);
    const it = primerItem(r);
    assert.equal(it.dueAt, "2026-11-21T06:59:00Z");
    assert.equal(it.opensAt, null);
    assert.ok("opensAt" in it, "null explícito: sin fecha");
    assert.ok(!("closesAt" in it), "omitida: desconocida");
  });

  test("sin campos de fecha el contrato de antes sigue valiendo", () => {
    const r = parseGradeSnapshotPayload(payload());
    assert.equal(r.success, true);
    assert.ok(!("dueAt" in primerItem(r)));
  });

  for (const valor of ["mañana", "2026-11-21", 1795244340, "2026-11-21T06:59:00"]) {
    test(`rechaza una fecha que no es ISO 8601 con zona: ${JSON.stringify(valor)}`, () => {
      const body = payload();
      body.courses[0].items[0].dueAt = valor;
      const r = parseGradeSnapshotPayload(body);
      assert.equal(r.success, false);
      assert.equal(r.issues[0].path, "courses.0.items.0.dueAt");
      assert.ok(!JSON.stringify(r.issues).includes(String(valor)), "el error no repite el valor");
    });
  }

  test("itson_api descarta las fechas", () => {
    const body = payloadItsonApi();
    body.courses[0].items[0].dueAt = "2026-11-21T06:59:00Z";
    const r = parseGradeSnapshotPayload(body);
    assert.equal(r.success, true);
    assert.ok(!("dueAt" in primerItem(r)));
  });
});
