// ITN-55 - Avisos de calificación final (source = itson_api) desde
// POST /internal/grade-snapshots, con el Supabase simulado. Datos inventados.
const { test, describe } = require("node:test");
const assert = require("node:assert/strict");
const request = require("supertest");

const { createApp } = require("../../src/app");
const { createLogger } = require("../../src/utils/logger");
const { logChannel } = require("../../src/services/notificationChannels");
const { buildItsonApiMessage, FINAL_GRADE_SUBJECT, SUBJECT } = require("../../src/services/notificationService");
const { toNotif } = require("../../src/services/studentNotifications");
const { createFakeSupabase } = require("../helpers/fakeSupabase");
const { API_KEY, CREDENTIALS_KEY, MATERIA_API_A, payload, payloadItsonApi } = require("../helpers/payloads");

const RUTA = "/internal/grade-snapshots";
const T0 = Date.parse("2026-10-21T14:00:00Z");
const hora = (n) => new Date(T0 + n * 60 * 60 * 1000).toISOString();

function setup() {
  const db = createFakeSupabase();
  const enviados = [];
  const logs = [];
  const logger = createLogger((line) => logs.push(line));
  const email = { name: "email", async send(message) { enviados.push(message); } };
  const app = createApp({
    config: { internalApiKey: API_KEY, credentialsEncryptionKey: CREDENTIALS_KEY },
    supabase: db.client,
    logger,
    channels: [logChannel(logger), email],
  });
  const enviar = (body) => request(app).post(RUTA).set("x-api-key", API_KEY).send(body);
  return { db, enviados, logs, enviar };
}

// Dos corridas del mismo semestre; devuelve la respuesta de la segunda.
async function dosCorridas(enviar, antes, despues) {
  await enviar(payloadItsonApi({ capturedAt: hora(0), ...antes }));
  return enviar(payloadItsonApi({ capturedAt: hora(1), ...despues }));
}

describe("cuándo se avisa en itson_api", () => {
  test("de sin calificación ('-') a un número: avisa 'Calificación final: 9'", async () => {
    const { db, enviados, enviar } = setup();
    const res = await dosCorridas(enviar, { codigoA: "-" }, { codigoA: "9" });
    assert.equal(res.body.notified, 2); // log + email
    assert.equal(enviados.length, 1);
    assert.equal(enviados[0].subject, FINAL_GRADE_SUBJECT);
    assert.equal(enviados[0].text, `Calificación final: 9 en ${MATERIA_API_A}.`);
    assert.ok(db.tables.notifications_log.every((f) => f.payload.source === "itson_api"));
  });

  test("'A' se avisa como acreditada", async () => {
    const { enviados, enviar } = setup();
    await dosCorridas(enviar, { codigoA: "-" }, { codigoA: "A" });
    assert.equal(enviados[0].text, `Calificación final: acreditada en ${MATERIA_API_A}.`);
  });

  test("de un valor a otro también avisa, con 10 de dos caracteres", async () => {
    const { enviados, enviar } = setup();
    await dosCorridas(enviar, { codigoA: "9" }, { codigoA: "10" });
    assert.equal(enviados.length, 1);
    assert.match(enviados[0].text, /^Calificación final: 10 /);
  });

  test("de un valor a sin calificación no avisa", async () => {
    const { db, enviados, enviar } = setup();
    const res = await dosCorridas(enviar, { codigoA: "9" }, { codigoA: "-" });
    assert.equal(res.body.changes_inserted, 1);
    assert.equal(enviados.length, 0);
    assert.equal(db.tables.notifications_log.length, 0);
  });

  test("materia nueva con o sin nota y materia que desaparece: no avisa", async () => {
    const { db, enviados, enviar } = setup();
    const antes = payloadItsonApi({ capturedAt: hora(0), codigoA: "8" });
    antes.courses = antes.courses.slice(0, 1); // solo 4601
    await enviar(antes);
    const despues = payloadItsonApi({ capturedAt: hora(1), codigoB: "9" });
    despues.courses = despues.courses.slice(1); // 4601 desaparece, 4602 aparece con nota
    const res = await enviar(despues);
    assert.ok(res.body.changes_inserted > 0);
    assert.equal(enviados.length, 0);
    assert.equal(db.tables.notifications_log.length, 0);
  });

  test("primer snapshot (baseline) no avisa aunque traiga notas", async () => {
    const { enviados, enviar } = setup();
    const res = await enviar(payloadItsonApi({ capturedAt: hora(0), codigoA: "9", codigoB: "A" }));
    assert.equal(res.body.baseline, true);
    assert.equal(enviados.length, 0);
  });

  test("iVirtual conserva su asunto y no guarda source en el payload", async () => {
    const { db, enviados, enviar } = setup();
    await enviar(payload({ capturedAt: hora(0), tarea2: 70 }));
    await enviar(payload({ capturedAt: hora(1), tarea2: 80 }));
    assert.equal(enviados[0].subject, SUBJECT);
    assert.ok(db.tables.notifications_log.every((f) => !("source" in f.payload)));
  });
});

describe("buildItsonApiMessage", () => {
  const fila = (cambio) => ({ field_name: "grade_text", ...cambio });
  test("sin materia usa solo el código", () => {
    const m = buildItsonApiMessage([fila({ change_type: "updated", previous_value: null, current_value: "7" })]);
    assert.deepEqual(m, { subject: FINAL_GRADE_SUBJECT, text: "Calificación final: 7." });
  });
  test("solo cambio de nombre: null", () => {
    assert.equal(buildItsonApiMessage([{ field_name: "grade_label", change_type: "updated", previous_value: "a", current_value: "b" }]), null);
  });
});

describe("título en /api/notifications", () => {
  const notif = (previo, actual, source = "itson_api") =>
    toNotif(
      { id: "n1", created_at: hora(1), read_at: null, payload: { text: "x", grade_change_ids: ["c1"], ...(source ? { source } : {}) } },
      new Map([["c1", { id: "c1", subject_id: "s1", field_name: "grade_text", change_type: "updated", previous_value: previo, current_value: actual }]]),
      new Map([["s1", MATERIA_API_A]]),
    );

  test("itson_api: 'Calificación final' y 'acreditada' en la fila", () => {
    const n = notif(null, "A");
    assert.equal(n.title, "Calificación final");
    assert.deepEqual(n.rows, [{ label: "Materia", value: MATERIA_API_A }, { label: "Calificación", value: "acreditada" }]);
  });

  test("itson_api con valor previo: 'Calificación final actualizada'", () => {
    assert.equal(notif("8", "9").title, "Calificación final actualizada");
  });

  test("sin source sigue el título de iVirtual", () => {
    assert.equal(notif("8", "9", null).title, "Calificación actualizada");
  });
});
