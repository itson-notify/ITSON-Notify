// ITN-51 - /api/credentials/ivirtual con supertest, el Supabase simulado y un doble
// del puerto exchangeToken (la llamada real a iVirtual es de ITN-52). Datos
// inventados; la contraseña y el token se arman en tiempo de ejecución.
const { test, describe } = require("node:test");
const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const request = require("supertest");

const { createApp } = require("../../src/app");
const { createLogger } = require("../../src/utils/logger");
const { sessionHash } = require("../../src/middleware/studentSession");
const { encrypt } = require("../../src/utils/secureToken");
const { createAttemptLimiter, LINK_ATTEMPTS, LINK_WINDOW_MS } = require("../../src/routes/studentCredentials");
const { createFakeSupabase } = require("../helpers/fakeSupabase");
const { API_KEY, CREDENTIALS_KEY } = require("../helpers/payloads");

const SECRET = "clave-de-pruebas-api-alumno-".repeat(2);
const FRONTEND = "http://localhost:5173";
const T0 = Date.parse("2026-11-10T12:00:00Z");
const RUTA = "/api/credentials/ivirtual";

const PASSWORD = ["Contra", "sena", "Prueba", "91z"].join("-");
const TOKEN = ["token", "ivirtual", "prueba", "a".repeat(32)].join("");
const USUARIO = "usuario.prueba";

const uuid = () => crypto.randomUUID();
const ALUMNA = { userId: uuid(), googleId: "google-a", email: "alumna@example.test", sessionId: "sesion-a" };
const OTRO = { userId: uuid(), googleId: "google-b", email: "otro@example.test", sessionId: "sesion-b" };

// `exchange` es el doble del puerto: por defecto devuelve TOKEN. Con
// `exchange: null` el puerto no se inyecta, como en producción antes de ITN-52.
function setup({ exchange = async () => TOKEN, clock } = {}) {
  const db = createFakeSupabase();
  const logs = [];
  const llamadas = [];
  const reloj = clock ?? { t: T0 };
  const now = () => reloj.t;
  const app = createApp({
    config: { internalApiKey: API_KEY, credentialsEncryptionKey: CREDENTIALS_KEY, googleAuthSecret: SECRET, frontendUrl: FRONTEND },
    supabase: db.client,
    logger: createLogger((line) => logs.push(line)),
    now,
    channels: [],
    exchangeToken: exchange === null ? undefined : async (entrada) => {
      llamadas.push(entrada);
      return exchange(entrada);
    },
  });
  for (const a of [ALUMNA, OTRO]) {
    db.tables.app_users.push({ id: a.userId, email: a.email });
    db.tables.google_app_sessions.push({
      id: sessionHash(a.sessionId), user_id: a.userId, google_id: a.googleId,
      expires_at: new Date(T0 + 24 * 60 * 60 * 1000).toISOString(),
    });
  }
  const conSesion = (req, alumno) => (alumno ? req.set("Cookie", cookie(alumno)) : req);
  return {
    db, app, logs, llamadas, reloj,
    leer: (alumno = ALUMNA) => conSesion(request(app).get(RUTA), alumno),
    vincular: (body = { username: USUARIO, password: PASSWORD }, alumno = ALUMNA) =>
      conSesion(request(app).put(RUTA).set("Origin", FRONTEND), alumno).send(body),
    desvincular: (alumno = ALUMNA) => conSesion(request(app).delete(RUTA).set("Origin", FRONTEND), alumno),
  };
}

function cookie({ userId, googleId, sessionId }, exp = T0 + 60 * 60 * 1000) {
  return `itn41_google_session=${encrypt({ userId, googleId, sessionId, exp }, SECRET, "google-session")}`;
}

const filas = (db, alumno) => db.tables.student_credentials.filter((c) => c.user_id === alumno.userId);

