// ITN-60 - POST /internal/calendar-events y GET /api/calendar con supertest y el
// Supabase simulado. Eventos inventados, sin red.
const { test, describe } = require("node:test");
const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const request = require("supertest");

const { createApp } = require("../../src/app");
const { createLogger } = require("../../src/utils/logger");
const { sessionHash } = require("../../src/middleware/studentSession");
const { encrypt } = require("../../src/utils/secureToken");
const { parseCalendarRange, limitesDelDia, diaEnHermosillo } = require("../../src/models/calendarEvent");
const { createFakeSupabase } = require("../helpers/fakeSupabase");
const { API_KEY, CREDENTIALS_KEY } = require("../helpers/payloads");

const SECRET = "clave-de-pruebas-calendario-".repeat(2);
const FRONTEND = "http://localhost:5173";
const T0 = Date.parse("2026-11-18T12:00:00Z");
const RUTA_INTERNA = "/internal/calendar-events";
const ALUMNA = { userId: crypto.randomUUID(), googleId: "google-cal", email: "alumna.cal@example.test", sessionId: "sesion-cal" };

function setup() {
  const db = createFakeSupabase();
  const logs = [];
  let ahora = T0;
  const app = createApp({
    config: { internalApiKey: API_KEY, credentialsEncryptionKey: CREDENTIALS_KEY, googleAuthSecret: SECRET, frontendUrl: FRONTEND },
    supabase: db.client,
    logger: createLogger((line) => logs.push(line)),
    now: () => ahora,
    channels: [],
  });
  db.tables.app_users.push({ id: ALUMNA.userId, email: ALUMNA.email });
  db.tables.google_authorizations.push({
    user_id: ALUMNA.userId, google_id: ALUMNA.googleId, email: ALUMNA.email, scope: "s", refresh_token: "cifrado",
  });
  db.tables.google_app_sessions.push({
    id: sessionHash(ALUMNA.sessionId), user_id: ALUMNA.userId, google_id: ALUMNA.googleId,
    expires_at: new Date(T0 + 30 * 24 * 3600e3).toISOString(), revoked_at: null,
  });
  return { db, app, logs, avanzar: (ms) => { ahora += ms; } };
}

const cookie = () =>
  `itn41_google_session=${encrypt({ ...ALUMNA, exp: T0 + 30 * 24 * 3600e3 }, SECRET, "google-session")}`;

// Eventos inventados con la forma que manda el worker.
const ULTIMO_DIA = {
  externalId: "137", title: "Último día de clases (prueba)", description: "Último día.",
  startsAt: "2026-12-05T00:00:00-07:00", endsAt: "2026-12-05T23:59:59-07:00", allDay: true, category: "Registro Escolar",
};
const VACACIONES = {
  externalId: "143", title: "Vacaciones (prueba)", description: null,
  startsAt: "2026-12-17T00:00:00-07:00", endsAt: "2027-01-03T23:59:59-07:00", allDay: true, category: "Registro Escolar",
};
const CHARLA = {
  externalId: "4589", title: "Charla de prueba", description: "Texto",
  startsAt: "2026-11-19T14:30:00-07:00", endsAt: "2026-11-19T16:00:00-07:00", allDay: false, category: "Académicos",
};
// 23:30 en Hermosillo del 5 de diciembre = 06:30 UTC del 6.
const NOCTURNO = {
  externalId: "5000", title: "Evento nocturno (prueba)", description: null,
  startsAt: "2026-12-05T23:30:00-07:00", endsAt: "2026-12-05T23:45:00-07:00", allDay: false, category: null,
};

const enviar = (app, events, key = API_KEY) =>
  request(app).post(RUTA_INTERNA).set("x-api-key", key).send({ events });
const leer = (app, query, conSesion = true) => {
  const r = request(app).get("/api/calendar").query(query);
  return conSesion ? r.set("Cookie", cookie()) : r;
};

