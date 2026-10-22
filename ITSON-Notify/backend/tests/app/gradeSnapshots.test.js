// Pruebas de POST /internal/grade-snapshots con supertest y un Supabase
// simulado (tests/helpers/fakeSupabase.js). Datos inventados.
const { test, describe } = require("node:test");
const assert = require("node:assert/strict");
const request = require("supertest");

const { createApp } = require("../../src/app");
const { createLogger } = require("../../src/utils/logger");
const { createFakeSupabase } = require("../helpers/fakeSupabase");
const { API_KEY, OTRA_API_KEY, EMAIL, OTRO_EMAIL, payload, SENSIBLES } = require("../helpers/payloads");

const RUTA = "/internal/grade-snapshots";

function setup({ now } = {}) {
  const db = createFakeSupabase();
  const logs = [];
  const app = createApp({
    config: { internalApiKey: API_KEY },
    supabase: db.client,
    logger: createLogger((line) => logs.push(line)),
    ...(now ? { now } : {}),
  });
  const enviar = (body, key = API_KEY) => request(app).post(RUTA).set("x-api-key", key).send(body);
  return { db, logs, app, enviar };
}

const minutos = (n) => n * 60 * 1000;

function assertSinDatosSensibles(texto) {
  for (const s of SENSIBLES) {
    assert.ok(!texto.includes(s), `apareció un dato sensible: ${s.slice(0, 6)}...`);
  }
}

describe("autenticación", () => {
  test("GET /health responde sin llave y sin configuración", async () => {
    const { app } = setup();
    const res = await request(app).get("/health");
    assert.equal(res.status, 200);
    assert.deepEqual(res.body, { status: "ok" });
    assert.equal(res.headers["x-powered-by"], undefined);
  });

  test("401 sin x-api-key, sin tocar la base", async () => {
    const { app, db } = setup();
    const res = await request(app).post(RUTA).send(payload());
    assert.equal(res.status, 401);
    assert.deepEqual(res.body, { error: "no_autorizado" });
    assert.equal(db.calls.length, 0);
  });

  test("401 con llave incorrecta del mismo largo o de otro largo", async () => {
    const { enviar, db } = setup();
    for (const key of [OTRA_API_KEY, "corta", `${API_KEY}x`]) {
      const res = await enviar(payload(), key);
      assert.equal(res.status, 401);
      assert.deepEqual(res.body, { error: "no_autorizado" });
    }
    assert.equal(db.calls.length, 0);
  });
});

describe("validación del body", () => {
  test("400 con JSON mal formado", async () => {
    const { app } = setup();
    const res = await request(app)
      .post(RUTA)
      .set("x-api-key", API_KEY)
      .set("Content-Type", "application/json")
      .send('{"run_id": ');
    assert.equal(res.status, 400);
    assert.deepEqual(res.body, { error: "cuerpo_invalido" });
  });

  test("400 sin external_item_id en un ítem", async () => {
    const { enviar, db } = setup();
    const body = payload();
    delete body.courses[0].items[1].externalItemId;
    const res = await enviar(body);
    assert.equal(res.status, 400);
    assert.equal(res.body.error, "cuerpo_invalido");
    assert.ok(res.body.detalles.some((d) => d.path === "courses.0.items.1.externalItemId"));
    assert.equal(db.calls.length, 0);
  });

  test("400 con cuerpos inválidos, sin devolver valores recibidos", async () => {
    const casos = {
      sin_run_id: (b) => delete b.run_id,
      run_id_no_uuid: (b) => (b.run_id = "corrida-1"),
      sin_email: (b) => (b.user = {}),
      email_invalido: (b) => (b.user.email = "no-es-correo"),
      courses_vacio: (b) => (b.courses = []),
      captured_at_sin_zona: (b) => (b.captured_at = "2026-10-21T10:00:00"),
      fuera_de_numeric_5_2: (b) => (b.courses[0].items[0].value = 1000),
      prefijo_legacy: (b) => (b.courses[0].items[0].externalItemId = "legacy:abc"),
      item_duplicado: (b) => (b.courses[0].items[1].externalItemId = "9001"),
      curso_duplicado: (b) => (b.courses[1].externalId = "501"),
      source_desconocida: (b) => (b.source = "classroom"),
    };
    const { enviar } = setup();
    for (const [nombre, romper] of Object.entries(casos)) {
      const body = payload();
      romper(body);
      const res = await enviar(body);
      assert.equal(res.status, 400, nombre);
      assert.equal(res.body.error, "cuerpo_invalido", nombre);
      assertSinDatosSensibles(JSON.stringify(res.body));
    }
  });

  test("acepta label null (total del curso) y text \"-\"", async () => {
    const { enviar, db } = setup();
    const res = await enviar(payload());
    assert.equal(res.status, 200);
    const total = db.tables.snapshot_grades.find((g) => g.external_item_id === "9006");
    assert.equal(total.grade_label, null);
    const examen = db.tables.snapshot_grades.find((g) => g.external_item_id === "9003");
    assert.equal(examen.grade_text, "-");
    assert.equal(examen.grade_value, null);
  });

  test("captured_at: 400 a más de 5 minutos en el futuro, 200 dentro del margen", async () => {
    const ahora = Date.parse("2026-10-21T17:00:00Z");
    const { enviar } = setup({ now: () => ahora });

    const futuro = await enviar(payload({ capturedAt: new Date(ahora + minutos(6)).toISOString() }));
    assert.equal(futuro.status, 400);
    assert.ok(futuro.body.detalles.some((d) => d.path === "captured_at"));

    const margen = await enviar(payload({ capturedAt: new Date(ahora + minutos(4)).toISOString() }));
    assert.equal(margen.status, 200);
  });
});

