// ITN-43c - Autorización opcional de tareas de Classroom: bandera, sesión, state,
// misma cuenta, rechazo, concesión correcta y desactivación. Google se simula con
// fixtures (ID token firmado con una llave de prueba); el preload bloquea la red.
const { describe, it } = require("node:test");
const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const express = require("express");
const request = require("supertest");
const { authGoogleRouter } = require("../../src/routes/authGoogle");
const { createApp } = require("../../src/app");
const { createLogger } = require("../../src/utils/logger");
const { sessionHash } = require("../../src/middleware/studentSession");
const { encrypt, decrypt } = require("../../src/utils/secureToken");
const { CLASSROOM_SCOPE, CLASSROOM_WORK_SCOPE, saveGoogleAuthorization } = require("../../src/services/googleAuthService");
const { createFakeSupabase } = require("../helpers/fakeSupabase");
const { API_KEY, CREDENTIALS_KEY } = require("../helpers/payloads");

const SECRET = "clave-de-pruebas-tareas-43c-".repeat(2);
const FRONTEND = "http://localhost:5173";
const BASE_SCOPE = `openid https://www.googleapis.com/auth/userinfo.email ${CLASSROOM_SCOPE}`;
const ALUMNA = { userId: crypto.randomUUID(), googleId: "google-a", email: "alumna@example.test", sessionId: "sesion-a" };
const OTRO = { userId: crypto.randomUUID(), googleId: "google-b", email: "otro@example.test", sessionId: "sesion-b" };
const OLD_REFRESH = "refresh-anterior-secreto";

const { privateKey, publicKey } = crypto.generateKeyPairSync("rsa", { modulusLength: 2048 });
const JWK = { ...publicKey.export({ format: "jwk" }), kid: "kid-43c", use: "sig", alg: "RS256" };
const b64 = data => Buffer.from(JSON.stringify(data)).toString("base64url");
function idToken({ sub, nonce, email = "alumna@example.test" }) {
  const seconds = Math.floor(Date.now() / 1000);
  const signed = `${b64({ alg: "RS256", kid: "kid-43c" })}.${b64({
    iss: "https://accounts.google.com", aud: "test-client", sub, email, email_verified: true,
    hd: "example.test", nonce, iat: seconds - 5, exp: seconds + 3600,
  })}`;
  return `${signed}.${crypto.sign("RSA-SHA256", Buffer.from(signed), privateKey).toString("base64url")}`;
}

function config(enabled = true) {
  return {
    internalApiKey: API_KEY, credentialsEncryptionKey: CREDENTIALS_KEY, googleAuthSecret: SECRET,
    frontendUrl: FRONTEND, classroomTasksAuthEnabled: enabled,
    googleOAuth: { enabled: true, clientId: "test-client", clientSecret: "test-secret",
      redirectUri: "http://localhost:3000/auth/google/callback", scopes: [CLASSROOM_SCOPE] },
  };
}

