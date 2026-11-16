// ITN-55 - POST /internal/grade-snapshots con source = itson_api: validación,
// period por semestre y comparación separada de iVirtual. Datos inventados.
const { test, describe } = require("node:test");
const assert = require("node:assert/strict");
const request = require("supertest");

const { createApp } = require("../../src/app");
const { createLogger } = require("../../src/utils/logger");
const { createFakeSupabase } = require("../helpers/fakeSupabase");
const { API_KEY, CREDENTIALS_KEY, MATERIA_API_A, payload, payloadItsonApi } = require("../helpers/payloads");

const RUTA = "/internal/grade-snapshots";

function setup() {
  const db = createFakeSupabase();
  const logs = [];
  const app = createApp({
    config: { internalApiKey: API_KEY, credentialsEncryptionKey: CREDENTIALS_KEY },
    supabase: db.client,
    logger: createLogger((line) => logs.push(line)),
  });
  const enviar = (body) => request(app).post(RUTA).set("x-api-key", API_KEY).send(body);
  return { db, logs, enviar };
}

// Horas sucesivas en el pasado, para que captured_at ordene las corridas.
const hora = (n) => new Date(Date.UTC(2026, 10, 1, n)).toISOString();

describe("validación de itson_api", () => {
  const casos = {
    sin_period: (b) => delete b.period,
    period_de_un_digito: (b) => (b.period = "7"),
    dos_items: (b) => b.courses[0].items.push({ externalItemId: "x", label: null, value: null, text: "-" }),
    item_con_otro_id: (b) => (b.courses[0].items[0].externalItemId = "9999"),
    con_valor_numerico: (b) => (b.courses[0].items[0].value = 9),
    codigo_no_valido: (b) => (b.courses[0].items[0].text = "nueve"),
  };
  for (const [nombre, mutar] of Object.entries(casos)) {
    test(`400 ${nombre}, sin escribir`, async () => {
      const { enviar, db } = setup();
      const body = payloadItsonApi();
      mutar(body);
      const res = await enviar(body);
      assert.equal(res.status, 400);
      assert.equal(res.body.error, "cuerpo_invalido");
      assert.ok(!JSON.stringify(res.body).includes("nueve"));
      assert.equal(db.tables.grade_snapshots.length, 0);
    });
  }

  test("400 si iVirtual trae period", async () => {
    const { enviar, db } = setup();
    const body = payload();
    body.period = "07";
    const res = await enviar(body);
    assert.equal(res.status, 400);
    assert.deepEqual(res.body.detalles, [{ path: "period", code: "custom", message: "solo itson_api" }]);
    assert.equal(db.tables.grade_snapshots.length, 0);
  });
});

describe("persistencia de itson_api", () => {
  test("guarda period en el snapshot y en subjects, y '-' como null", async () => {
    const { enviar, db } = setup();
    const res = await enviar(payloadItsonApi({ codigoA: "-", codigoB: "A" }));
    assert.equal(res.status, 200);
    assert.equal(res.body.baseline, true);

    const [snap] = db.tables.grade_snapshots;
    assert.equal(snap.source, "itson_api");
    assert.equal(snap.period, "07");
    assert.ok(db.tables.subjects.every((s) => s.period === "07"));
    const textos = db.tables.snapshot_grades.map((g) => [g.external_item_id, g.grade_text, g.grade_value]);
    assert.deepEqual(textos.sort(), [["4601", null, null], ["4602", "A", null]]);
  });

  test("iVirtual no escribe grade_snapshots.period y deja subjects.period en null", async () => {
    const { enviar, db } = setup();
    assert.equal((await enviar(payload())).status, 200);
    assert.ok(!("period" in db.tables.grade_snapshots[0]));
    assert.ok(db.tables.subjects.every((s) => s.period === null));
  });

  test("sin la migración 012 (no existe grade_snapshots.period), iVirtual sigue funcionando", async () => {
    const { enviar, db } = setup();
    db.withoutColumn("grade_snapshots", "period");
    const r1 = await enviar(payload({ capturedAt: hora(1), tarea2: 70 }));
    const r2 = await enviar(payload({ capturedAt: hora(2), tarea2: 80 }));
    assert.equal(r1.status, 200);
    assert.equal(r2.status, 200);
    assert.equal(r2.body.baseline, false);
    assert.equal(r2.body.changes_inserted, 2); // grade_value y grade_text de 9002
  });

  test("sin la migración 012, itson_api sí falla (500) y no deja snapshot", async () => {
    const { enviar, db } = setup();
    db.withoutColumn("grade_snapshots", "period");
    const res = await enviar(payloadItsonApi());
    assert.equal(res.status, 500);
    assert.deepEqual(res.body, { error: "error_interno" });
    assert.equal(db.tables.grade_snapshots.length, 0);
  });
});

