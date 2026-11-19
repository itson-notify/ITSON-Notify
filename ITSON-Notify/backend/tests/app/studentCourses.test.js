// ITN-57 - Pruebas de GET /api/courses y GET /api/courses/:id/items con supertest
// y el Supabase simulado. Datos inventados.
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

const SECRET = "clave-de-pruebas-api-cursos-".repeat(2);
const FRONTEND = "http://localhost:5173";
const T0 = Date.parse("2026-11-16T12:00:00Z");

const uuid = () => crypto.randomUUID();
const hora = (n) => new Date(T0 + n * 60 * 60 * 1000).toISOString();

const ALUMNA = { userId: uuid(), googleId: "google-a", email: "alumna.cursos@example.test", sessionId: "sesion-cursos-a" };
const OTRO = { userId: uuid(), googleId: "google-b", email: "otro.cursos@example.test", sessionId: "sesion-cursos-b" };

function setup() {
  const db = createFakeSupabase();
  const logs = [];
  const app = createApp({
    config: {
      internalApiKey: API_KEY,
      credentialsEncryptionKey: CREDENTIALS_KEY,
      googleAuthSecret: SECRET,
      frontendUrl: FRONTEND,
    },
    supabase: db.client,
    logger: createLogger((line) => logs.push(line)),
    now: () => T0,
    channels: [],
  });

  for (const a of [ALUMNA, OTRO]) {
    db.tables.app_users.push({ id: a.userId, email: a.email });
    db.tables.google_authorizations.push({
      user_id: a.userId,
      google_id: a.googleId,
      email: a.email,
      scope: "s",
      refresh_token: "cifrado-secreto",
    });
    db.tables.google_app_sessions.push({
      id: sessionHash(a.sessionId),
      user_id: a.userId,
      google_id: a.googleId,
      expires_at: hora(2),
      revoked_at: null,
    });
  }
  return { db, app, logs };
}

function cookie({ userId, googleId, sessionId }, exp = T0 + 60 * 60 * 1000) {
  return `itn41_google_session=${encrypt({ userId, googleId, sessionId, exp }, SECRET, "google-session")}`;
}

async function guardarSnapshot(db, body) {
  const parsed = parseGradeSnapshotPayload(body, { now: T0 + 24 * 60 * 60 * 1000 });
  assert.equal(parsed.success, true, JSON.stringify(parsed.issues));
  return saveSnapshot(db.client, parsed.data);
}

function assertPrivateCourseErrorLogs(logs) {
  // This route emits exactly one technical error record, never row data.
  assert.equal(logs.length, 1);
  const { ts, ...fields } = JSON.parse(logs[0]);
  assert.equal(typeof ts, 'string');
  assert.equal(new Date(ts).toISOString(), ts);
  assert.deepEqual(fields, { level: 'error', event: 'error_no_controlado', error_code: 'XX000' });
}

describe("ITN-57 - autenticación y sesión revocada en /api/courses", () => {
  for (const ruta of ["/api/courses", `/api/courses/${uuid()}/items`]) {
    test(`GET ${ruta.replace(/[0-9a-f-]{36}/, ":id")} sin sesión responde 401 y Cache-Control: no-store`, async () => {
      const { app } = setup();
      const res = await request(app).get(ruta);
      assert.equal(res.status, 401);
      assert.equal(res.headers["cache-control"], "no-store");
      assert.deepEqual(res.body, { error: "no_autenticado" });
    });

    test(`GET ${ruta.replace(/[0-9a-f-]{36}/, ":id")} con sesión revocada (ITN-54) responde 401`, async () => {
      const { app, db } = setup();
      db.tables.google_app_sessions.find((s) => s.user_id === ALUMNA.userId).revoked_at = hora(-1);
      const res = await request(app).get(ruta).set("Cookie", cookie(ALUMNA));
      assert.equal(res.status, 401);
      assert.deepEqual(res.body, { error: "no_autenticado" });
    });
  }
});