function setup({ enabled = true, scope = BASE_SCOPE, status = "active", google = {} } = {}) {
  const db = createFakeSupabase();
  const logs = [];
  const logger = createLogger(line => logs.push(line));
  for (const a of [ALUMNA, OTRO]) {
    db.tables.app_users.push({ id: a.userId, email: a.email });
    db.tables.google_authorizations.push({
      user_id: a.userId, google_id: a.googleId, email: a.email,
      scope: a === ALUMNA ? scope : `${BASE_SCOPE} ${CLASSROOM_WORK_SCOPE}`,
      refresh_token: encrypt({ token: OLD_REFRESH }, SECRET, "google-refresh"), status,
    });
    db.tables.google_app_sessions.push({
      id: sessionHash(a.sessionId), user_id: a.userId, google_id: a.googleId,
      expires_at: new Date(Date.now() + 3_600_000).toISOString(),
    });
  }
  // Google simulado: el intercambio de código responde lo que diga `google` y firma
  // el ID token con el nonce (state) del último inicio.
  const exchange = { count: 0, nonce: null };
  const fetchImpl = async (url) => {
    if (url === "https://oauth2.googleapis.com/token") {
      exchange.count++;
      const body = {
        access_token: "access-token-secreto", scope: `${BASE_SCOPE} ${CLASSROOM_WORK_SCOPE}`,
        refresh_token: "refresh-nuevo-secreto", ...google,
      };
      body.id_token = idToken({ sub: google.sub ?? ALUMNA.googleId, nonce: exchange.nonce });
      delete body.sub;
      for (const [k, v] of Object.entries(body)) if (v === undefined) delete body[k];
      return { ok: true, json: async () => body };
    }
    if (url === "https://www.googleapis.com/oauth2/v3/certs") return { ok: true, json: async () => ({ keys: [JWK] }) };
    throw new Error("URL Google no esperada");
  };
  const auth = express();
  auth.use("/auth/google", authGoogleRouter({ config: config(enabled), supabase: db.client, logger, fetchImpl }));
  const api = createApp({ config: config(enabled), supabase: db.client, logger, channels: [] });
  return { db, logs, auth, api, exchange };
}

const cookie = ({ userId, googleId, sessionId }, exp = Date.now() + 60_000) =>
  `itn41_google_session=${encrypt({ userId, googleId, sessionId, exp }, SECRET, "google-session")}`;
const grantOf = (db, who = ALUMNA) => db.tables.google_authorizations.find(g => g.user_id === who.userId);
const scopes = value => value.split(" ");

// Inicia /auth/google/tasks y devuelve el agente con la cookie de state y el state.
async function start(ctx, who = ALUMNA) {
  const agent = request.agent(ctx.auth);
  const res = await agent.get("/auth/google/tasks").set("Cookie", cookie(who));
  assert.equal(res.status, 302);
  const state = new URL(res.headers.location).searchParams.get("state");
  ctx.exchange.nonce = state;
  return { agent, state, res };
}
async function callback(ctx, { agent, state }, query, who = ALUMNA) {
  const res = await agent.get(`/auth/google/callback?state=${encodeURIComponent(state)}&${query}`).set("Cookie", cookie(who));
  assert.equal(res.status, 302);
  const url = new URL(res.headers.location);
  assert.equal(url.origin, FRONTEND);
  assert.equal(url.searchParams.get("from"), "settings");
  return url.searchParams.get("tareas");
}

// Datos de Classroom de un alumno: un curso con baseline, una tarea y su evento.
function seedClassroom(db, who) {
  const course = crypto.randomUUID();
  const work = crypto.randomUUID();
  db.tables.classroom_courses.push({ id: course, user_id: who.userId, external_course_id: `c-${who.googleId}`,
    name: "Curso", coursework_baseline_at: new Date().toISOString() });
  db.tables.classroom_coursework.push({ id: work, user_id: who.userId, course_id: course,
    external_coursework_id: `w-${who.googleId}`, title: "Tarea" });
  db.tables.classroom_task_events.push({ id: crypto.randomUUID(), user_id: who.userId, coursework_id: work });
}

function assertNoSecretsLogged(logs) {
  const text = logs.join("\n");
  for (const secret of ["access-token-secreto", "refresh-nuevo-secreto", OLD_REFRESH, "codigo-43c", CLASSROOM_WORK_SCOPE, "Tarea", "Curso"]) {
    assert.equal(text.includes(secret), false, `log con dato sensible: ${secret}`);
  }
}