// El texto en claro y codificado de las formas en que podría filtrarse.
function assertSin(texto, valor, nombre) {
  for (const forma of [valor, Buffer.from(valor).toString("hex"), Buffer.from(valor).toString("base64")]) {
    assert.ok(!texto.includes(forma), `apareció ${nombre}`);
  }
}
function assertSinSensibles(texto) {
  assertSin(texto, PASSWORD, "la contraseña");
  assertSin(texto, TOKEN, "el token");
  assert.ok(!texto.includes(ALUMNA.email) && !texto.includes(OTRO.email), "apareció un correo");
}

// Todo lo que vio el cliente: status, headers y body.
const respuesta = (res) => JSON.stringify({ status: res.status, headers: res.headers, body: res.body, text: res.text });

describe("sin sesión", () => {
  test("GET, PUT y DELETE responden 401 sin tocar credenciales ni llamar al puerto", async () => {
    const { leer, vincular, desvincular, db, llamadas } = setup();
    for (const res of [await leer(null), await vincular(undefined, null), await desvincular(null)]) {
      assert.equal(res.status, 401);
      assert.deepEqual(res.body, { error: "no_autenticado" });
    }
    assert.equal(llamadas.length, 0);
    assert.ok(!db.calls.some((c) => c.table === "student_credentials"));
  });

  test("una cookie vencida o de una sesión cerrada responde 401", async () => {
    const { app, db } = setup();
    const vencida = await request(app).get(RUTA).set("Cookie", cookie(ALUMNA, T0 - 1));
    assert.equal(vencida.status, 401);
    db.tables.google_app_sessions = db.tables.google_app_sessions.filter((s) => s.user_id !== ALUMNA.userId);
    assert.equal((await request(app).get(RUTA).set("Cookie", cookie(ALUMNA))).status, 401);
  });
});

describe("GET /api/credentials/ivirtual", () => {
  test("sin vincular: linked false, status y fecha null, y available según el puerto", async () => {
    const con = setup();
    const res = await con.leer();
    assert.equal(res.status, 200);
    assert.deepEqual(res.body, { available: true, linked: false, status: null, lastValidatedAt: null });
    assert.equal(res.headers["cache-control"], "no-store");

    const sin = setup({ exchange: null });
    assert.equal((await sin.leer()).body.available, false);
  });

  test("vinculada: devuelve estado y fecha, nunca el secreto ni los campos cifrados", async () => {
    const { leer, vincular, db } = setup();
    await vincular();
    const fila = filas(db, ALUMNA)[0];
    fila.last_validated_at = new Date(T0).toISOString();

    const res = await leer();
    assert.deepEqual(res.body, {
      available: true, linked: true, status: "active", lastValidatedAt: new Date(T0).toISOString(),
    });
    assertSinSensibles(respuesta(res));
    for (const campo of [fila.ciphertext, fila.nonce, fila.auth_tag]) assert.ok(!res.text.includes(campo.slice(2)));

    fila.status = "needs_relink";
    assert.equal((await leer()).body.status, "needs_relink");
  });

  test("lee solo status y fecha: no selecciona los campos cifrados", async () => {
    const { leer, vincular, db } = setup();
    await vincular();
    const original = db.client.from;
    const columnas = [];
    db.client.from = (tabla) => {
      const q = original(tabla);
      const select = q.select.bind(q);
      q.select = (cols) => { if (tabla === "student_credentials") columnas.push(cols); return select(cols); };
      return q;
    };
    await leer();
    assert.deepEqual(columnas, ["status,last_validated_at"]);
  });
});