describe("ITN-57 - GET /api/courses", () => {
  test("sin datos devuelve courses vacío y Cache-Control: no-store", async () => {
    const { app } = setup();
    const res = await request(app).get("/api/courses").set("Cookie", cookie(ALUMNA));
    assert.equal(res.status, 200);
    assert.equal(res.headers["cache-control"], "no-store");
    assert.deepEqual(res.body, { courses: [] });
  });

  test("combina el último snapshot de ivirtual, el último por semestre de itson_api y los cursos de classroom", async () => {
    const { app, db } = setup();

    // Snapshot viejo de iVirtual (con una materia dada de baja y calificación anterior).
    await guardarSnapshot(db, {
      run_id: uuid(),
      captured_at: hora(-5),
      source: "ivirtual",
      user: { email: ALUMNA.email },
      courses: [
        {
          externalId: "501",
          subject: "Ingeniería de Software",
          items: [
            { externalItemId: "9001", label: "Tarea 1", type: "mod", value: 80, text: "80.00", max: 100 },
            { externalItemId: "9006", label: null, type: "course", value: 80, text: "80.00", max: 100 },
          ],
        },
        {
          externalId: "599",
          subject: "Materia dada de baja",
          items: [{ externalItemId: "9999", label: null, type: "course", value: 70, text: "70.00" }],
        },
      ],
    });

    // Último snapshot de iVirtual: actualiza Ingeniería de Software y agrega Cálculo (aún sin total).
    await guardarSnapshot(db, {
      run_id: uuid(),
      captured_at: hora(-1),
      source: "ivirtual",
      user: { email: ALUMNA.email },
      courses: [
        {
          externalId: "501",
          subject: "Ingeniería de Software",
          items: [
            { externalItemId: "9001", label: "Tarea 1", type: "mod", value: 95.5, text: "95.50", max: 100 },
            { externalItemId: "9006", label: null, type: "course", value: 95.5, text: "95.50", max: 100 },
          ],
        },
        {
          externalId: "502",
          subject: "Cálculo Diferencial",
          items: [
            { externalItemId: "9101", label: "Tarea 1", type: "mod", value: null, text: "-", max: 100 },
            { externalItemId: "9102", label: null, type: "course", value: null, text: "-", max: 100 },
          ],
        },
      ],
    });

    // Snapshots de itson_api: semestre 04 y dos corridas del semestre 05 (incluyendo código literal "A" y "-").
    await guardarSnapshot(db, {
      run_id: uuid(),
      captured_at: hora(-4),
      source: "itson_api",
      period: "04",
      user: { email: ALUMNA.email },
      courses: [
        { externalId: "CAT-04", subject: "Estructura de Datos", items: [{ externalItemId: "CAT-04", text: "10" }] },
      ],
    });
    await guardarSnapshot(db, {
      run_id: uuid(),
      captured_at: hora(-3),
      source: "itson_api",
      period: "05",
      user: { email: ALUMNA.email },
      courses: [
        { externalId: "CAT-05A", subject: "Bases de Datos", items: [{ externalItemId: "CAT-05A", text: "-" }] },
        { externalId: "CAT-05B", subject: "Inglés", items: [{ externalItemId: "CAT-05B", text: "A" }] },
      ],
    });
    await guardarSnapshot(db, {
      run_id: uuid(),
      captured_at: hora(-2),
      source: "itson_api",
      period: "05",
      user: { email: ALUMNA.email },
      courses: [
        { externalId: "CAT-05A", subject: "Bases de Datos", items: [{ externalItemId: "CAT-05A", text: "9" }] },
        { externalId: "CAT-05B", subject: "Inglés", items: [{ externalItemId: "CAT-05B", text: "A" }] },
      ],
    });

    // Curso de Google Classroom.
    const classroomId = uuid();
    db.tables.classroom_courses.push({
      id: classroomId,
      user_id: ALUMNA.userId,
      external_course_id: "c-101",
      name: "Arquitectura de Software",
      section: "Grupo B",
      last_seen_at: hora(0),
      updated_at: hora(0),
      created_at: hora(-10),
    });

    const res = await request(app).get("/api/courses").set("Cookie", cookie(ALUMNA));
    assert.equal(res.status, 200);

    const cursos = res.body.courses;
    assert.equal(cursos.length, 6);
    assert.ok(cursos.every((c) => typeof c.id === "string" && c.id.length > 0));

    assert.deepEqual(
      cursos.map(({ name, source, period, finalGrade, updatedAt }) => ({ name, source, period, finalGrade, updatedAt })),
      [
        { name: "Cálculo Diferencial", source: "ivirtual", period: null, finalGrade: null, updatedAt: hora(-1) },
        { name: "Ingeniería de Software", source: "ivirtual", period: null, finalGrade: "95.5", updatedAt: hora(-1) },
        { name: "Arquitectura de Software", source: "classroom", period: "Grupo B", finalGrade: null, updatedAt: hora(0) },
        { name: "Bases de Datos", source: "itson_api", period: "05", finalGrade: "9", updatedAt: hora(-2) },
        { name: "Inglés", source: "itson_api", period: "05", finalGrade: "A", updatedAt: hora(-2) },
        { name: "Estructura de Datos", source: "itson_api", period: "04", finalGrade: "10", updatedAt: hora(-4) },
      ],
    );
  });

  test("finalGrade prefiere raw_payload.type === 'course' sobre otras filas sin nombre y usa grade_label null como respaldo", async () => {
    const { app, db } = setup();

    await guardarSnapshot(db, {
      run_id: uuid(),
      captured_at: hora(-1),
      source: "ivirtual",
      user: { email: ALUMNA.email },
      courses: [
        {
          externalId: "601",
          subject: "Redes de Computadoras",
          items: [
            // Una categoría o actividad sin nombre aparece antes del total real.
            { externalItemId: "1001", label: null, type: "category", value: 50, text: "50.00" },
            { externalItemId: "1002", label: null, type: "course", value: 92, text: "92.00" },
          ],
        },
        {
          externalId: "602",
          subject: "Sistemas Distribuidos",
          items: [
            // Respaldo: fila de total sin raw_payload.type pero con label null.
            { externalItemId: "2001", label: "Proyecto", type: "mod", value: 88, text: "88.00" },
            { externalItemId: "2002", label: null, type: null, value: 88, text: "88.00" },
          ],
        },
      ],
    });

    const res = await request(app).get("/api/courses").set("Cookie", cookie(ALUMNA));
    assert.equal(res.status, 200);
    assert.deepEqual(
      res.body.courses.map(({ name, finalGrade }) => ({ name, finalGrade })),
      [
        { name: "Redes de Computadoras", finalGrade: "92" },
        { name: "Sistemas Distribuidos", finalGrade: "88" },
      ],
    );
  });
});

