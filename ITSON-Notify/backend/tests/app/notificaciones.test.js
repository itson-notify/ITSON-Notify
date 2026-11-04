// ITN-28 - Notificación conectada a POST /internal/grade-snapshots, con
// supertest y el Supabase simulado. Datos inventados.
const { test, describe } = require("node:test");
const assert = require("node:assert/strict");
const request = require("supertest");

const { createApp } = require("../../src/app");
const { createLogger } = require("../../src/utils/logger");
const { logChannel } = require("../../src/services/notificationChannels");
const { createFakeSupabase } = require("../helpers/fakeSupabase");
const { API_KEY, CREDENTIALS_KEY, EMAIL, MATERIA_A, payload, SENSIBLES } = require("../helpers/payloads");

const RUTA = "/internal/grade-snapshots";
const T0 = Date.parse("2026-10-21T14:00:00Z");
const hora = (n) => new Date(T0 + n * 60 * 60 * 1000).toISOString();

// Canal que guarda lo enviado; `falla.activo` lo hace lanzar.
function canal(name) {
  const falla = { activo: false };
  const enviados = [];
  return {
    falla,
    enviados,
    channel: {
      name,
      async send(message, meta) {
        // El error trae datos sensibles a propósito: no debe llegar al log.
        if (falla.activo) throw new Error(`Resend rechazó ${EMAIL} (${message.text})`);
        enviados.push({ message, meta });
      },
    },
  };
}

function setup({ extraChannels = [] } = {}) {
  const db = createFakeSupabase();
  const logs = [];
  const logger = createLogger((line) => logs.push(line));
  const app = createApp({
    config: { internalApiKey: API_KEY, credentialsEncryptionKey: CREDENTIALS_KEY },
    supabase: db.client,
    logger,
    channels: [logChannel(logger), ...extraChannels.map((c) => c.channel)],
  });
  const enviar = (body) => request(app).post(RUTA).set("x-api-key", API_KEY).send(body);
  return { db, logs, enviar };
}

