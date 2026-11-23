// ITN-58b - Materias unificadas entre iVirtual, Classroom y la API de ITSON en
// GET /api/courses y GET /api/courses/:id/items. Supabase simulado; datos inventados.
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

const SECRET = "clave-de-pruebas-materias-unificadas-".repeat(2);
const T0 = Date.parse("2026-11-16T12:00:00Z");
const uuid = () => crypto.randomUUID();
const hora = (n) => new Date(T0 + n * 60 * 60 * 1000).toISOString();

const ALUMNA = { userId: uuid(), googleId: "google-u", email: "alumna.unificada@example.test", sessionId: "sesion-unificada" };

// Campos de cada materia antes de ITN-58b: no pueden cambiar de nombre ni de tipo.
const CAMPOS_ANTIGUOS = ["id", "name", "source", "period", "finalGrade", "updatedAt"];
const CAMPOS_ITEM_ANTIGUOS = ["id", "label", "grade", "maxGrade", "dueAt", "kind"];

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

// Mock de las tres fuentes: "Ingeniería de Software" está en las tres; "Cálculo II"
// solo en iVirtual y "Cálculo I" solo en la API de ITSON (no deben unirse).
async function sembrarTresFuentes(db) {
  await guardarSnapshot(db, {
    run_id: uuid(),
    captured_at: hora(-3),
    source: "ivirtual",
    user: { email: ALUMNA.email },
    courses: [
      {
        externalId: "501",
        subject: "Ingeniería de Software",
        items: [
          { externalItemId: "9001", label: "Tarea iVirtual", type: "mod", value: 90, text: "90.00", max: 100, dueAt: "2026-11-10T06:59:00.000Z" },
          { externalItemId: "9006", label: null, type: "course", value: 90, text: "90.00", max: 100 },
        ],
      },
      {
        externalId: "502",
        subject: "Cálculo II",
        items: [{ externalItemId: "9101", label: null, type: "course", value: 70, text: "70.00", max: 100 }],
      },
    ],
  });
  await guardarSnapshot(db, {
    run_id: uuid(),
    captured_at: hora(-2),
    source: "itson_api",
    period: "05",
    user: { email: ALUMNA.email },
    courses: [
      { externalId: "CAT-1", subject: "INGENIERIA DE SOFTWARE", items: [{ externalItemId: "CAT-1", text: "9" }] },
      { externalId: "CAT-2", subject: "Cálculo I", items: [{ externalItemId: "CAT-2", text: "8" }] },
    ],
  });
  const classroomId = uuid();
  const tareaId = uuid();
  db.tables.classroom_courses.push({
    id: classroomId,
    user_id: ALUMNA.userId,
    external_course_id: "c-1",
    name: "Ingeniería de Software - Grupo 02",
    section: "Grupo 02",
    last_seen_at: hora(0),
  });
  db.tables.classroom_coursework.push({
    id: tareaId,
    user_id: ALUMNA.userId,
    course_id: classroomId,
    external_coursework_id: "cw-1",
    title: "Tarea Classroom",
    due_at: "2026-11-25T06:59:00.000Z",
    max_points: 50,
  });

  const subject = (name) => db.tables.subjects.find((s) => s.user_id === ALUMNA.userId && s.name === name);
  return {
    ivirtualId: subject("Ingeniería de Software").id,
    itsonId: subject("INGENIERIA DE SOFTWARE").id,
    classroomId,
    tareaId,
  };
}

