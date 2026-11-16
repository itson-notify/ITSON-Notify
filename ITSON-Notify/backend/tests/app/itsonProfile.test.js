// ITN-55 - /api/itson-profile con supertest y el Supabase simulado. Datos
// inventados: ningún correo ni matrícula es real.
const { test, describe } = require("node:test");
const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const request = require("supertest");

const { createApp } = require("../../src/app");
const { createLogger } = require("../../src/utils/logger");
const { sessionHash } = require("../../src/middleware/studentSession");
const { encrypt } = require("../../src/utils/secureToken");
const { verificarMatriculaConCorreo, pistaMatricula } = require("../../src/models/itsonProfile");
const { SAVE_ATTEMPTS } = require("../../src/routes/itsonProfile");
const { createFakeSupabase } = require("../helpers/fakeSupabase");
const { API_KEY, CREDENTIALS_KEY } = require("../helpers/payloads");

const SECRET = "clave-de-pruebas-perfil-itson-".repeat(2);
const FRONTEND = "http://localhost:5173";
const T0 = Date.parse("2026-11-13T12:00:00Z");
const RUTA = "/api/itson-profile";

const uuid = () => crypto.randomUUID();
const alumno = (nombre, email) => ({ userId: uuid(), googleId: `google-${nombre}`, email, sessionId: `sesion-${nombre}` });
const ALUMNA = alumno("a", "alumna.prueba123456@potros.itson.edu.mx");
const OTRO = alumno("b", "otro.prueba654321@potros.itson.edu.mx");
const SIN_DIGITOS = alumno("c", "sin.digitos@potros.itson.edu.mx");
const GMAIL = alumno("d", "alumna.prueba123456@gmail.com");
const REVOCADA = alumno("e", "revocada.prueba111111@potros.itson.edu.mx");

const MATRICULA = "00000123456";
const MATRICULA_OTRO = "00000654321";
const CARRERA = "INSOF";

function cookie({ userId, googleId, sessionId }, exp = T0 + 60 * 60 * 1000) {
  return `itn41_google_session=${encrypt({ userId, googleId, sessionId, exp }, SECRET, "google-session")}`;
}

function setup({ clock } = {}) {
  const db = createFakeSupabase();
  const logs = [];
  const reloj = clock ?? { t: T0 };
  const app = createApp({
    config: { internalApiKey: API_KEY, credentialsEncryptionKey: CREDENTIALS_KEY, googleAuthSecret: SECRET, frontendUrl: FRONTEND },
    supabase: db.client,
    logger: createLogger((line) => logs.push(line)),
    now: () => reloj.t,
    channels: [],
  });
  for (const a of [ALUMNA, OTRO, SIN_DIGITOS, GMAIL, REVOCADA]) {
    db.tables.app_users.push({ id: a.userId, email: a.email });
    db.tables.google_app_sessions.push({
      id: sessionHash(a.sessionId), user_id: a.userId, google_id: a.googleId,
      expires_at: new Date(T0 + 24 * 60 * 60 * 1000).toISOString(),
      revoked_at: a === REVOCADA ? new Date(T0 - 1000).toISOString() : null,
    });
  }
  const conSesion = (req, quien) => (quien ? req.set("Cookie", cookie(quien)) : req);
  return {
    db, logs, reloj, app,
    leer: (quien = ALUMNA) => conSesion(request(app).get(RUTA), quien),
    guardar: (body = { matricula: MATRICULA, career: CARRERA }, quien = ALUMNA) =>
      conSesion(request(app).put(RUTA).set("Origin", FRONTEND), quien).send(body),
    borrar: (quien = ALUMNA) => conSesion(request(app).delete(RUTA).set("Origin", FRONTEND), quien),
  };
}

const perfiles = (db, quien) => db.tables.student_itson_profiles.filter((p) => p.user_id === quien.userId);

// Ninguna forma de la matrícula, la carrera ni el correo en un texto.
function assertSinDatos(texto) {
  for (const valor of [MATRICULA, "123456", MATRICULA_OTRO, "654321", ALUMNA.email, OTRO.email]) {
    for (const forma of [valor, Buffer.from(valor).toString("hex"), Buffer.from(valor).toString("base64")]) {
      assert.ok(!texto.includes(forma), "apareció un dato sensible");
    }
  }
}