describe("PUT /api/credentials/ivirtual", () => {
  test("cambia usuario y contraseña por un token y lo guarda cifrado para el alumno de la sesión", async () => {
    const { vincular, db, llamadas } = setup();
    const res = await vincular();

    assert.equal(res.status, 200);
    assert.deepEqual(res.body, { available: true, linked: true, status: "active", lastValidatedAt: null });
    assert.deepEqual(llamadas, [{ username: USUARIO, password: PASSWORD }]);

    const [fila] = filas(db, ALUMNA);
    assert.equal(db.tables.student_credentials.length, 1);
    assert.equal(fila.portal, "ivirtual");
    assert.equal(fila.kind, "ivirtual_token");
    assert.equal(fila.status, "active");
    // Ni la contraseña ni el token quedan en claro en la fila.
    assertSinSensibles(JSON.stringify(fila));
    assert.ok(!Buffer.from(fila.ciphertext.slice(2), "hex").includes(Buffer.from(TOKEN)));
    assert.ok(!Object.keys(fila).some((c) => /password|secret|token/.test(c)));
  });

  test("ignora cualquier id o correo del body: siempre guarda para req.student.userId", async () => {
    const { vincular, db, llamadas } = setup();
    const res = await vincular({
      username: USUARIO, password: PASSWORD,
      userId: OTRO.userId, user_id: OTRO.userId, email: OTRO.email, user: { email: OTRO.email },
    });
    assert.equal(res.status, 200);
    assert.equal(filas(db, OTRO).length, 0);
    assert.equal(filas(db, ALUMNA).length, 1);
    assert.deepEqual(Object.keys(llamadas[0]).sort(), ["password", "username"]);
  });

  test("recorta el usuario pero manda la contraseña tal cual", async () => {
    const { vincular, llamadas } = setup();
    const conEspacios = `  ${PASSWORD}  `;
    await vincular({ username: `  ${USUARIO}  `, password: conEspacios });
    assert.deepEqual(llamadas[0], { username: USUARIO, password: conEspacios });
  });

  test("volver a vincular reemplaza el token y reactiva una cuenta en needs_relink", async () => {
    const { vincular, db } = setup();
    await vincular();
    const [fila] = filas(db, ALUMNA);
    const nonce = fila.nonce;
    fila.status = "needs_relink";
    fila.last_validated_at = new Date(T0).toISOString();

    const res = await vincular();
    assert.equal(res.body.status, "active");
    assert.equal(filas(db, ALUMNA).length, 1);
    assert.notEqual(filas(db, ALUMNA)[0].nonce, nonce);
    assert.equal(filas(db, ALUMNA)[0].last_validated_at, null);
  });

  test("sin puerto responde 501 vinculacion_no_disponible y no guarda nada", async () => {
    const { vincular, db, logs } = setup({ exchange: null });
    const res = await vincular();
    assert.equal(res.status, 501);
    assert.deepEqual(res.body, { error: "vinculacion_no_disponible" });
    assert.equal(db.tables.student_credentials.length, 0);
    assertSinSensibles(respuesta(res) + logs.join("\n"));
  });

  test("si iVirtual rechaza las credenciales responde 422 sin guardar", async () => {
    const { vincular, db } = setup({ exchange: async () => null });
    const res = await vincular();
    assert.equal(res.status, 422);
    assert.deepEqual(res.body, { error: "credenciales_rechazadas" });
    assert.equal(db.tables.student_credentials.length, 0);
  });

  test("si el puerto lanza o devuelve un token inválido responde 502 genérico", async () => {
    for (const exchange of [
      async ({ password }) => {
        const error = new Error(`login fallido para ${password} con ${TOKEN}`);
        error.code = password;
        error.step = TOKEN;
        throw error;
      },
      async () => "",
      async () => "   ",
      async () => ({ token: TOKEN }),
      async () => "x".repeat(4097),
    ]) {
      const { vincular, db, logs } = setup({ exchange });
      const res = await vincular();
      assert.equal(res.status, 502);
      assert.deepEqual(res.body, { error: "portal_no_disponible" });
      assert.equal(db.tables.student_credentials.length, 0);
      assertSinSensibles(respuesta(res) + logs.join("\n"));
    }
  });

  test("400 en cuerpos inválidos, sin llamar al puerto ni devolver los valores", async () => {
    const { vincular, llamadas, db } = setup();
    const invalidos = [
      {},
      { username: USUARIO },
      { password: PASSWORD },
      { username: "", password: PASSWORD },
      { username: "   ", password: PASSWORD },
      { username: "u".repeat(65), password: PASSWORD },
      { username: USUARIO, password: "" },
      { username: USUARIO, password: `${PASSWORD}${"p".repeat(256)}` },
      { username: USUARIO, password: 12345 },
      { username: PASSWORD, password: { valor: PASSWORD } },
      [PASSWORD],
    ];
    for (const body of invalidos) {
      const res = await vincular(body);
      assert.equal(res.status, 400, JSON.stringify(Object.keys(body)));
      assert.equal(res.body.error, "cuerpo_invalido");
      assertSinSensibles(respuesta(res));
    }
    assert.equal(llamadas.length, 0);
    assert.equal(db.tables.student_credentials.length, 0);
  });

  test("acepta usuario de 64 y contraseña de 256 caracteres", async () => {
    const { vincular } = setup();
    assert.equal((await vincular({ username: "u".repeat(64), password: "p".repeat(256) })).status, 200);
  });

  test("JSON mal formado con la contraseña responde 400 genérico sin citarla", async () => {
    const { app, logs, llamadas } = setup();
    for (const crudo of [
      `{"username":"${USUARIO}","password":"${PASSWORD}"`,
      `{"username":"${USUARIO}","password":${PASSWORD}}`,
      `${PASSWORD}`,
    ]) {
      const res = await request(app).put(RUTA).set("Origin", FRONTEND).set("Cookie", cookie(ALUMNA))
        .set("Content-Type", "application/json").send(crudo);
      assert.equal(res.status, 400);
      assert.deepEqual(res.body, { error: "cuerpo_invalido" });
      assertSinSensibles(respuesta(res));
    }
    assertSinSensibles(logs.join("\n"));
    assert.equal(llamadas.length, 0);
  });

  test("un body de más de 8 KB responde 413 sin copiarlo", async () => {
    const { vincular, logs, llamadas } = setup();
    const res = await vincular({ username: USUARIO, password: `${PASSWORD}${"x".repeat(8 * 1024)}` });
    assert.equal(res.status, 413);
    assert.deepEqual(res.body, { error: "cuerpo_demasiado_grande" });
    assertSinSensibles(respuesta(res) + logs.join("\n"));
    assert.equal(llamadas.length, 0);
  });
});