describe("notificación desde POST /internal/grade-snapshots", () => {
  test("baseline (primera corrida): no envía nada", async () => {
    const email = canal("email");
    const { db, enviar } = setup({ extraChannels: [email] });

    const res = await enviar(payload({ capturedAt: hora(0) }));

    assert.equal(res.status, 200);
    assert.equal(res.body.baseline, true);
    assert.equal(res.body.notified, 0);
    assert.equal(res.body.failed, 0);
    assert.equal(email.enviados.length, 0);
    assert.equal(db.tables.notifications_log.length, 0);
  });

  test("un cambio de nota (grade_value + grade_text) sale en un solo mensaje", async () => {
    const email = canal("email");
    const { db, enviar } = setup({ extraChannels: [email] });
    await enviar(payload({ capturedAt: hora(0) }));

    const res = await enviar(payload({ capturedAt: hora(2), tarea2: 75 }));

    assert.equal(res.status, 200);
    assert.equal(res.body.changes_inserted, 2);
    assert.equal(res.body.notified, 2); // log + email, un grupo
    assert.equal(res.body.failed, 0);
    assert.equal(email.enviados.length, 1);
    assert.equal(email.enviados[0].message.text, `Tarea 1 en ${MATERIA_A}: calificación de 70 a 75.`);

    const ids = db.tables.grade_changes.map((c) => c.id).sort();
    assert.deepEqual(email.enviados[0].meta.gradeChangeIds, ids);
    assert.equal(db.tables.notifications_log.length, 2);
    for (const fila of db.tables.notifications_log) {
      assert.equal(fila.grade_change_id, ids[0]);
      assert.equal(fila.status, "sent");
      assert.deepEqual(fila.payload.grade_change_ids, ids);
    }
  });

  test("solo cambia grade_text: también se notifica", async () => {
    const email = canal("email");
    const { enviar } = setup({ extraChannels: [email] });
    await enviar(payload({ capturedAt: hora(0) }));

    const body = payload({ capturedAt: hora(2) });
    body.courses[0].items[2].text = "Pendiente"; // 9003: value null, text "-"
    const res = await enviar(body);

    assert.equal(res.body.changes_inserted, 1);
    assert.equal(email.enviados.length, 1);
    assert.equal(email.enviados[0].message.text, `Examen parcial 1 en ${MATERIA_A}: calificación de - a Pendiente.`);
  });

  test("un ítem borrado toma su nombre del snapshot anterior", async () => {
    const email = canal("email");
    const { enviar } = setup({ extraChannels: [email] });
    await enviar(payload({ capturedAt: hora(0) }));

    const body = payload({ capturedAt: hora(2) });
    body.courses[1].items.push({ ...body.courses[1].items[0], externalItemId: "9102", label: "Extra" });
    await enviar(body);
    const sinExtra = payload({ capturedAt: hora(4) });
    await enviar(sinExtra);

    assert.equal(email.enviados.at(-1).message.text, "Extra en Materia de prueba B: ya no tiene calificación (antes: 95).");
  });

  test("reenviar el mismo payload no vuelve a enviar nada", async () => {
    const email = canal("email");
    const { db, enviar } = setup({ extraChannels: [email] });
    await enviar(payload({ capturedAt: hora(0) }));
    const segunda = payload({ capturedAt: hora(2), tarea2: 75 });

    await enviar(segunda);
    const filas = JSON.stringify(db.tables.notifications_log);
    const res = await enviar(segunda);

    assert.equal(res.status, 200);
    assert.equal(res.body.notified, 0);
    assert.equal(res.body.failed, 0);
    assert.equal(email.enviados.length, 1);
    assert.equal(JSON.stringify(db.tables.notifications_log), filas);
  });

  test("un canal que falla no tumba la respuesta y se reintenta en la siguiente corrida", async () => {
    const email = canal("email");
    const { db, enviar } = setup({ extraChannels: [email] });
    await enviar(payload({ capturedAt: hora(0) }));

    email.falla.activo = true;
    const res = await enviar(payload({ capturedAt: hora(2), tarea2: 75 }));
    assert.equal(res.status, 200);
    assert.equal(res.body.changes_inserted, 2);
    assert.equal(res.body.notified, 1); // log
    assert.equal(res.body.failed, 1); // email
    const fila = db.tables.notifications_log.find((f) => f.channel === "email");
    assert.equal(fila.status, "failed");
    assert.equal(fila.attempts, 1);

    // Siguiente corrida sin cambios: reintenta el email pendiente.
    email.falla.activo = false;
    const siguiente = await enviar(payload({ capturedAt: hora(4), tarea2: 75 }));
    assert.equal(siguiente.status, 200);
    assert.equal(siguiente.body.changes_inserted, 0);
    assert.equal(siguiente.body.notified, 1);
    assert.equal(fila.status, "sent");
    assert.equal(fila.attempts, 2);
    assert.equal(email.enviados.length, 1);
    assert.equal(email.enviados[0].message.text, `Tarea 1 en ${MATERIA_A}: calificación de 70 a 75.`);
  });

  test("el reintento de pendientes también corre en baseline", async () => {
    const email = canal("email");
    const { db, enviar } = setup({ extraChannels: [email] });
    // Pendiente sembrado de una corrida anterior del mismo alumno.
    await enviar(payload({ capturedAt: hora(0) }));
    const userId = db.tables.app_users[0].id;
    db.tables.notifications_log.push({
      id: "n-previo", user_id: userId, grade_change_id: "gc-previo", channel: "email",
      payload: { subject: "s", text: "t", grade_change_ids: ["gc-previo"] },
      status: "failed", attempts: 1, error: "x", sent_at: null, created_at: hora(0),
    });
    // Sin snapshots previos, la siguiente corrida vuelve a ser primera_corrida.
    db.tables.grade_snapshots = [];
    db.tables.snapshot_grades = [];

    const res = await enviar(payload({ capturedAt: hora(2) }));
    assert.equal(res.body.baseline, true);
    assert.equal(res.body.notified, 1);
    assert.equal(email.enviados.length, 1);
  });

  test("una falla de Supabase en notifications_log no tumba la respuesta", async () => {
    const { db, enviar, logs } = setup();
    await enviar(payload({ capturedAt: hora(0) }));

    db.failNext("notifications_log", "select"); // listado de pendientes
    db.failNext("notifications_log", "upsert"); // reclamo del grupo
    const res = await enviar(payload({ capturedAt: hora(2), tarea2: 75 }));

    assert.equal(res.status, 200);
    assert.equal(res.body.changes_inserted, 2);
    assert.equal(res.body.notified, 0);
    assert.equal(res.body.failed, 1);
    assert.ok(logs.some((l) => l.includes("reintento_notificaciones_fallido")));
    assert.ok(!logs.join("\n").includes("fallo simulado"));
  });

  test("los logs solo llevan ids y conteos, nunca calificaciones ni el mensaje", async () => {
    const email = canal("email");
    const { db, enviar, logs } = setup({ extraChannels: [email] });
    await enviar(payload({ capturedAt: hora(0) }));
    email.falla.activo = true;
    await enviar(payload({ capturedAt: hora(2), tarea2: 75 }));
    email.falla.activo = false;
    await enviar(payload({ capturedAt: hora(4), tarea2: 75 }));

    const todo = logs.join("\n");
    for (const prohibido of [...SENSIBLES, "calificación", "de 70 a 75", "Resend rechazó", "70.00", "75.00"]) {
      assert.ok(!todo.includes(prohibido), `apareció en el log: ${prohibido.slice(0, 12)}`);
    }
    const userId = db.tables.app_users[0].id;
    for (const line of logs) {
      const parsed = JSON.parse(line);
      for (const [campo, valor] of Object.entries(parsed)) {
        assert.ok(!["70", "75"].includes(valor), `valor de calificación en ${campo}`);
      }
      if (parsed.event.startsWith("notificacion")) assert.ok(!line.includes(userId), "user_id en un log de notificación");
    }

    const enviada = JSON.parse(logs.find((l) => l.includes("notificacion_enviada")));
    assert.equal(enviada.grade_change_ids.length, 2);
    const fallida = JSON.parse(logs.find((l) => l.includes("notificacion_fallida")));
    assert.deepEqual(Object.keys(fallida).sort(), ["attempts", "channel", "event", "grade_change_id", "level", "ts"]);
  });
});