describe("ITN-43c bandera apagada", () => {
  it("GET /auth/google/tasks y DELETE responden 404; el estado dice enabled=false", async () => {
    const ctx = setup({ enabled: false });
    const start = await request(ctx.auth).get("/auth/google/tasks").set("Cookie", cookie(ALUMNA));
    assert.equal(start.status, 404);
    const del = await request(ctx.api).delete("/api/classroom/tasks-authorization")
      .set("Origin", FRONTEND).set("Cookie", cookie(ALUMNA));
    assert.equal(del.status, 404);
    const get = await request(ctx.api).get("/api/classroom/tasks-authorization").set("Cookie", cookie(ALUMNA));
    assert.equal(get.status, 200);
    assert.deepEqual(get.body, { enabled: false, granted: false, needsRelink: false });
    assert.equal(grantOf(ctx.db).scope, BASE_SCOPE);
  });

  it("el login no añade include_granted_scopes", async () => {
    const ctx = setup({ enabled: false });
    const res = await request(ctx.auth).get("/auth/google");
    const params = new URL(res.headers.location).searchParams;
    assert.equal(params.has("include_granted_scopes"), false);
    assert.equal(scopes(params.get("scope")).includes(CLASSROOM_WORK_SCOPE), false);
  });
});

describe("ITN-43c inicio GET /auth/google/tasks", () => {
  it("exige sesión válida", async () => {
    const ctx = setup();
    const none = await request(ctx.auth).get("/auth/google/tasks");
    const expired = await request(ctx.auth).get("/auth/google/tasks").set("Cookie", cookie(ALUMNA, Date.now() - 1000));
    assert.equal(none.status, 401);
    assert.equal(expired.status, 401);
  });

  it("rechaza otro origen o una navegación cross-site sin Referer del frontend", async () => {
    const ctx = setup();
    const origin = await request(ctx.auth).get("/auth/google/tasks").set("Cookie", cookie(ALUMNA))
      .set("Origin", "https://otro-sitio.test");
    const crossSite = await request(ctx.auth).get("/auth/google/tasks").set("Cookie", cookie(ALUMNA))
      .set("Sec-Fetch-Site", "cross-site").set("Referer", "https://otro-sitio.test/x");
    const fromFrontend = await request(ctx.auth).get("/auth/google/tasks").set("Cookie", cookie(ALUMNA))
      .set("Sec-Fetch-Site", "cross-site").set("Referer", `${FRONTEND}/`);
    assert.equal(origin.status, 403);
    assert.equal(crossSite.status, 403);
    assert.equal(fromFrontend.status, 302);
  });

  it("exige autorización de Google activa", async () => {
    const ctx = setup({ status: "needs_relink" });
    const res = await request(ctx.auth).get("/auth/google/tasks").set("Cookie", cookie(ALUMNA));
    assert.equal(res.status, 409);
    assert.equal(res.body.error, "classroom_requiere_autorizacion");
  });

  it("pide SOLO el scope de tareas con include_granted_scopes, PKCE y state/nonce", async () => {
    const ctx = setup();
    const { res, state } = await start(ctx);
    const params = new URL(res.headers.location).searchParams;
    const requested = scopes(params.get("scope"));
    assert.ok(requested.includes(CLASSROOM_WORK_SCOPE));
    assert.equal(requested.includes(CLASSROOM_SCOPE), false);
    assert.deepEqual(requested.filter(s => s.startsWith("https://")), [CLASSROOM_WORK_SCOPE]);
    assert.equal(params.get("include_granted_scopes"), "true");
    assert.equal(params.get("code_challenge_method"), "S256");
    assert.ok(params.get("code_challenge"));
    assert.equal(params.get("nonce"), state);
    assert.equal(params.get("login_hint"), ALUMNA.googleId);
    assert.equal(params.get("redirect_uri"), "http://localhost:3000/auth/google/callback");
    const stateCookie = res.headers["set-cookie"].find(c => c.startsWith("itn41_google_state="));
    assert.match(stateCookie, /HttpOnly/i);
    // El modo tareas va sellado por el servidor junto al state y la sesión.
    const sealed = decodeURIComponent(stateCookie.split(";")[0].slice("itn41_google_state=".length));
    const pending = decrypt(sealed, SECRET, "google-state");
    assert.equal(pending.mode, "tasks");
    assert.equal(pending.state, state);
    assert.equal(pending.googleId, ALUMNA.googleId);
  });

  it("con la bandera encendida el login pide incremental sin cambiar el scope solicitado", async () => {
    const ctx = setup();
    const res = await request(ctx.auth).get("/auth/google");
    const params = new URL(res.headers.location).searchParams;
    assert.equal(params.get("include_granted_scopes"), "true");
    assert.deepEqual(scopes(params.get("scope")).filter(s => s.startsWith("https://")), [CLASSROOM_SCOPE]);
  });
});