describe("ITN-58b - GET /api/courses con materias unificadas", () => {
  test("contrato: una entrada por materia, campos antiguos intactos y sources[] por fuente", async () => {
    const { app, db, logs } = setup();
    const ids = await sembrarTresFuentes(db);

    const res = await request(app).get("/api/courses").set("Cookie", cookie());
    assert.equal(res.status, 200);
    assert.equal(res.headers["cache-control"], "no-store");

    const cursos = res.body.courses;
    // Ingeniería de Software (3 fuentes), Cálculo II (iVirtual), Cálculo I (ITSON).
    assert.equal(cursos.length, 3);
    for (const c of cursos) {
      // ITN-58d agrega `scope` e ITN-58g `ivirtualUrl` (solo con fuente iVirtual), ambos
      // aditivos: los campos antiguos siguen igual.
      const conIvirtual = c.sources.some((s) => s.source === "ivirtual");
      const esperadas = [...CAMPOS_ANTIGUOS, "sources", "scope", ...(conIvirtual ? ["ivirtualUrl"] : [])];
      assert.deepEqual(Object.keys(c).sort(), esperadas.sort());
      assert.equal(c.scope, "actual");
      assert.equal(typeof c.id, "string");
      assert.equal(typeof c.name, "string");
      assert.ok(["ivirtual", "classroom", "itson_api"].includes(c.source));
      assert.ok(c.period === null || typeof c.period === "string");
      assert.ok(c.finalGrade === null || typeof c.finalGrade === "string");
      assert.equal(typeof c.updatedAt, "string");
      assert.ok(Array.isArray(c.sources) && c.sources.length >= 1);
      // La fuente principal siempre es la primera de sources[].
      assert.equal(c.sources[0].id, c.id);
      assert.equal(c.sources[0].source, c.source);
    }

    // Mismo orden que antes: por fuente principal y luego por nombre.
    assert.deepEqual(cursos.map((c) => c.name), ["Cálculo II", "Ingeniería de Software", "Cálculo I"]);
    const [calculo2, ingenieria, calculo1] = cursos;
    // Los campos antiguos son los de iVirtual (fuente principal); updatedAt es el más reciente.
    assert.deepEqual(
      { id: ingenieria.id, name: ingenieria.name, source: ingenieria.source, period: ingenieria.period, finalGrade: ingenieria.finalGrade, updatedAt: ingenieria.updatedAt },
      { id: ids.ivirtualId, name: "Ingeniería de Software", source: "ivirtual", period: null, finalGrade: "90", updatedAt: hora(0) },
    );
    assert.deepEqual(ingenieria.sources, [
      { source: "ivirtual", id: ids.ivirtualId, name: "Ingeniería de Software", period: null, finalGrade: "90", updatedAt: hora(-3) },
      { source: "classroom", id: ids.classroomId, name: "Ingeniería de Software - Grupo 02", period: "Grupo 02", finalGrade: null, updatedAt: hora(0) },
      { source: "itson_api", id: ids.itsonId, name: "INGENIERIA DE SOFTWARE", period: "05", finalGrade: "9", updatedAt: hora(-2) },
    ]);

    // Cálculo I y Cálculo II siguen separadas, cada una con su única fuente.
    assert.deepEqual(
      [calculo2, calculo1].map((c) => ({ name: c.name, source: c.source, finalGrade: c.finalGrade, fuentes: c.sources.map((s) => s.source) })),
      [
        { name: "Cálculo II", source: "ivirtual", finalGrade: "70", fuentes: ["ivirtual"] },
        { name: "Cálculo I", source: "itson_api", finalGrade: "8", fuentes: ["itson_api"] },
      ],
    );
    assert.deepEqual(logs, []);
  });

  test("si Classroom falla, las materias siguen con las fuentes disponibles y el log no lleva datos", async () => {
    const { app, db, logs } = setup();
    const ids = await sembrarTresFuentes(db);
    db.failNext("classroom_courses", "select");

    const res = await request(app).get("/api/courses").set("Cookie", cookie());
    assert.equal(res.status, 200);
    const ingenieria = res.body.courses.find((c) => c.id === ids.ivirtualId);
    assert.deepEqual(ingenieria.sources.map((s) => s.source), ["ivirtual", "itson_api"]);
    assert.equal(res.body.courses.some((c) => c.source === "classroom"), false);

    assert.equal(logs.length, 1);
    const { ts, ...campos } = JSON.parse(logs[0]);
    assert.deepEqual(campos, { level: "warn", event: "materias_fuente_no_disponible", step: "classroom_courses", error_code: "XX000" });
  });

  test("con las tablas de Classroom vacías se unen iVirtual e ITSON", async () => {
    const { app, db } = setup();
    const ids = await sembrarTresFuentes(db);
    db.tables.classroom_courses.length = 0;
    db.tables.classroom_coursework.length = 0;

    const res = await request(app).get("/api/courses").set("Cookie", cookie());
    assert.equal(res.status, 200);
    const ingenieria = res.body.courses.find((c) => c.id === ids.ivirtualId);
    assert.deepEqual(ingenieria.sources.map((s) => [s.source, s.id]), [["ivirtual", ids.ivirtualId], ["itson_api", ids.itsonId]]);
    assert.equal(ingenieria.updatedAt, hora(-2));
  });

  test("un empate entre dos candidatas no une y solo registra cuántas quedaron sin unir", async () => {
    const { app, db, logs } = setup();
    await guardarSnapshot(db, {
      run_id: uuid(),
      captured_at: hora(-1),
      source: "ivirtual",
      user: { email: ALUMNA.email },
      courses: [{ externalId: "701", subject: "Física Reservada", items: [{ externalItemId: "1", label: null, type: "course", value: 80, text: "80.00" }] }],
    });
    for (const period of ["03", "05"]) {
      await guardarSnapshot(db, {
        run_id: uuid(),
        captured_at: hora(-2),
        source: "itson_api",
        period,
        user: { email: ALUMNA.email },
        courses: [{ externalId: `F-${period}`, subject: "Física Reservada", items: [{ externalItemId: `F-${period}`, text: "7" }] }],
      });
    }

    const res = await request(app).get("/api/courses").set("Cookie", cookie());
    assert.equal(res.status, 200);
    assert.equal(res.body.courses.length, 3);
    assert.ok(res.body.courses.every((c) => c.sources.length === 1));

    assert.equal(logs.length, 1);
    const { ts, ...campos } = JSON.parse(logs[0]);
    assert.deepEqual(campos, { level: "info", event: "materias_sin_unir_por_empate", count: 3 });
    assert.equal(logs[0].includes("Física"), false);
  });
});