describe("ITN-57 - GET /api/courses/:id/items", () => {
  test("devuelve las actividades de ivirtual del último snapshot con grade, maxGrade, dueAt y kind", async () => {
    const { app, db } = setup();

    // Snapshot anterior y snapshot actual con fechas de entrega (ITN-56 / migración 013).
    await guardarSnapshot(db, {
      run_id: uuid(),
      captured_at: hora(-2),
      source: "ivirtual",
      user: { email: ALUMNA.email },
      courses: [
        {
          externalId: "501",
          subject: "Ingeniería de Software",
          items: [
            { externalItemId: "9001", label: "Asignación 1", type: "mod", value: 70, text: "70.00", max: 100, dueAt: "2026-11-18T06:59:00.000Z" },
          ],
        },
      ],
    });

    await guardarSnapshot(db, {
      run_id: uuid(),
      captured_at: hora(-1),
      source: "ivirtual",
      user: { email: ALUMNA.email },
      courses: [
        {
          externalId: "501",
          subject: "Ingeniería de Software",
          items: [
            { externalItemId: "9001", label: "Asignación 1", type: "mod", value: 95, text: "95.00", max: 100, dueAt: "2026-11-20T06:59:00.000Z" },
            { externalItemId: "9002", label: "Examen Unidad 1", type: "mod", value: null, text: "-", max: 10, dueAt: null },
            { externalItemId: "9003", label: "Categoría Unidad 1", type: "category", value: 95, text: "95.00", max: 100 },
            { externalItemId: "9006", label: null, type: "course", value: 95, text: "95.00", max: 100 },
          ],
        },
      ],
    });

    const subject = db.tables.subjects.find((s) => s.user_id === ALUMNA.userId && s.name === "Ingeniería de Software");
    const res = await request(app).get(`/api/courses/${subject.id}/items`).set("Cookie", cookie(ALUMNA));
    assert.equal(res.status, 200);
    assert.equal(res.body.items.length, 2);
    assert.deepEqual(
      res.body.items.map(({ label, grade, maxGrade, dueAt, kind }) => ({ label, grade, maxGrade, dueAt, kind })),
      [
        { label: "Asignación 1", grade: 95, maxGrade: 100, dueAt: "2026-11-20T06:59:00.000Z", kind: "ivirtual" },
        { label: "Examen Unidad 1", grade: null, maxGrade: 10, dueAt: null, kind: "ivirtual" },
      ],
    );
  });

  test("devuelve las tareas de classroom con dueAt, maxGrade y kind classroom", async () => {
    const { app, db } = setup();
    const courseId = uuid();
    const tarea1Id = uuid();
    const tarea2Id = uuid();

    db.tables.classroom_courses.push({
      id: courseId,
      user_id: ALUMNA.userId,
      external_course_id: "c-200",
      name: "Métodos Numéricos",
      section: "01",
      last_seen_at: hora(0),
    });
    db.tables.classroom_coursework.push(
      {
        id: tarea1Id,
        user_id: ALUMNA.userId,
        course_id: courseId,
        external_coursework_id: "cw-1",
        title: "Práctica 1: Newton-Raphson",
        due_at: "2026-11-21T06:59:00.000Z",
        max_points: 100,
      },
      {
        id: tarea2Id,
        user_id: ALUMNA.userId,
        course_id: courseId,
        external_coursework_id: "cw-2",
        title: "Lectura complementaria",
        due_at: null,
        max_points: null,
      },
    );

    const res = await request(app).get(`/api/courses/${courseId}/items`).set("Cookie", cookie(ALUMNA));
    assert.equal(res.status, 200);
    assert.deepEqual(res.body, {
      items: [
        {
          id: tarea1Id,
          label: "Práctica 1: Newton-Raphson",
          grade: null,
          maxGrade: 100,
          dueAt: "2026-11-21T06:59:00.000Z",
          kind: "classroom",
          // ITN-58b: campo nuevo, aditivo.
          source: "classroom",
        },
        {
          id: tarea2Id,
          label: "Lectura complementaria",
          grade: null,
          maxGrade: null,
          dueAt: null,
          kind: "classroom",
          source: "classroom",
        },
      ],
    });
  });

  test("una materia de itson_api responde 200 con items vacío", async () => {
    const { app, db } = setup();
    await guardarSnapshot(db, {
      run_id: uuid(),
      captured_at: hora(-1),
      source: "itson_api",
      period: "05",
      user: { email: ALUMNA.email },
      courses: [{ externalId: "CAT-1", subject: "Sistemas Operativos", items: [{ externalItemId: "CAT-1", text: "10" }] }],
    });

    const subject = db.tables.subjects.find((s) => s.user_id === ALUMNA.userId && s.name === "Sistemas Operativos");
    const res = await request(app).get(`/api/courses/${subject.id}/items`).set("Cookie", cookie(ALUMNA));
    assert.equal(res.status, 200);
    assert.deepEqual(res.body, { items: [] });
  });

  test("un id que no es uuid responde 400 sin consultar cursos", async () => {
    const { app, db } = setup();
    db.calls.length = 0;
    const res = await request(app).get("/api/courses/no-es-uuid/items").set("Cookie", cookie(ALUMNA));
    assert.equal(res.status, 400);
    assert.deepEqual(res.body, { error: "id_invalido" });
    assert.equal(db.calls.some((c) => c.table === "subjects" || c.table === "classroom_courses"), false);
  });

  test("un curso inexistente responde 404", async () => {
    const { app } = setup();
    const res = await request(app).get(`/api/courses/${uuid()}/items`).set("Cookie", cookie(ALUMNA));
    assert.equal(res.status, 404);
    assert.deepEqual(res.body, { error: "no_encontrado" });
  });
});