describe("ITN-43c callback en modo tareas", () => {
  it("state inválido: 400 sin consultar Google ni tocar el grant", async () => {
    const ctx = setup();
    const { agent } = await start(ctx);
    const res = await agent.get("/auth/google/callback?state=inventado&code=codigo-43c").set("Cookie", cookie(ALUMNA));
    assert.equal(res.status, 400);
    assert.equal(res.body.error, "oauth_state_invalido");
    assert.equal(ctx.exchange.count, 0);
    assert.equal(grantOf(ctx.db).scope, BASE_SCOPE);
  });

  it("un parámetro del cliente no activa el modo tareas en un state de login", async () => {
    const ctx = setup();
    const agent = request.agent(ctx.auth);
    const login = await agent.get("/auth/google?from=settings&mode=tasks");
    const state = new URL(login.headers.location).searchParams.get("state");
    const res = await agent.get(`/auth/google/callback?state=${state}&error=access_denied&mode=tasks`);
    const url = new URL(res.headers.location);
    assert.equal(url.searchParams.get("classroom"), "error");
    assert.equal(url.searchParams.has("tareas"), false);
  });

  it("rechazo del alumno: ?tareas=rechazada y sin cambios", async () => {
    const ctx = setup();
    const before = { ...grantOf(ctx.db) };
    const flow = await start(ctx);
    assert.equal(await callback(ctx, flow, "error=access_denied"), "rechazada");
    assert.deepEqual(grantOf(ctx.db), before);
    assert.equal(ctx.exchange.count, 0);
  });

  it("permisos parciales (sin el scope de tareas): rechazada y sin cambios", async () => {
    const ctx = setup({ google: { scope: BASE_SCOPE } });
    const before = { ...grantOf(ctx.db) };
    const flow = await start(ctx);
    assert.equal(await callback(ctx, flow, "code=codigo-43c"), "rechazada");
    assert.deepEqual(grantOf(ctx.db), before);
  });

  it("cuenta de Google distinta: cuenta_distinta y no persiste nada", async () => {
    const ctx = setup({ google: { sub: "google-intruso" } });
    const before = { ...grantOf(ctx.db) };
    const flow = await start(ctx);
    assert.equal(await callback(ctx, flow, "code=codigo-43c"), "cuenta_distinta");
    assert.deepEqual(grantOf(ctx.db), before);
    assert.equal(ctx.db.tables.google_authorizations.length, 2);
    assert.equal(ctx.db.tables.app_users.length, 2);
  });

  it("sesión distinta a la que inició el flujo: error y sin cambios", async () => {
    const ctx = setup();
    const before = { ...grantOf(ctx.db) };
    const flow = await start(ctx);
    assert.equal(await callback(ctx, flow, "code=codigo-43c", OTRO), "error");
    assert.deepEqual(grantOf(ctx.db), before);
    assert.equal(ctx.exchange.count, 0);
  });

  it("concesión correcta: une scopes, guarda el refresh token nuevo cifrado, nunca el access token", async () => {
    const ctx = setup();
    seedClassroom(ctx.db, ALUMNA);
    const flow = await start(ctx);
    assert.equal(await callback(ctx, flow, "code=codigo-43c"), "ok");
    const grant = grantOf(ctx.db);
    assert.ok(scopes(grant.scope).includes(CLASSROOM_SCOPE));
    assert.ok(scopes(grant.scope).includes(CLASSROOM_WORK_SCOPE));
    assert.deepEqual(decrypt(grant.refresh_token, SECRET, "google-refresh"), { token: "refresh-nuevo-secreto" });
    assert.equal(grant.status, "active");
    assert.equal(JSON.stringify(ctx.db.tables).includes("access-token-secreto"), false);
    // Activación nueva: baseline en null para que la primera sync con tareas sea silenciosa.
    assert.equal(ctx.db.tables.classroom_courses[0].coursework_baseline_at, null);
    // No crea sesión nueva ni toca al otro alumno.
    assert.equal(ctx.db.tables.google_app_sessions.length, 2);
    assert.ok(scopes(grantOf(ctx.db, OTRO).scope).includes(CLASSROOM_WORK_SCOPE));
    assertNoSecretsLogged(ctx.logs);
  });

  it("sin refresh token nuevo conserva el anterior", async () => {
    const ctx = setup({ google: { refresh_token: undefined, scope: `openid ${CLASSROOM_WORK_SCOPE}` } });
    const flow = await start(ctx);
    assert.equal(await callback(ctx, flow, "code=codigo-43c"), "ok");
    const grant = grantOf(ctx.db);
    assert.deepEqual(decrypt(grant.refresh_token, SECRET, "google-refresh"), { token: OLD_REFRESH });
    assert.ok(scopes(grant.scope).includes(CLASSROOM_SCOPE));
    assert.ok(scopes(grant.scope).includes(CLASSROOM_WORK_SCOPE));
  });

  it("refresh token nuevo que no cubre cursos: error y sin cambios", async () => {
    const ctx = setup({ google: { scope: `openid ${CLASSROOM_WORK_SCOPE}` } });
    const before = { ...grantOf(ctx.db) };
    const flow = await start(ctx);
    assert.equal(await callback(ctx, flow, "code=codigo-43c"), "error");
    assert.deepEqual(grantOf(ctx.db), before);
  });

  it("sin la columna de la 017 no amplía el scope", async () => {
    const ctx = setup();
    ctx.db.withoutColumn("classroom_courses", "coursework_baseline_at");
    const flow = await start(ctx);
    assert.equal(await callback(ctx, flow, "code=codigo-43c"), "error");
    assert.equal(grantOf(ctx.db).scope, BASE_SCOPE);
  });

  it("si la bandera se apaga a mitad del flujo no cambia nada", async () => {
    const ctx = setup();
    const flow = await start(ctx);
    const off = express();
    off.use("/auth/google", authGoogleRouter({ config: config(false), supabase: ctx.db.client, logger: { info() {}, warn() {} } }));
    const res = await request(off).get(`/auth/google/callback?state=${flow.state}&code=codigo-43c`)
      .set("Cookie", [cookie(ALUMNA), flow.res.headers["set-cookie"].find(c => c.startsWith("itn41_google_state=")).split(";")[0]]);
    assert.equal(new URL(res.headers.location).searchParams.get("tareas"), "error");
    assert.equal(grantOf(ctx.db).scope, BASE_SCOPE);
  });
});