describe("DELETE /api/credentials/ivirtual", () => {
  test("borra la fila del alumno y responde 204; el alumno sigue existiendo", async () => {
    const { vincular, desvincular, leer, db } = setup();
    await vincular();
    const res = await desvincular();
    assert.equal(res.status, 204);
    assert.equal(filas(db, ALUMNA).length, 0);
    assert.ok(db.tables.app_users.some((u) => u.id === ALUMNA.userId));
    assert.equal((await leer()).body.linked, false);
  });

  test("404 si no había credencial", async () => {
    const { desvincular } = setup();
    const res = await desvincular();
    assert.equal(res.status, 404);
    assert.deepEqual(res.body, { error: "no_encontrado" });
  });

  test("ignora un id o correo en el body", async () => {
    const { vincular, app, db } = setup();
    await vincular(undefined, OTRO);
    const res = await request(app).delete(RUTA).set("Origin", FRONTEND).set("Cookie", cookie(ALUMNA))
      .send({ userId: OTRO.userId, email: OTRO.email });
    assert.equal(res.status, 404);
    assert.equal(filas(db, OTRO).length, 1);
  });
});

describe("aislamiento entre alumnos", () => {
  test("un alumno no puede leer, vincular ni borrar la cuenta de otro", async () => {
    const { vincular, leer, desvincular, db } = setup();
    await vincular(undefined, OTRO);
    const fila = filas(db, OTRO)[0];
    const copia = { ...fila };

    // Leer: la alumna ve solo su estado.
    assert.equal((await leer(ALUMNA)).body.linked, false);
    // Borrar: no toca la fila del otro.
    assert.equal((await desvincular(ALUMNA)).status, 404);
    // Vincular: crea la suya y deja intacta la del otro.
    await vincular({ username: USUARIO, password: PASSWORD, userId: OTRO.userId }, ALUMNA);
    assert.deepEqual(filas(db, OTRO)[0], copia);
    assert.equal(filas(db, ALUMNA).length, 1);
    assert.equal((await leer(OTRO)).body.linked, true);
  });
});