describe("persistencia y detección", () => {
  test("primera corrida: guarda todo y no genera cambios", async () => {
    const { enviar, db } = setup();
    const body = payload();
    const res = await enviar(body);

    assert.equal(res.status, 200);
    assert.deepEqual(res.body, {
      snapshot_id: body.run_id,
      snapshot_created: true,
      courses: 2,
      items: 5,
      baseline: true,
      reason: "primera_corrida",
      changes_detected: 0,
      changes_inserted: 0,
    });
    assert.equal(db.tables.app_users.length, 1);
    assert.equal(db.tables.subjects.length, 2);
    assert.equal(db.tables.grade_snapshots.length, 1);
    assert.equal(db.tables.grade_snapshots[0].id, body.run_id);
    assert.equal(db.tables.grade_snapshots[0].raw_payload, null);
    assert.equal(db.tables.snapshot_grades.length, 5);
    assert.equal(db.tables.grade_changes.length, 0);

    // Campos sin columna propia: en raw_payload, sin datos del alumno.
    const tarea = db.tables.snapshot_grades.find((g) => g.external_item_id === "9001");
    assert.deepEqual(tarea.raw_payload, {
      type: "mod", min: 0, max: 100, percentage: "85.50 %", categoryId: 70, cmid: 3001, hidden: false,
    });
    assert.ok(!JSON.stringify(db.tables.snapshot_grades).includes(EMAIL));
  });

  test("un cambio de nota produce un 'updated' y el conteo correcto", async () => {
    const { enviar, db } = setup();
    const t0 = Date.parse("2026-10-21T14:00:00Z");
    await enviar(payload({ capturedAt: new Date(t0).toISOString() }));

    const segunda = payload({ capturedAt: new Date(t0 + minutos(120)).toISOString(), tarea2: 75 });
    const res = await enviar(segunda);

    assert.equal(res.status, 200);
    assert.equal(res.body.baseline, false);
    // grade_value y grade_text cambian ("70.00" -> "75.00").
    assert.equal(res.body.changes_detected, 2);
    assert.equal(res.body.changes_inserted, 2);

    const valor = db.tables.grade_changes.find((c) => c.field_name === "grade_value");
    assert.equal(valor.change_type, "updated");
    assert.equal(valor.external_item_id, "9002");
    assert.equal(valor.previous_value, "70");
    assert.equal(valor.current_value, "75");
    assert.equal(valor.current_snapshot_id, segunda.run_id);
    assert.equal(valor.previous_snapshot_id, db.tables.grade_snapshots[0].id);
  });

  test("dos ítems con el mismo nombre se distinguen por external_item_id", async () => {
    const { enviar, db } = setup();
    const t0 = Date.parse("2026-10-21T14:00:00Z");
    await enviar(payload({ capturedAt: new Date(t0).toISOString() }));
    await enviar(payload({ capturedAt: new Date(t0 + minutos(120)).toISOString(), tarea2: 75 }));

    const tareas = db.tables.snapshot_grades.filter((g) => g.grade_label === "Tarea 1");
    assert.equal(tareas.length, 4); // 2 ítems x 2 snapshots
    assert.deepEqual([...new Set(tareas.map((g) => g.external_item_id))].sort(), ["9001", "9002"]);
    // Solo cambió 9002; 9001 (mismo nombre) no aparece en grade_changes.
    assert.deepEqual([...new Set(db.tables.grade_changes.map((c) => c.external_item_id))], ["9002"]);
  });

  test("idempotencia: el mismo payload dos veces no duplica filas ni cambios", async () => {
    const { enviar, db } = setup();
    const t0 = Date.parse("2026-10-21T14:00:00Z");
    await enviar(payload({ capturedAt: new Date(t0).toISOString() }));
    const segunda = payload({ capturedAt: new Date(t0 + minutos(120)).toISOString(), tarea2: 75 });

    const r1 = await enviar(segunda);
    const conteos = () => Object.fromEntries(Object.entries(db.tables).map(([t, rows]) => [t, rows.length]));
    const despues1 = conteos();
    const r2 = await enviar(segunda);

    assert.equal(r2.status, 200);
    assert.deepEqual(conteos(), despues1);
    assert.equal(r1.body.snapshot_created, true);
    assert.equal(r2.body.snapshot_created, false);
    assert.equal(r2.body.changes_detected, r1.body.changes_detected);
    assert.equal(r2.body.changes_inserted, 0);
  });

  test("409 si el run_id ya existe y es de otro usuario", async () => {
    const { enviar, db, logs } = setup();
    const body = payload();
    await enviar(body);
    const res = await enviar({ ...payload({ email: OTRO_EMAIL }), run_id: body.run_id });

    assert.equal(res.status, 409);
    assert.deepEqual(res.body, { error: "snapshot_de_otro_usuario" });
    assert.equal(db.tables.grade_snapshots.length, 1);
    assert.equal(db.tables.snapshot_grades.length, 5);
    assertSinDatosSensibles(logs.join("\n"));
  });
});