describe("ITN-43c /api/classroom/tasks-authorization", () => {
  it("GET exige sesión y refleja el scope guardado", async () => {
    const off = setup();
    assert.equal((await request(off.api).get("/api/classroom/tasks-authorization")).status, 401);
    const res = await request(off.api).get("/api/classroom/tasks-authorization").set("Cookie", cookie(ALUMNA));
    assert.deepEqual(res.body, { enabled: true, granted: false, needsRelink: false });
    const on = setup({ scope: `${BASE_SCOPE} ${CLASSROOM_WORK_SCOPE}` });
    const granted = await request(on.api).get("/api/classroom/tasks-authorization").set("Cookie", cookie(ALUMNA));
    assert.deepEqual(granted.body, { enabled: true, granted: true, needsRelink: false });
    const relink = setup({ scope: `${BASE_SCOPE} ${CLASSROOM_WORK_SCOPE}`, status: "needs_relink" });
    const needs = await request(relink.api).get("/api/classroom/tasks-authorization").set("Cookie", cookie(ALUMNA));
    assert.deepEqual(needs.body, { enabled: true, granted: false, needsRelink: true });
  });

  it("DELETE exige Origin del frontend y sesión", async () => {
    const ctx = setup({ scope: `${BASE_SCOPE} ${CLASSROOM_WORK_SCOPE}` });
    const origin = await request(ctx.api).delete("/api/classroom/tasks-authorization")
      .set("Origin", "https://otro-sitio.test").set("Cookie", cookie(ALUMNA));
    const noSession = await request(ctx.api).delete("/api/classroom/tasks-authorization").set("Origin", FRONTEND);
    assert.equal(origin.status, 403);
    assert.equal(noSession.status, 401);
    assert.ok(scopes(grantOf(ctx.db).scope).includes(CLASSROOM_WORK_SCOPE));
  });

  it("DELETE sin la 018: quita el scope, borra tareas y eventos y limpia baseline solo de ese alumno", async () => {
    const ctx = setup({ scope: `${BASE_SCOPE} ${CLASSROOM_WORK_SCOPE}` });
    seedClassroom(ctx.db, ALUMNA);
    seedClassroom(ctx.db, OTRO);
    const res = await request(ctx.api).delete("/api/classroom/tasks-authorization")
      .set("Origin", FRONTEND).set("Cookie", cookie(ALUMNA));
    assert.equal(res.status, 204);
    const grant = grantOf(ctx.db);
    assert.equal(grant.scope, BASE_SCOPE);
    assert.deepEqual(decrypt(grant.refresh_token, SECRET, "google-refresh"), { token: OLD_REFRESH });
    const of = (table, who) => ctx.db.tables[table].filter(r => r.user_id === who.userId);
    assert.equal(of("classroom_task_events", ALUMNA).length, 0);
    assert.equal(of("classroom_coursework", ALUMNA).length, 0);
    assert.equal(of("classroom_courses", ALUMNA).length, 1);
    assert.equal(of("classroom_courses", ALUMNA)[0].coursework_baseline_at, null);
    // El otro alumno queda intacto.
    assert.equal(of("classroom_task_events", OTRO).length, 1);
    assert.equal(of("classroom_coursework", OTRO).length, 1);
    assert.notEqual(of("classroom_courses", OTRO)[0].coursework_baseline_at, null);
    assert.ok(scopes(grantOf(ctx.db, OTRO).scope).includes(CLASSROOM_WORK_SCOPE));
    // Orden seguro: primero el scope, después eventos, tareas y baseline.
    const order = ctx.db.calls.filter(c => c.op === "update" || c.op === "delete").map(c => `${c.op}:${c.table}`);
    assert.deepEqual(order, ["update:google_authorizations", "delete:classroom_task_events",
      "delete:classroom_coursework", "update:classroom_courses"]);
    assertNoSecretsLogged(ctx.logs);
  });

  it("DELETE con la 018 usa la función atómica con el alumno de la sesión", async () => {
    const ctx = setup({ scope: `${BASE_SCOPE} ${CLASSROOM_WORK_SCOPE}` });
    const calls = [];
    ctx.db.rpcHandlers.disable_classroom_tasks = args => { calls.push(args); return { data: {}, error: null }; };
    const res = await request(ctx.api).delete("/api/classroom/tasks-authorization")
      .set("Origin", FRONTEND).set("Cookie", cookie(ALUMNA));
    assert.equal(res.status, 204);
    assert.deepEqual(calls, [{ p_user_id: ALUMNA.userId, p_google_id: ALUMNA.googleId }]);
    assert.equal(ctx.db.calls.some(c => c.op === "delete"), false);
  });

  it("DELETE con un error de la función distinto de «no existe» responde 500 sin borrar nada", async () => {
    const ctx = setup({ scope: `${BASE_SCOPE} ${CLASSROOM_WORK_SCOPE}` });
    seedClassroom(ctx.db, ALUMNA);
    ctx.db.rpcHandlers.disable_classroom_tasks = () => ({ data: null, error: { code: "40P01", message: "deadlock" } });
    const res = await request(ctx.api).delete("/api/classroom/tasks-authorization")
      .set("Origin", FRONTEND).set("Cookie", cookie(ALUMNA));
    assert.equal(res.status, 500);
    assert.equal(ctx.db.tables.classroom_coursework.length, 1);
    assert.ok(scopes(grantOf(ctx.db).scope).includes(CLASSROOM_WORK_SCOPE));
  });

  // Regla de autorización de la desactivación (igual que la 018): exige el grant de ese
  // user_id y google_id con cualquier status; sin él responde 409 y no borra nada.
  const del = ctx => request(ctx.api).delete("/api/classroom/tasks-authorization").set("Origin", FRONTEND).set("Cookie", cookie(ALUMNA));
  const of = (ctx, table, who = ALUMNA) => ctx.db.tables[table].filter(r => r.user_id === who.userId);
  const writes = ctx => ctx.db.calls.filter(c => c.op === "update" || c.op === "delete");
  function assertUntouched(ctx) {
    assert.equal(of(ctx, "classroom_task_events").length, 1);
    assert.equal(of(ctx, "classroom_coursework").length, 1);
    assert.notEqual(of(ctx, "classroom_courses")[0].coursework_baseline_at, null);
    assert.deepEqual(writes(ctx), []);
  }
  function assertCleaned(ctx) {
    assert.equal(grantOf(ctx.db).scope, BASE_SCOPE);
    assert.equal(of(ctx, "classroom_task_events").length, 0);
    assert.equal(of(ctx, "classroom_coursework").length, 0);
    assert.equal(of(ctx, "classroom_courses").length, 1);
    assert.equal(of(ctx, "classroom_courses")[0].coursework_baseline_at, null);
    assert.equal(of(ctx, "classroom_task_events", OTRO).length, 1);
    assert.equal(of(ctx, "classroom_coursework", OTRO).length, 1);
  }

  it("DELETE sin la 018 y google_id distinto: 409 y no borra nada", async () => {
    const ctx = setup({ scope: `${BASE_SCOPE} ${CLASSROOM_WORK_SCOPE}` });
    seedClassroom(ctx.db, ALUMNA);
    grantOf(ctx.db).google_id = "google-otra-cuenta";
    const res = await del(ctx);
    assert.equal(res.status, 409);
    assert.deepEqual(res.body, { error: "classroom_requiere_autorizacion" });
    assertUntouched(ctx);
    assert.ok(scopes(grantOf(ctx.db).scope).includes(CLASSROOM_WORK_SCOPE));
    assertNoSecretsLogged(ctx.logs);
  });

  it("DELETE sin la 018 y sin autorización: 409 y no borra nada", async () => {
    const ctx = setup({ scope: `${BASE_SCOPE} ${CLASSROOM_WORK_SCOPE}` });
    seedClassroom(ctx.db, ALUMNA);
    ctx.db.tables.google_authorizations = ctx.db.tables.google_authorizations.filter(g => g.user_id !== ALUMNA.userId);
    const res = await del(ctx);
    assert.equal(res.status, 409);
    assert.deepEqual(res.body, { error: "classroom_requiere_autorizacion" });
    assertUntouched(ctx);
  });

  it("DELETE sin la 018 con autorización en needs_relink: sí limpia scope, tareas, eventos y baseline", async () => {
    const ctx = setup({ scope: `${BASE_SCOPE} ${CLASSROOM_WORK_SCOPE}`, status: "needs_relink" });
    seedClassroom(ctx.db, ALUMNA);
    seedClassroom(ctx.db, OTRO);
    const res = await del(ctx);
    assert.equal(res.status, 204);
    assertCleaned(ctx);
    assert.equal(grantOf(ctx.db).status, "needs_relink");
  });

  it("DELETE sin la 018 con autorización activa: limpia como antes", async () => {
    const ctx = setup({ scope: `${BASE_SCOPE} ${CLASSROOM_WORK_SCOPE}` });
    seedClassroom(ctx.db, ALUMNA);
    seedClassroom(ctx.db, OTRO);
    const res = await del(ctx);
    assert.equal(res.status, 204);
    assertCleaned(ctx);
  });

  it("DELETE con la 018 que rechaza la autorización (42501): 409 sin usar el respaldo", async () => {
    const ctx = setup({ scope: `${BASE_SCOPE} ${CLASSROOM_WORK_SCOPE}` });
    seedClassroom(ctx.db, ALUMNA);
    ctx.db.rpcHandlers.disable_classroom_tasks = () => ({
      data: null, error: { code: "42501", message: "classroom_authorization_required" },
    });
    const res = await del(ctx);
    assert.equal(res.status, 409);
    assert.deepEqual(res.body, { error: "classroom_requiere_autorizacion" });
    assertUntouched(ctx);
  });

  it("DELETE con la 018 y otro 42501 (permiso de infraestructura) responde 500, no 409", async () => {
    const ctx = setup({ scope: `${BASE_SCOPE} ${CLASSROOM_WORK_SCOPE}` });
    seedClassroom(ctx.db, ALUMNA);
    ctx.db.rpcHandlers.disable_classroom_tasks = () => ({
      data: null, error: { code: "42501", message: "permission denied for function disable_classroom_tasks" },
    });
    const res = await del(ctx);
    assert.equal(res.status, 500);
    assertUntouched(ctx);
  });

  it("DELETE y reactivación: el scope vuelve y la baseline queda en null", async () => {
    const ctx = setup({ scope: `${BASE_SCOPE} ${CLASSROOM_WORK_SCOPE}` });
    seedClassroom(ctx.db, ALUMNA);
    await request(ctx.api).delete("/api/classroom/tasks-authorization").set("Origin", FRONTEND).set("Cookie", cookie(ALUMNA));
    const flow = await start(ctx);
    assert.equal(await callback(ctx, flow, "code=codigo-43c"), "ok");
    assert.ok(scopes(grantOf(ctx.db).scope).includes(CLASSROOM_WORK_SCOPE));
    assert.equal(ctx.db.tables.classroom_courses.find(c => c.user_id === ALUMNA.userId).coursework_baseline_at, null);
  });
});