describe("comparación por fuente y por semestre", () => {
  test("regresión: gradeValue 'A' se conserva literal y no se interpreta", async () => {
    const { enviar, db } = setup();
    await enviar(payloadItsonApi({ capturedAt: hora(1), codigoA: "-" }));
    const res = await enviar(payloadItsonApi({ capturedAt: hora(2), codigoA: "A" }));
    assert.equal(res.status, 200);
    assert.equal(res.body.changes_inserted, 1);
    // En el snapshot: texto "A", sin número.
    const conA = db.tables.snapshot_grades.filter((g) => g.grade_text === "A");
    assert.equal(conA.length, 1);
    assert.equal(conA[0].grade_value, null);
    // En grade_changes: de null a "A", literal.
    const [cambio] = db.tables.grade_changes;
    assert.deepEqual([cambio.field_name, cambio.change_type, cambio.previous_value, cambio.current_value], ["grade_text", "updated", null, "A"]);
    assert.ok(!JSON.stringify(db.tables).match(/acreditad/i));
  });

  test("itsonGradeCodes: 'A' no se traduce; '-' sigue siendo null", () => {
    const { normalizarCodigo, describirCodigo } = require("../../src/services/itsonGradeCodes");
    assert.equal(normalizarCodigo(" A "), "A");
    assert.equal(describirCodigo("A"), "A");
    assert.equal(describirCodigo("9"), "9");
    assert.equal(normalizarCodigo("-"), null);
    assert.equal(describirCodigo(null), "sin calificación");
  });

  test("el primer snapshot de cada semestre es baseline; el segundo del mismo semestre compara", async () => {
    const { enviar } = setup();
    const r1 = await enviar(payloadItsonApi({ period: "07", capturedAt: hora(1) }));
    const r2 = await enviar(payloadItsonApi({ period: "08", capturedAt: hora(2) }));
    const r3 = await enviar(payloadItsonApi({ period: "07", capturedAt: hora(3), codigoA: "9" }));
    assert.equal(r1.body.baseline, true);
    assert.equal(r2.body.baseline, true); // no se compara contra el 07
    assert.equal(r3.body.baseline, false);
    assert.equal(r3.body.changes_inserted, 1); // solo 4601: null -> "9"
  });

  test("iVirtual e itson_api intercalados no generan cambios cruzados", async () => {
    const { enviar, db } = setup();
    await enviar(payload({ capturedAt: hora(1) }));
    const api1 = await enviar(payloadItsonApi({ capturedAt: hora(2) }));
    const iv2 = await enviar(payload({ capturedAt: hora(3) }));
    const api2 = await enviar(payloadItsonApi({ capturedAt: hora(4) }));
    assert.equal(api1.body.baseline, true);
    assert.equal(iv2.body.baseline, false);
    assert.equal(iv2.body.changes_detected, 0);
    assert.equal(api2.body.baseline, false);
    assert.equal(api2.body.changes_detected, 0);
    assert.equal(db.tables.grade_changes.length, 0);
  });

  test("el nombre de la materia no aparece en los logs", async () => {
    const { enviar, logs } = setup();
    await enviar(payloadItsonApi({ capturedAt: hora(1) }));
    await enviar(payloadItsonApi({ capturedAt: hora(2), codigoA: "10" }));
    assert.ok(!logs.join("\n").includes(MATERIA_API_A));
  });
});
