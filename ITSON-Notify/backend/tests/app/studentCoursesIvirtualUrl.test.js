// ITN-58g - Enlace "Abrir en iVirtual" a nivel de materia en GET /api/courses.
// Supabase simulado; datos inventados (sin datos personales reales).
const { test, describe } = require("node:test");
const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const request = require("supertest");

const { createApp } = require("../../src/app");
const { createLogger } = require("../../src/utils/logger");
const { sessionHash } = require("../../src/middleware/studentSession");
const { encrypt } = require("../../src/utils/secureToken");
const { saveSnapshot } = require("../../src/repositories/snapshotRepository");
const { parseGradeSnapshotPayload } = require("../../src/models/gradeSnapshotPayload");
const { createFakeSupabase } = require("../helpers/fakeSupabase");
const { API_KEY, CREDENTIALS_KEY } = require("../helpers/payloads");

const SECRET = "clave-de-pruebas-enlace-ivirtual-".repeat(2);
const T0 = Date.parse("2026-11-16T12:00:00Z");
const uuid = () => crypto.randomUUID();
const hora = (n) => new Date(T0 + n * 60 * 60 * 1000).toISOString();
const BASE = "https://ivirtual.itson.edu.mx/course/view.php?id=";

const ALUMNA = { userId: uuid(), googleId: "google-iv", email: "alumna.enlace@example.test", sessionId: "sesion-enlace-iv" };

function setup() {
  const db = createFakeSupabase();
  const logs = [];
  const app = createApp({
    config: {
      internalApiKey: API_KEY,
      credentialsEncryptionKey: CREDENTIALS_KEY,
      googleAuthSecret: SECRET,
      frontendUrl: "http://localhost:5173",
    },
    supabase: db.client,
    logger: createLogger((line) => logs.push(line)),
    now: () => T0,
    channels: [],
  });
  db.tables.app_users.push({ id: ALUMNA.userId, email: ALUMNA.email });
  db.tables.google_authorizations.push({
    user_id: ALUMNA.userId, google_id: ALUMNA.googleId, email: ALUMNA.email, scope: "s", refresh_token: "cifrado",
  });
  db.tables.google_app_sessions.push({
    id: sessionHash(ALUMNA.sessionId), user_id: ALUMNA.userId, google_id: ALUMNA.googleId, expires_at: hora(2), revoked_at: null,
  });
  return { db, app, logs };
}

const cookie = () =>
  `itn41_google_session=${encrypt({ ...ALUMNA, exp: T0 + 60 * 60 * 1000 }, SECRET, "google-session")}`;

async function guardarSnapshot(db, body) {
  const parsed = parseGradeSnapshotPayload(body, { now: T0 + 24 * 60 * 60 * 1000 });
  assert.equal(parsed.success, true, JSON.stringify(parsed.issues));
  return saveSnapshot(db.client, parsed.data);
}

// "Programación Web" está en iVirtual y Classroom (se unen); "Física I" solo en
// iVirtual; "Química" solo en iVirtual pero con un id no numérico; "Cálculo I" solo en la
// API de ITSON (id con otro formato); "Taller de Arte" solo en Classroom.
async function sembrar(db) {
  await guardarSnapshot(db, {
    run_id: uuid(),
    captured_at: hora(-3),
    source: "ivirtual",
    user: { email: ALUMNA.email },
    courses: [
      { externalId: "12345", subject: "Programación Web", items: [{ externalItemId: "9001", label: "Tarea 1", type: "mod", value: 90, text: "90.00", max: 100 }] },
      { externalId: "67890", subject: "Física I", items: [{ externalItemId: "9101", label: null, type: "course", value: 80, text: "80.00", max: 100 }] },
      { externalId: "id-raro", subject: "Química", items: [{ externalItemId: "9201", label: null, type: "course", value: 70, text: "70.00", max: 100 }] },
    ],
  });
  await guardarSnapshot(db, {
    run_id: uuid(),
    captured_at: hora(-2),
    source: "itson_api",
    period: "05",
    user: { email: ALUMNA.email },
    courses: [{ externalId: "54321", subject: "Cálculo I", items: [{ externalItemId: "54321", text: "9" }] }],
  });
  const classroomUnido = uuid();
  const classroomSolo = uuid();
  db.tables.classroom_courses.push(
    { id: classroomUnido, user_id: ALUMNA.userId, external_course_id: "c-1", name: "Programación Web - Grupo 01", section: "Grupo 01", last_seen_at: hora(0) },
    { id: classroomSolo, user_id: ALUMNA.userId, external_course_id: "c-2", name: "Taller de Arte", section: "Grupo 03", last_seen_at: hora(0) },
  );
  const subject = (name) => db.tables.subjects.find((s) => s.user_id === ALUMNA.userId && s.name === name);
  return { programacionId: subject("Programación Web").id, classroomUnido, classroomSolo };
}

describe("ITN-58g - ivirtualUrl en GET /api/courses", () => {
  test("solo las materias con fuente iVirtual traen ivirtualUrl, armado con el id de curso de Moodle", async () => {
    const { app, db, logs } = setup();
    const ids = await sembrar(db);

    const res = await request(app).get("/api/courses").set("Cookie", cookie());
    assert.equal(res.status, 200);
    const porNombre = new Map(res.body.courses.map((c) => [c.name, c]));
    assert.equal(res.body.courses.length, 5);

    // Unificada iVirtual + Classroom: enlace de la fuente iVirtual.
    const unida = porNombre.get("Programación Web");
    assert.deepEqual(unida.sources.map((s) => s.source), ["ivirtual", "classroom"]);
    assert.equal(unida.id, ids.programacionId);
    assert.equal(unida.ivirtualUrl, `${BASE}12345`);
    // sources[] no cambia de forma.
    for (const s of unida.sources) assert.equal("ivirtualUrl" in s, false);

    // Solo iVirtual.
    assert.equal(porNombre.get("Física I").ivirtualUrl, `${BASE}67890`);
    // Solo iVirtual con id no numérico: el campo va, pero en null.
    assert.equal("ivirtualUrl" in porNombre.get("Química"), true);
    assert.equal(porNombre.get("Química").ivirtualUrl, null);

    // Solo API de ITSON (aunque su id sea numérico) y solo Classroom: sin campo.
    const itson = porNombre.get("Cálculo I");
    assert.equal(itson.source, "itson_api");
    assert.equal("ivirtualUrl" in itson, false);
    const classroom = porNombre.get("Taller de Arte");
    assert.equal(classroom.source, "classroom");
    assert.equal("ivirtualUrl" in classroom, false);

    // La URL no se registra.
    assert.doesNotMatch(logs.join("\n"), /ivirtual\.itson\.edu\.mx/);
  });

  test("/items no cambia: los items no traen ivirtualUrl ni enlace de iVirtual", async () => {
    const { app, db, logs } = setup();
    const ids = await sembrar(db);

    for (const id of [ids.programacionId, ids.classroomUnido]) {
      const res = await request(app).get(`/api/courses/${id}/items`).set("Cookie", cookie());
      assert.equal(res.status, 200);
      assert.ok(res.body.items.length >= 1);
      for (const item of res.body.items) {
        assert.equal("ivirtualUrl" in item, false);
        assert.doesNotMatch(JSON.stringify(item), /ivirtual\.itson\.edu\.mx/);
      }
    }
    assert.doesNotMatch(logs.join("\n"), /ivirtual\.itson\.edu\.mx/);
  });
});