describe("ITN-43c login conserva la decisión del alumno", () => {
  const identity = { googleId: ALUMNA.googleId, email: ALUMNA.email, name: "", authoritativeEmail: true };
  it("un re-login que devuelve el scope de tareas no lo activa si estaba desactivado", async () => {
    const ctx = setup();
    await saveGoogleAuthorization({ supabase: ctx.db.client, ...identity, refreshToken: "nuevo",
      scope: `${BASE_SCOPE} ${CLASSROOM_WORK_SCOPE}`, secret: SECRET, requiredScopes: [CLASSROOM_SCOPE] });
    assert.equal(scopes(grantOf(ctx.db).scope).includes(CLASSROOM_WORK_SCOPE), false);
  });
  it("y lo conserva si estaba activo", async () => {
    const ctx = setup({ scope: `${BASE_SCOPE} ${CLASSROOM_WORK_SCOPE}` });
    await saveGoogleAuthorization({ supabase: ctx.db.client, ...identity, refreshToken: "nuevo",
      scope: `${BASE_SCOPE} ${CLASSROOM_WORK_SCOPE}`, secret: SECRET, requiredScopes: [CLASSROOM_SCOPE] });
    assert.ok(scopes(grantOf(ctx.db).scope).includes(CLASSROOM_WORK_SCOPE));
  });
});