describe("ITN-60 - POST /internal/calendar-events", () => {
  test("401 sin x-api-key y sin tocar la base", async () => {
    const { app, db } = setup();
    const res = await request(app).post(RUTA_INTERNA).send({ events: [CHARLA] });
    assert.equal(res.status, 401);
    assert.equal(db.tables.calendar_events.length, 0);
  });

  test("correr dos veces el mismo lote no duplica filas ni cambia updated_at", async () => {
    const { app, db, avanzar } = setup();
    const primera = await enviar(app, [ULTIMO_DIA, VACACIONES, CHARLA]);
    assert.equal(primera.status, 200);
    assert.deepEqual(primera.body, { received: 3, inserted: 3, updated: 0, unchanged: 0 });
    const antes = db.tables.calendar_events.map((r) => ({ ...r }));

    avanzar(60_000);
    const segunda = await enviar(app, [ULTIMO_DIA, VACACIONES, CHARLA]);
    assert.deepEqual(segunda.body, { received: 3, inserted: 0, updated: 0, unchanged: 3 });
    assert.equal(db.tables.calendar_events.length, 3);
    assert.deepEqual(db.tables.calendar_events, antes);
  });

  test("un evento que cambió se actualiza en su misma fila", async () => {
    const { app, db, avanzar } = setup();
    await enviar(app, [CHARLA]);
    const id = db.tables.calendar_events[0].id;
    avanzar(60_000);
    const res = await enviar(app, [{ ...CHARLA, title: "Charla movida (prueba)" }, ULTIMO_DIA]);
    assert.deepEqual(res.body, { received: 2, inserted: 1, updated: 1, unchanged: 0 });
    const fila = db.tables.calendar_events.find((r) => r.external_id === "4589");
    assert.equal(fila.id, id);
    assert.equal(fila.title, "Charla movida (prueba)");
    assert.equal(fila.updated_at, new Date(T0 + 60_000).toISOString());
  });

  test("todo el día se guarda de 00:00:00 a 23:59:59 hora de Hermosillo aunque llegue otra hora", async () => {
    const { app, db } = setup();
    await enviar(app, [{ ...ULTIMO_DIA, startsAt: "2026-12-05T08:00:00-07:00", endsAt: "2026-12-05T23:59:00-07:00" }]);
    const [fila] = db.tables.calendar_events;
    assert.equal(fila.starts_at, "2026-12-05T07:00:00.000Z");
    assert.equal(fila.ends_at, "2026-12-06T06:59:59.000Z");
    assert.equal(fila.all_day, true);
  });

  for (const [nombre, events] of [
    ["sin eventos", []],
    ["externalId no numérico", [{ ...CHARLA, externalId: "abc" }]],
    ["fecha sin zona", [{ ...CHARLA, startsAt: "2026-11-19T14:30:00" }]],
    ["fin antes del inicio", [{ ...CHARLA, endsAt: "2026-11-19T10:00:00-07:00" }]],
    ["externalId repetido", [CHARLA, CHARLA]],
    ["campo extra", [{ ...CHARLA, matricula: "x" }]],
  ]) {
    test(`400 con ${nombre}, sin guardar nada (lote todo o nada)`, async () => {
      const { app, db } = setup();
      const res = await enviar(app, [ULTIMO_DIA, ...events].slice(events.length === 0 ? 1 : 0));
      assert.equal(res.status, 400);
      assert.equal(res.body.error, "payload_invalido");
      assert.equal(db.tables.calendar_events.length, 0);
    });
  }

  test("si falla la escritura responde 500 y no deja filas a medias", async () => {
    const { app, db } = setup();
    db.failNext("calendar_events", "upsert");
    const res = await enviar(app, [ULTIMO_DIA, CHARLA]);
    assert.equal(res.status, 500);
    assert.equal(db.tables.calendar_events.length, 0);
  });

  test("503 si la migración 015 no está aplicada", async () => {
    const { app, db } = setup();
    db.failNext("calendar_events", "select", "42P01");
    const res = await enviar(app, [CHARLA]);
    assert.equal(res.status, 503);
    assert.deepEqual(res.body, { error: "calendario_migracion_requerida" });
  });
});