describe("ITN-58b - GET /api/courses/:id/items de una materia unificada", () => {
  test("devuelve los items de iVirtual y Classroom con su fuente, pidiendo por el id de cualquier fuente", async () => {
    const { app, db } = setup();
    const ids = await sembrarTresFuentes(db);

    const respuestas = [];
    for (const id of [ids.ivirtualId, ids.classroomId, ids.itsonId]) {
      const res = await request(app).get(`/api/courses/${id}/items`).set("Cookie", cookie());
      assert.equal(res.status, 200);
      respuestas.push(res.body);
    }
    assert.deepEqual(respuestas[1], respuestas[0]);
    assert.deepEqual(respuestas[2], respuestas[0]);

    const { items } = respuestas[0];
    for (const item of items) {
      for (const campo of CAMPOS_ITEM_ANTIGUOS) assert.ok(campo in item, campo);
      assert.equal(item.source, item.kind);
    }
    assert.deepEqual(
      items.map(({ label, grade, maxGrade, dueAt, kind, source }) => ({ label, grade, maxGrade, dueAt, kind, source })),
      [
        { label: "Tarea iVirtual", grade: 90, maxGrade: 100, dueAt: "2026-11-10T06:59:00.000Z", kind: "ivirtual", source: "ivirtual" },
        { label: "Tarea Classroom", grade: null, maxGrade: 50, dueAt: "2026-11-25T06:59:00.000Z", kind: "classroom", source: "classroom" },
      ],
    );
  });

  test("si falla una fuente hermana, devuelve los items de las demás", async () => {
    const { app, db, logs } = setup();
    const ids = await sembrarTresFuentes(db);
    db.failNext("classroom_coursework", "select");

    const res = await request(app).get(`/api/courses/${ids.ivirtualId}/items`).set("Cookie", cookie());
    assert.equal(res.status, 200);
    assert.deepEqual(res.body.items.map((i) => i.source), ["ivirtual"]);
    assert.equal(logs.length, 1);
    const { ts, ...campos } = JSON.parse(logs[0]);
    assert.deepEqual(campos, { level: "warn", event: "materias_fuente_no_disponible", step: "items_classroom", error_code: "XX000" });
  });

  test("una materia sin otras fuentes conserva la respuesta de antes", async () => {
    const { app, db } = setup();
    await sembrarTresFuentes(db);
    const calculo2 = db.tables.subjects.find((s) => s.name === "Cálculo II");
    const res = await request(app).get(`/api/courses/${calculo2.id}/items`).set("Cookie", cookie());
    assert.equal(res.status, 200);
    assert.deepEqual(res.body, { items: [] });
  });

  test("sin sesión sigue respondiendo 401", async () => {
    const { app, db } = setup();
    const ids = await sembrarTresFuentes(db);
    const res = await request(app).get(`/api/courses/${ids.ivirtualId}/items`);
    assert.equal(res.status, 401);
    assert.deepEqual(res.body, { error: "no_autenticado" });
  });
});