describe("ITN-57 - aislamiento entre alumnos y privacidad de logs", () => {
  test('la validación estructural permite milisegundos con 88 y rechaza datos sensibles', () => {
    // Actual shape observed when the old substring assertion failed on .488Z.
    const safe = { ts: '2026-11-17T18:56:58.488Z', level: 'error', event: 'error_no_controlado', error_code: 'XX000' };
    assertPrivateCourseErrorLogs([JSON.stringify(safe)]);
    for (const leak of [
      { email: ALUMNA.email },
      { subject: 'QuímicaReservada' },
      { label: 'LaboratorioReservado' },
      { grade: 88 },
      { grade: '88' },
      { grade_text: '88.00' },
      { body: { items: [{ value: 88 }] } },
      { error_code: 88 },
      { error_code: '88' },
      { event: `error_no_controlado ${ALUMNA.email}` },
      { ts: '88' },
    ]) {
      assert.throws(() => assertPrivateCourseErrorLogs([JSON.stringify({ ...safe, ...leak })]));
    }
    assert.throws(() => assertPrivateCourseErrorLogs([]));
    assert.throws(() => assertPrivateCourseErrorLogs([JSON.stringify(safe), JSON.stringify({ grade: 88 })]));
  });
  test("un alumno nunca ve cursos ni actividades de otro alumno (404 al pedir su curso)", async () => {
    const { app, db, logs } = setup();

    await guardarSnapshot(db, {
      run_id: uuid(),
      captured_at: hora(-1),
      source: "ivirtual",
      user: { email: OTRO.email },
      courses: [
        {
          externalId: "801",
          subject: "Materia Secreta Otro",
          items: [{ externalItemId: "1", label: "Actividad Secreta", type: "mod", value: 99, text: "99.00", max: 100 }],
        },
      ],
    });
    const cursoClassroomOtro = uuid();
    db.tables.classroom_courses.push({
      id: cursoClassroomOtro,
      user_id: OTRO.userId,
      external_course_id: "c-ajeno",
      name: "Classroom Secreto Otro",
      section: "A",
      last_seen_at: hora(0),
    });
    db.tables.classroom_coursework.push({
      id: uuid(),
      user_id: OTRO.userId,
      course_id: cursoClassroomOtro,
      external_coursework_id: "cw-ajeno",
      title: "Tarea Secreta Otro",
      due_at: null,
      max_points: 50,
    });

    const subjectOtro = db.tables.subjects.find((s) => s.user_id === OTRO.userId);

    const lista = await request(app).get("/api/courses").set("Cookie", cookie(ALUMNA));
    assert.equal(lista.status, 200);
    assert.deepEqual(lista.body, { courses: [] });

    for (const idAjeno of [subjectOtro.id, cursoClassroomOtro]) {
      const items = await request(app).get(`/api/courses/${idAjeno}/items`).set("Cookie", cookie(ALUMNA));
      assert.equal(items.status, 404);
      assert.deepEqual(items.body, { error: "no_encontrado" });
    }

    const textoLogs = logs.join("\n");
    for (const secreto of [ALUMNA.email, OTRO.email, "Materia Secreta Otro", "Actividad Secreta", "99"]) {
      assert.equal(textoLogs.includes(secreto), false);
    }
  });

  test("funciona aunque falten las migraciones 012 (period) o 013 (due_at) y no filtra datos en logs ante error 500", async () => {
    const { app, db, logs } = setup();
    await guardarSnapshot(db, {
      run_id: uuid(),
      captured_at: hora(-1),
      source: "ivirtual",
      user: { email: ALUMNA.email },
      courses: [
        {
          externalId: "501",
          subject: "QuímicaReservada",
          items: [{ externalItemId: "9001", label: "LaboratorioReservado", type: "mod", value: 88, text: "88.00", max: 100 }],
        },
      ],
    });

    db.withoutColumn("grade_snapshots", "period");
    db.withoutColumn("snapshot_grades", "due_at");

    const cursos = await request(app).get("/api/courses").set("Cookie", cookie(ALUMNA));
    assert.equal(cursos.status, 200);
    assert.equal(cursos.body.courses.length, 1);

    const subjectId = cursos.body.courses[0].id;
    const items = await request(app).get(`/api/courses/${subjectId}/items`).set("Cookie", cookie(ALUMNA));
    assert.equal(items.status, 200);
    assert.equal(items.body.items[0].dueAt, null);
    assert.equal(items.body.items[0].grade, 88);

    // Fallo de base de datos: 500 genérico y el log no expone materias, notas ni correos.
    db.failNext("grade_snapshots", "select");
    const fallo = await request(app).get("/api/courses").set("Cookie", cookie(ALUMNA));
    assert.equal(fallo.status, 500);
    assert.deepEqual(fallo.body, { error: "error_interno" });

    assertPrivateCourseErrorLogs(logs);
  });
});