describe("Origin en métodos que cambian estado", () => {
  for (const origen of [null, "https://atacante.test", "null", `${FRONTEND}.atacante.test`]) {
    test(`origen ${origen} responde 403 en POST, PUT y DELETE sin tocar nada`, async () => {
      const { app, db, llamadas } = setup();
      const casos = [
        ["post", "/api/notifications/read-all"],
        ["put", RUTA],
        ["delete", RUTA],
        ["post", RUTA],
      ];
      for (const [metodo, ruta] of casos) {
        const req = request(app)[metodo](ruta).set("Cookie", cookie(ALUMNA));
        if (origen) req.set("Origin", origen);
        const res = await req.send({ username: USUARIO, password: PASSWORD });
        assert.equal(res.status, 403, `${metodo} ${ruta}`);
        assert.deepEqual(res.body, { error: "origen_no_permitido" });
        assertSinSensibles(respuesta(res));
      }
      assert.equal(llamadas.length, 0);
      assert.equal(db.calls.length, 0);
    });
  }

  test("el Origin se revisa antes que la sesión: 403 también sin cookie", async () => {
    const { app } = setup();
    const res = await request(app).delete(RUTA).set("Origin", "https://atacante.test");
    assert.equal(res.status, 403);
  });

  test("GET no exige Origin", async () => {
    const { leer } = setup();
    assert.equal((await leer()).status, 200);
  });
});

describe("límite de intentos", () => {
  test(`el intento ${LINK_ATTEMPTS + 1} en 15 minutos responde 429 sin llamar al puerto`, async () => {
    const { vincular, llamadas, logs } = setup({ exchange: async () => null });
    for (let i = 0; i < LINK_ATTEMPTS; i++) assert.equal((await vincular()).status, 422);
    const res = await vincular();
    assert.equal(res.status, 429);
    assert.deepEqual(res.body, { error: "demasiados_intentos" });
    assert.ok(Number(res.headers["retry-after"]) > 0);
    assert.equal(llamadas.length, LINK_ATTEMPTS);
    assertSinSensibles(respuesta(res) + logs.join("\n"));
  });

  test("es por alumno: otro alumno sigue pudiendo vincular", async () => {
    const { vincular } = setup({ exchange: async () => null });
    for (let i = 0; i < LINK_ATTEMPTS; i++) await vincular();
    assert.equal((await vincular()).status, 429);
    assert.equal((await vincular(undefined, OTRO)).status, 422);
  });

  test("se libera al pasar la ventana", async () => {
    const { vincular, reloj } = setup({ exchange: async () => null });
    for (let i = 0; i < LINK_ATTEMPTS; i++) await vincular();
    assert.equal((await vincular()).status, 429);
    reloj.t += LINK_WINDOW_MS;
    assert.equal((await vincular()).status, 422);
  });

  test("una vinculación exitosa reinicia el contador del alumno", async () => {
    let acepta = false;
    const { vincular } = setup({ exchange: async () => (acepta ? TOKEN : null) });
    for (let i = 0; i < LINK_ATTEMPTS - 1; i++) await vincular();
    acepta = true;
    assert.equal((await vincular()).status, 200);
    acepta = false;
    for (let i = 0; i < LINK_ATTEMPTS; i++) assert.equal((await vincular()).status, 422);
    assert.equal((await vincular()).status, 429);
  });

  test("los cuerpos inválidos y el 501 no gastan intentos", async () => {
    const { vincular } = setup({ exchange: async () => null });
    for (let i = 0; i < LINK_ATTEMPTS + 2; i++) assert.equal((await vincular({ username: USUARIO })).status, 400);
    assert.equal((await vincular()).status, 422);
  });

  test("purga las entradas vencidas", () => {
    const reloj = { t: T0 };
    const limiter = createAttemptLimiter({ max: 2, windowMs: 1000, now: () => reloj.t });
    for (let i = 0; i < 50; i++) limiter.take(`alumno-${i}`);
    assert.equal(limiter.size(), 50);
    reloj.t += 1000;
    limiter.take("otro");
    assert.equal(limiter.size(), 1);
  });
});