describe("sesión y Origin", () => {
  test("401 sin sesión en GET y en PUT", async () => {
    const { leer, guardar, db } = setup();
    assert.equal((await leer(null)).status, 401);
    const res = await guardar(undefined, null);
    assert.equal(res.status, 401);
    assert.deepEqual(res.body, { error: "no_autenticado" });
    assert.equal(db.tables.student_itson_profiles.length, 0);
  });

  test("401 con una sesión revocada (ITN-54)", async () => {
    const { leer, guardar } = setup();
    assert.equal((await leer(REVOCADA)).status, 401);
    assert.equal((await guardar({ matricula: "00000111111", career: CARRERA }, REVOCADA)).status, 401);
  });

  test("403 en PUT y DELETE sin el Origin exacto, sin escribir", async () => {
    const { app, db } = setup();
    for (const origin of [undefined, "https://otro.example.test"]) {
      let put = request(app).put(RUTA).set("Cookie", cookie(ALUMNA));
      let del = request(app).delete(RUTA).set("Cookie", cookie(ALUMNA));
      if (origin) {
        put = put.set("Origin", origin);
        del = del.set("Origin", origin);
      }
      assert.equal((await put.send({ matricula: MATRICULA, career: CARRERA })).status, 403);
      assert.equal((await del).status, 403);
    }
    assert.equal(db.tables.student_itson_profiles.length, 0);
  });

  test("Cache-Control: no-store", async () => {
    const { leer } = setup();
    assert.equal((await leer()).headers["cache-control"], "no-store");
  });
});

describe("GET y PUT", () => {
  test("sin perfil: configured false", async () => {
    const { leer } = setup();
    const res = await leer();
    assert.equal(res.status, 200);
    assert.deepEqual(res.body, { configured: false, matriculaHint: null, career: null, updatedAt: null });
  });

  test("guarda cifrado, normaliza la carrera y GET solo da la pista", async () => {
    const { guardar, leer, db } = setup();
    const res = await guardar({ matricula: MATRICULA, career: " insof " });
    assert.equal(res.status, 200);
    assert.equal(res.body.configured, true);
    assert.equal(res.body.matriculaHint, pistaMatricula(MATRICULA));
    assert.equal(res.body.career, CARRERA);
    assert.ok(res.body.updatedAt);

    const [fila] = perfiles(db, ALUMNA);
    assert.equal(fila.career, CARRERA);
    assert.equal(fila.key_version, 1);
    assertSinDatos(JSON.stringify(db.tables.student_itson_profiles));

    const lectura = await leer();
    assert.deepEqual(lectura.body, res.body);
    assertSinDatos(JSON.stringify(lectura.body));
  });

  test("un userId o email en el body se descarta: siempre la cuenta de la sesión", async () => {
    const { guardar, db } = setup();
    const res = await guardar({ matricula: MATRICULA, career: CARRERA, userId: OTRO.userId, email: OTRO.email, user: { email: OTRO.email } });
    assert.equal(res.status, 200);
    assert.equal(perfiles(db, ALUMNA).length, 1);
    assert.equal(perfiles(db, OTRO).length, 0);
  });

  test("volver a guardar reemplaza el perfil", async () => {
    const { guardar, db } = setup();
    await guardar();
    await guardar({ matricula: MATRICULA, career: "LCE" });
    assert.equal(perfiles(db, ALUMNA).length, 1);
    assert.equal(perfiles(db, ALUMNA)[0].career, "LCE");
  });

  test("un ciphertext copiado a otro alumno no se descifra (AAD)", async () => {
    const { guardar, leer, db } = setup();
    await guardar();
    db.tables.student_itson_profiles.push({ ...perfiles(db, ALUMNA)[0], id: uuid(), user_id: OTRO.userId });
    const res = await leer(OTRO);
    assert.equal(res.status, 500);
    assert.deepEqual(res.body, { error: "error_interno" });
  });
});