describe("fallas y borrado compensatorio", () => {
  test("si falla snapshot_grades en una corrida nueva, se borra el snapshot", async () => {
    const { enviar, db, logs } = setup();
    db.failNext("snapshot_grades", "upsert");
    const body = payload();
    const res = await enviar(body);

    assert.equal(res.status, 500);
    assert.deepEqual(res.body, { error: "error_interno" });
    assert.equal(db.tables.grade_snapshots.some((s) => s.id === body.run_id), false);
    assert.equal(db.tables.snapshot_grades.length, 0);
    const linea = JSON.parse(logs.find((l) => l.includes("snapshot_no_guardado")));
    assert.equal(linea.compensation, "borrado");
    assert.equal(linea.step, "snapshot_grades");
    assert.equal(linea.error_code, "XX000");

    // Reintentar el mismo run_id funciona.
    const retry = await enviar(body);
    assert.equal(retry.status, 200);
    assert.equal(retry.body.snapshot_created, true);
  });

  test("si falla snapshot_grades en un reenvío, NO se borra la corrida previa", async () => {
    const { enviar, db, logs } = setup();
    const body = payload();
    await enviar(body);
    db.failNext("snapshot_grades", "upsert");
    const res = await enviar(body);

    assert.equal(res.status, 500);
    assert.equal(db.tables.grade_snapshots.some((s) => s.id === body.run_id), true);
    assert.equal(db.tables.snapshot_grades.length, 5);
    const linea = JSON.parse(logs.find((l) => l.includes("snapshot_no_guardado")));
    assert.equal(linea.compensation, "omitida");
  });

  test("el mensaje de Supabase no llega a la respuesta ni a los logs", async () => {
    const { enviar, db, logs } = setup();
    for (const [table, op] of [
      ["app_users", "upsert"],
      ["subjects", "upsert"],
      ["grade_snapshots", "upsert"],
      ["grade_changes", "upsert"],
    ]) {
      if (table === "grade_changes") {
        await enviar(payload({ capturedAt: "2026-10-21T14:00:00Z" }));
      }
      db.failNext(table, op);
      const res = await enviar(payload({ capturedAt: table === "grade_changes" ? "2026-10-21T16:00:00Z" : undefined, tarea2: 99 }));
      assert.equal(res.status, 500, table);
      assert.deepEqual(res.body, { error: "error_interno" });
    }
    const todo = logs.join("\n");
    assert.ok(!todo.includes("fallo simulado"));
    assertSinDatosSensibles(todo);
  });
});

describe("privacidad de los logs", () => {
  test("ningún flujo registra calificaciones, materias, correos ni llaves", async () => {
    const { enviar, app, logs } = setup();
    const t0 = Date.parse("2026-10-21T14:00:00Z");
    await request(app).post(RUTA).send(payload());
    await enviar(payload(), OTRA_API_KEY);
    await enviar({ ...payload(), courses: [] });
    await enviar(payload({ capturedAt: new Date(t0).toISOString() }));
    const segunda = payload({ capturedAt: new Date(t0 + minutos(120)).toISOString(), tarea2: 75 });
    await enviar(segunda);
    await enviar(segunda);

    assert.ok(logs.length > 0);
    assertSinDatosSensibles(logs.join("\n"));
    for (const line of logs) {
      const parsed = JSON.parse(line);
      assert.ok(!("body" in parsed) && !("email" in parsed));
    }
    const guardado = JSON.parse(logs.findLast((l) => l.includes("snapshot_guardado")));
    assert.equal(guardado.snapshot_id, segunda.run_id);
    assert.equal(typeof guardado.changes_detected, "number");
  });
});