describe("ITN-58e - enlace a la tarea de Classroom en GET /api/courses/:id/items", () => {
  const ENLACE = "https://classroom.google.com/c/MTIz/a/NDU2/details";

  function agregarTarea(db, courseId, title, alternateLink) {
    db.tables.classroom_coursework.push({
      id: uuid(),
      user_id: ALUMNA.userId,
      course_id: courseId,
      external_coursework_id: `cw-${title}`,
      title,
      due_at: "2026-11-26T06:59:00.000Z",
      max_points: 10,
      alternate_link: alternateLink,
    });
  }

  test("los items de Classroom traen url válida o null; los de iVirtual no traen url", async () => {
    const { app, db } = setup();
    const ids = await sembrarTresFuentes(db);
    db.tables.classroom_coursework.find((t) => t.id === ids.tareaId).alternate_link = ENLACE;
    agregarTarea(db, ids.classroomId, "Enlace http", "http://classroom.google.com/c/1/a/2/details");
    agregarTarea(db, ids.classroomId, "Enlace falso", "https://classroom.google.com.evil.com/c/1");
    agregarTarea(db, ids.classroomId, "Enlace script", "javascript:alert(1)");

    const res = await request(app).get(`/api/courses/${ids.ivirtualId}/items`).set("Cookie", cookie());
    assert.equal(res.status, 200);
    const porNombre = Object.fromEntries(res.body.items.map((i) => [i.label, i]));
    assert.equal(porNombre["Tarea Classroom"].url, ENLACE);
    assert.equal(porNombre["Enlace http"].url, null);
    assert.equal(porNombre["Enlace falso"].url, null);
    assert.equal(porNombre["Enlace script"].url, null);
    assert.equal(porNombre["Tarea iVirtual"].url ?? null, null);
    assert.equal("url" in porNombre["Tarea iVirtual"], false);
  });

  test("sin la columna alternate_link la ruta responde y los items traen url null", async () => {
    const { app, db } = setup();
    const ids = await sembrarTresFuentes(db);
    db.withoutColumn("classroom_coursework", "alternate_link");

    const res = await request(app).get(`/api/courses/${ids.classroomId}/items`).set("Cookie", cookie());
    assert.equal(res.status, 200);
    const tarea = res.body.items.find((i) => i.source === "classroom");
    assert.equal(tarea.label, "Tarea Classroom");
    assert.equal(tarea.url, null);
  });

  test("sin la tabla classroom_coursework la ruta responde sin items de Classroom", async () => {
    const { app, db } = setup();
    const ids = await sembrarTresFuentes(db);
    db.failNext("classroom_coursework", "select", "42P01");

    const res = await request(app).get(`/api/courses/${ids.classroomId}/items`).set("Cookie", cookie());
    assert.equal(res.status, 200);
    assert.deepEqual(res.body.items.map((i) => i.source), ["ivirtual"]);
  });
});