describe("regla del correo institucional", () => {
  test("la matrícula de otro alumno: 400 matricula_no_coincide, sin guardar ni citar el valor", async () => {
    const { guardar, db, logs } = setup();
    const res = await guardar({ matricula: MATRICULA_OTRO, career: CARRERA });
    assert.equal(res.status, 400);
    assert.deepEqual(res.body, { error: "matricula_no_coincide" });
    assert.equal(db.tables.student_itson_profiles.length, 0);
    assertSinDatos(JSON.stringify(res.body) + logs.join("\n"));
  });

  test("correo sin dígitos: 400 correo_sin_matricula", async () => {
    const { guardar, db } = setup();
    const res = await guardar({ matricula: MATRICULA, career: CARRERA }, SIN_DIGITOS);
    assert.equal(res.status, 400);
    assert.deepEqual(res.body, { error: "correo_sin_matricula" });
    assert.equal(db.tables.student_itson_profiles.length, 0);
  });

  test("correo de Gmail aunque termine con los dígitos: 400 correo_no_institucional", async () => {
    const { guardar, db } = setup();
    const res = await guardar({ matricula: MATRICULA, career: CARRERA }, GMAIL);
    assert.equal(res.status, 400);
    assert.deepEqual(res.body, { error: "correo_no_institucional" });
    assert.equal(db.tables.student_itson_profiles.length, 0);
  });

  test("verificarMatriculaConCorreo", () => {
    const v = verificarMatriculaConCorreo;
    assert.equal(v("00000252587", "nombre.apellido252587@potros.itson.edu.mx"), null);
    assert.equal(v("00000252587", "NOMBRE.Apellido252587@POTROS.ITSON.EDU.MX"), null);
    assert.equal(v("00000252587", "nombre1252587@potros.itson.edu.mx"), null); // 7 dígitos: se comparan los últimos 6
    assert.equal(v("00000252587", "nombre.apellido252588@potros.itson.edu.mx"), "matricula_no_coincide");
    assert.equal(v("00000252587", "nombre.apellido@potros.itson.edu.mx"), "correo_sin_matricula");
    assert.equal(v("00000252587", "nombre52587@potros.itson.edu.mx"), "correo_sin_matricula"); // solo 5
    assert.equal(v("00000252587", "nombre252587.x@potros.itson.edu.mx"), "correo_sin_matricula"); // no al final
    assert.equal(v("00000252587", "nombre252587@gmail.com"), "correo_no_institucional");
    assert.equal(v("00000252587", "nombre252587@itson.edu.mx.example.test"), "correo_no_institucional");
    assert.equal(v("00000252587", null), "correo_no_institucional");
  });
});

describe("validación y límites", () => {
  test("400 cuerpo_invalido con formatos inválidos, sin citar el valor", async () => {
    const { guardar, db } = setup();
    const casos = [
      { matricula: "123456", career: CARRERA },
      { matricula: "00001123456", career: CARRERA },
      { matricula: "0000012345A", career: CARRERA },
      { matricula: MATRICULA, career: "IN" + "1" },
      { matricula: MATRICULA, career: "DEMASIADOLARGA" },
      { matricula: MATRICULA },
      {},
    ];
    for (const body of casos) {
      const res = await guardar(body);
      assert.equal(res.status, 400);
      assert.equal(res.body.error, "cuerpo_invalido");
      assertSinDatos(JSON.stringify(res.body));
    }
    assert.equal(db.tables.student_itson_profiles.length, 0);
  });

  test("413 con más de 4 KB", async () => {
    const { guardar } = setup();
    const res = await guardar({ matricula: MATRICULA, career: CARRERA, relleno: "x".repeat(5000) });
    assert.equal(res.status, 413);
  });

  test(`429 después de ${SAVE_ATTEMPTS} intentos (también cuentan los 400), con Retry-After`, async () => {
    const { guardar, reloj } = setup();
    for (let i = 0; i < SAVE_ATTEMPTS; i += 1) {
      assert.equal((await guardar({ matricula: MATRICULA_OTRO, career: CARRERA })).status, 400);
    }
    const res = await guardar();
    assert.equal(res.status, 429);
    assert.deepEqual(res.body, { error: "demasiados_intentos" });
    assert.ok(Number(res.headers["retry-after"]) > 0);

    reloj.t += 15 * 60 * 1000 + 1;
    assert.equal((await guardar()).status, 200);
  });

  test("el límite es por alumno", async () => {
    const { guardar } = setup();
    for (let i = 0; i < SAVE_ATTEMPTS; i += 1) await guardar({ matricula: MATRICULA_OTRO, career: CARRERA });
    assert.equal((await guardar({ matricula: MATRICULA_OTRO, career: CARRERA }, OTRO)).status, 200);
  });
});

describe("DELETE", () => {
  test("204 y luego 404; solo borra el perfil propio", async () => {
    const { guardar, borrar, db } = setup();
    await guardar();
    await guardar({ matricula: MATRICULA_OTRO, career: CARRERA }, OTRO);
    assert.equal((await borrar()).status, 204);
    assert.equal(perfiles(db, ALUMNA).length, 0);
    assert.equal(perfiles(db, OTRO).length, 1);
    const res = await borrar();
    assert.equal(res.status, 404);
    assert.deepEqual(res.body, { error: "no_encontrado" });
  });
});

describe("privacidad de los logs", () => {
  test("ningún flujo registra matrícula, carrera ni correo", async () => {
    const { guardar, leer, borrar, logs } = setup();
    await guardar();
    await guardar({ matricula: MATRICULA_OTRO, career: CARRERA });
    await guardar({ matricula: "mal", career: CARRERA });
    await leer();
    await borrar();
    const texto = logs.join("\n");
    assertSinDatos(texto);
    assert.ok(!texto.includes(CARRERA));
    assert.ok(texto.includes("perfil_itson_guardado"));
    assert.ok(texto.includes("matricula_no_coincide"));
  });
});