describe("fallas de Supabase", () => {
  test("500 genérico; el log lleva user_id, portal, kind y códigos, sin el mensaje", async () => {
    const { vincular, leer, desvincular, db, logs } = setup();
    await vincular();
    const casos = [
      ["select", () => leer(), "credencial_estado_no_leido"],
      ["upsert", () => vincular(), "credencial_no_guardada"],
      ["delete", () => desvincular(), "credencial_no_borrada"],
    ];
    for (const [op, accion, evento] of casos) {
      db.failNext("student_credentials", op);
      const res = await accion();
      assert.equal(res.status, 500, op);
      assert.deepEqual(res.body, { error: "error_interno" });
      const linea = JSON.parse(logs.at(-1));
      assert.equal(linea.event, evento);
      assert.equal(linea.user_id, ALUMNA.userId);
      assert.equal(linea.portal, "ivirtual");
      assert.equal(linea.kind, "ivirtual_token");
      assert.equal(linea.error_code, "XX000");
    }
    assert.ok(!logs.join("\n").includes("fallo simulado"));
  });
});

describe("privacidad", () => {
  test("la contraseña, el token y el correo no aparecen en ninguna respuesta ni log", async () => {
    let modo = "ok";
    const { app, vincular, leer, desvincular, db, logs } = setup({
      exchange: async ({ password }) => {
        if (modo === "lanza") throw Object.assign(new Error(password), { code: password });
        if (modo === "rechaza") return null;
        return TOKEN;
      },
    });
    const respuestas = [];
    const r = async (p) => respuestas.push(respuesta(await p));

    await r(vincular());
    await r(leer());
    modo = "rechaza";
    await r(vincular());
    modo = "lanza";
    await r(vincular());
    modo = "ok";
    await r(vincular({ username: PASSWORD, password: PASSWORD, email: ALUMNA.email }));
    await r(vincular({ username: "", password: PASSWORD }));
    await r(request(app).put(RUTA).set("Origin", FRONTEND).set("Cookie", cookie(ALUMNA))
      .set("Content-Type", "application/json").send(`{"password":"${PASSWORD}`));
    await r(request(app).put(RUTA).set("Origin", "https://atacante.test").send({ password: PASSWORD }));
    await r(request(app).put(RUTA).set("Origin", FRONTEND).send({ password: PASSWORD }));
    db.failNext("student_credentials", "upsert");
    await r(vincular());
    await r(desvincular());
    await r(desvincular());
    for (let i = 0; i < LINK_ATTEMPTS + 1; i++) await r(vincular());

    assert.ok(logs.length >= 8);
    const todo = respuestas.join("\n") + logs.join("\n");
    assertSinSensibles(todo);
    for (const linea of logs) {
      const parsed = JSON.parse(linea);
      for (const prohibido of ["body", "email", "username", "password", "secret", "token", "ciphertext"]) {
        assert.ok(!(prohibido in parsed), prohibido);
      }
    }
  });
});

describe("CORS", () => {
  test("el preflight de /api autoriza PUT y DELETE solo para el origen del frontend", async () => {
    const { app } = setup();
    const res = await request(app).options(RUTA).set("Origin", "https://otro.test");
    assert.equal(res.status, 204);
    assert.equal(res.headers["access-control-allow-origin"], FRONTEND);
    assert.equal(res.headers["access-control-allow-methods"], "GET, POST, PUT, DELETE, OPTIONS");
  });
});

describe("/internal/credentials después de ITN-51", () => {
  test("PUT y DELETE ya no existen aunque la llave sea válida", async () => {
    const { app, db } = setup();
    const ref = { user: { email: ALUMNA.email }, portal: "ivirtual", kind: "ivirtual_token" };
    const put = await request(app).put("/internal/credentials").set("x-api-key", API_KEY).send({ ...ref, secret: TOKEN });
    const del = await request(app).delete("/internal/credentials").set("x-api-key", API_KEY).send(ref);
    assert.equal(put.status, 404);
    assert.equal(del.status, 404);
    assert.equal(db.tables.student_credentials.length, 0);
  });
});