describe("ITN-60 - GET /api/calendar", () => {
  test("401 sin sesión, con Cache-Control: no-store", async () => {
    const { app } = setup();
    const res = await leer(app, { from: "2026-11-01", to: "2026-11-30" }, false);
    assert.equal(res.status, 401);
    assert.equal(res.headers["cache-control"], "no-store");
    assert.deepEqual(res.body, { error: "no_autenticado" });
  });

  for (const [nombre, query, error] of [
    ["sin from ni to", {}, "fechas_requeridas"],
    ["sin to", { from: "2026-11-01" }, "fechas_requeridas"],
    ["formato distinto", { from: "01/11/2026", to: "2026-11-30" }, "fecha_invalida"],
    ["fecha con hora", { from: "2026-11-01T00:00:00Z", to: "2026-11-30" }, "fecha_invalida"],
    ["fecha que no existe", { from: "2026-02-30", to: "2026-03-05" }, "fecha_invalida"],
    ["parámetro repetido", { from: ["2026-11-01", "2026-11-02"], to: "2026-11-30" }, "fecha_invalida"],
    ["from después de to", { from: "2026-12-01", to: "2026-11-30" }, "rango_invertido"],
    ["más de 366 días", { from: "2026-01-01", to: "2027-01-02" }, "rango_demasiado_amplio"],
  ]) {
    test(`400 con ${nombre}`, async () => {
      const { app } = setup();
      const res = await leer(app, query);
      assert.equal(res.status, 400);
      assert.equal(res.body.error, error);
      assert.equal(typeof res.body.message, "string");
      assert.ok(res.body.message.length > 0);
    });
  }

  test("366 días exactos sí se aceptan", () => {
    assert.equal(parseCalendarRange({ from: "2028-01-01", to: "2028-12-31" }).success, true);
  });

  test("devuelve los eventos que intersectan el rango, ordenados por inicio, con la forma del contrato", async () => {
    const { app } = setup();
    await enviar(app, [VACACIONES, CHARLA, ULTIMO_DIA]);
    const res = await leer(app, { from: "2026-11-01", to: "2026-12-20" });
    assert.equal(res.status, 200);
    assert.deepEqual(res.body.events.map((e) => e.title), [CHARLA.title, ULTIMO_DIA.title, VACACIONES.title]);
    const [charla] = res.body.events;
    assert.deepEqual(Object.keys(charla).sort(), [
      "allDay", "category", "description", "endDate", "endsAt", "id", "startDate", "startsAt", "title", "updatedAt",
    ]);
    assert.deepEqual({ ...charla, id: undefined }, {
      id: undefined,
      title: CHARLA.title,
      description: "Texto",
      startsAt: "2026-11-19T21:30:00.000Z",
      endsAt: "2026-11-19T23:00:00.000Z",
      startDate: "2026-11-19",
      endDate: "2026-11-19",
      allDay: false,
      category: "Académicos",
      updatedAt: new Date(T0).toISOString(),
    });
  });

  test("un evento que empezó antes del rango y sigue dentro aparece (intersección)", async () => {
    const { app } = setup();
    await enviar(app, [VACACIONES]);
    const res = await leer(app, { from: "2027-01-03", to: "2027-01-10" });
    assert.deepEqual(res.body.events.map((e) => e.title), [VACACIONES.title]);
    const fuera = await leer(app, { from: "2027-01-04", to: "2027-01-10" });
    assert.deepEqual(fuera.body.events, []);
  });

  test("todo el día no se corre de día: solo sale el 5 de diciembre y con fechas de Hermosillo", async () => {
    const { app } = setup();
    await enviar(app, [ULTIMO_DIA]);
    for (const [dia, esperado] of [["2026-12-04", 0], ["2026-12-05", 1], ["2026-12-06", 0]]) {
      const res = await leer(app, { from: dia, to: dia });
      assert.equal(res.body.events.length, esperado, dia);
    }
    const [e] = (await leer(app, { from: "2026-12-05", to: "2026-12-05" })).body.events;
    assert.equal(e.allDay, true);
    assert.equal(e.startDate, "2026-12-05");
    assert.equal(e.endDate, "2026-12-05");
    assert.equal(e.startsAt, "2026-12-05T07:00:00.000Z");
    assert.equal(e.endsAt, "2026-12-06T06:59:59.000Z");
  });

  test("from y to se leen en hora de Hermosillo: 23:30 del día 5 no cae en el día 6", async () => {
    const { app } = setup();
    await enviar(app, [NOCTURNO]);
    assert.equal((await leer(app, { from: "2026-12-05", to: "2026-12-05" })).body.events.length, 1);
    assert.equal((await leer(app, { from: "2026-12-06", to: "2026-12-06" })).body.events.length, 0);
  });

  test("503 si la migración 015 no está aplicada", async () => {
    const { app, db } = setup();
    db.failNext("calendar_events", "select", "42P01");
    const res = await leer(app, { from: "2026-11-01", to: "2026-11-30" });
    assert.equal(res.status, 503);
    assert.deepEqual(res.body, { error: "calendario_no_disponible" });
  });
});

describe("ITN-60 - fechas de Hermosillo", () => {
  test("limitesDelDia y diaEnHermosillo usan UTC-7 fijo", () => {
    const { inicio, fin } = limitesDelDia("2026-12-05");
    assert.equal(new Date(inicio).toISOString(), "2026-12-05T07:00:00.000Z");
    assert.equal(new Date(fin).toISOString(), "2026-12-06T06:59:59.999Z");
    assert.equal(diaEnHermosillo("2026-12-06T06:59:59Z"), "2026-12-05");
    assert.equal(diaEnHermosillo("2026-12-06T07:00:00Z"), "2026-12-06");
    // Julio: sin horario de verano, sigue siendo -07:00.
    assert.equal(new Date(limitesDelDia("2026-07-01").inicio).toISOString(), "2026-07-01T07:00:00.000Z");
  });
});
