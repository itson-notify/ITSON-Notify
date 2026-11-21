// ITN-58d - `scope` de GET /api/courses (materias fuera del plan de estudios) y
// detalle de una materia anterior. Supabase simulado; datos y nombres inventados.
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

const SECRET = "clave-de-pruebas-materias-fuera-de-plan-".repeat(2);
const T0 = Date.parse("2026-11-16T12:00:00Z");
const uuid = () => crypto.randomUUID();
const hora = (n) => new Date(T0 + n * 60 * 60 * 1000).toISOString();

const ALUMNA = { userId: uuid(), googleId: "google-u", email: "alumna.fuera.de.plan@example.test", sessionId: "sesion-fuera-de-plan" };


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

function curso(db, name, extra = {}) {
  const id = uuid();
  db.tables.classroom_courses.push({
    id, user_id: ALUMNA.userId, external_course_id: `ext-${id}`, name, section: null,
    course_state: "ACTIVE", first_seen_at: "2026-08-20T18:00:00Z", last_seen_at: hora(0), updated_at: hora(0), ...extra,
  });
  return id;
}

function tarea(db, courseId, title, updated, created = null) {
  const id = uuid();
  db.tables.classroom_coursework.push({
    id, user_id: ALUMNA.userId, course_id: courseId, external_coursework_id: `cw-${id}`, title,
    due_at: "2023-05-10T06:59:00.000Z", max_points: 10, source_updated_at: updated, source_created_at: created,
  });
  return id;
}

async function sembrar(db) {
  await guardarSnapshot(db, {
    run_id: uuid(),
    captured_at: hora(-2),
    source: "itson_api",
    period: "05",
    user: { email: ALUMNA.email },
    courses: [{ externalId: "CAT-1", subject: "TALLER DE ROBOTICA", items: [{ externalItemId: "CAT-1", text: "9" }] }],
  });
  const ids = {
    archivado: curso(db, "Historia del Arte Antiguo", { course_state: "ARCHIVED" }),
    viejo: curso(db, "Precálculo Grupo Siete", { first_seen_at: "2023-01-20T00:00:00Z" }),
    actual: curso(db, "Seminario de Proyectos Zeta"),
    sinTareasViejo: curso(db, "Club de Lectura Omega", { first_seen_at: "2025-02-01T00:00:00Z" }),
    unificadoArchivado: curso(db, "Taller de Robótica", { course_state: "ARCHIVED" }),
  };
  tarea(db, ids.archivado, "Ensayo inventado", "2025-04-01T00:00:00Z");
  ids.tareaVieja = tarea(db, ids.viejo, "Ejercicios inventados", "2023-05-01T00:00:00Z");
  tarea(db, ids.viejo, "Repaso inventado", null, "2023-03-01T00:00:00Z");
  tarea(db, ids.actual, "Avance inventado", "2026-11-10T00:00:00Z");
  return ids;
}

const porId = (cursos, id) => cursos.find((c) => c.id === id || c.sources.some((s) => s.id === id));

describe("ITN-58d - GET /api/courses con scope", () => {
  test("marca anterior a los cursos solo de Classroom fuera del semestre y actual a los demás", async () => {
    const { app, db, logs } = setup();
    const ids = await sembrar(db);

    const res = await request(app).get("/api/courses").set("Cookie", cookie());
    assert.equal(res.status, 200);
    const cursos = res.body.courses;
    assert.ok(cursos.every((c) => c.scope === "actual" || c.scope === "anterior"));

    assert.equal(porId(cursos, ids.archivado).scope, "anterior"); // a)
    assert.equal(porId(cursos, ids.viejo).scope, "anterior"); // b)
    assert.equal(porId(cursos, ids.actual).scope, "actual"); // c)
    const robotica = porId(cursos, ids.unificadoArchivado); // d)
    assert.deepEqual(robotica.sources.map((s) => s.source).sort(), ["classroom", "itson_api"]);
    assert.equal(robotica.scope, "actual");
    assert.equal(porId(cursos, ids.sinTareasViejo).scope, "anterior"); // e)
    assert.deepEqual(logs, []);
  });

  test("abrir una materia anterior devuelve sus tareas igual que antes", async () => {
    const { app, db } = setup();
    const ids = await sembrar(db);

    const res = await request(app).get(`/api/courses/${ids.viejo}/items`).set("Cookie", cookie());
    assert.equal(res.status, 200);
    assert.equal(res.body.items.length, 2);
    assert.ok(res.body.items.some((i) => i.id === ids.tareaVieja));
    assert.ok(res.body.items.every((i) => i.source === "classroom" && i.kind === "classroom"));
  });

  test("si no se puede leer la actividad de Classroom, avisa sin datos y no esconde cursos ACTIVE", async () => {
    const { app, db, logs } = setup();
    const ids = await sembrar(db);
    db.failNext("classroom_coursework", "select");

    const res = await request(app).get("/api/courses").set("Cookie", cookie());
    assert.equal(res.status, 200);
    const cursos = res.body.courses;
    assert.equal(porId(cursos, ids.viejo).scope, "actual");
    assert.equal(porId(cursos, ids.archivado).scope, "anterior");

    assert.equal(logs.length, 1);
    const { ts, ...campos } = JSON.parse(logs[0]);
    assert.deepEqual(campos, { level: "warn", event: "materias_fuente_no_disponible", step: "classroom_actividad", error_code: "XX000" });
  });

  test("sin materias solo de Classroom no consulta la actividad de las tareas", async () => {
    const { app, db } = setup();
    await guardarSnapshot(db, {
      run_id: uuid(), captured_at: hora(-2), source: "itson_api", period: "05", user: { email: ALUMNA.email },
      courses: [{ externalId: "CAT-1", subject: "TALLER DE ROBOTICA", items: [{ externalItemId: "CAT-1", text: "9" }] }],
    });
    db.calls.length = 0;
    const res = await request(app).get("/api/courses").set("Cookie", cookie());
    assert.equal(res.status, 200);
    assert.deepEqual(res.body.courses.map((c) => c.scope), ["actual"]);
    assert.equal(db.calls.some((c) => c.table === "classroom_coursework"), false);
  });
});
