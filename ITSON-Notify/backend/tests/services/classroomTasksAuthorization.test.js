// ITN-43c - activateTasks/disableTasks usan SOLO las funciones de la 018. El cliente de
// prueba solo tiene rpc(): cualquier intento de leer o escribir tablas por otro camino
// (el antiguo respaldo sin transacción) lanza y hace fallar la prueba.
const { describe, it } = require("node:test");
const assert = require("node:assert/strict");
const { activateTasks, disableTasks, TasksAuthorizationError } = require("../../src/services/classroomTasksAuthorization");
const { CLASSROOM_SCOPE, CLASSROOM_WORK_SCOPE } = require("../../src/services/googleAuthService");
const { decrypt } = require("../../src/utils/secureToken");

const SECRET = "clave-de-pruebas-servicio-43c-".repeat(2);
const IDENTITY = { userId: "00000000-0000-4000-8000-0000000000aa", googleId: "google-a" };
const GRANTED = `openid ${CLASSROOM_SCOPE} ${CLASSROOM_WORK_SCOPE}`;

// Solo rpc; `from`, `schema` o cualquier otra propiedad revientan.
function rpcOnlyClient(result) {
  const calls = [];
  const client = new Proxy({
    async rpc(name, args) { calls.push({ name, args }); return typeof result === "function" ? result(name, args) : result; },
  }, {
    get(target, prop) {
      if (prop in target || typeof prop === "symbol" || prop === "then") return target[prop];
      throw new Error(`camino alterno no permitido: supabase.${String(prop)}`);
    },
  });
  return { client, calls };
}
const fail = (code, message) => ({ data: null, error: { code, message } });

async function expectCode(promise, code, status) {
  await assert.rejects(promise, error => {
    assert.ok(error instanceof TasksAuthorizationError);
    assert.equal(error.code, code);
    assert.equal(error.status, status);
    // Nunca arrastra el mensaje de Supabase.
    assert.equal(error.message, code);
    return true;
  });
}

describe("ITN-43c activateTasks", () => {
  it("llama solo a activate_classroom_tasks con el refresh token cifrado", async () => {
    const { client, calls } = rpcOnlyClient({ data: { activated: true, courses: 1 }, error: null });
    await activateTasks({ supabase: client, identity: IDENTITY, grantedScope: GRANTED, refreshToken: "refresh-secreto", secret: SECRET });
    assert.equal(calls.length, 1);
    assert.equal(calls[0].name, "activate_classroom_tasks");
    const { p_refresh_token: sealed, ...rest } = calls[0].args;
    // Solo los scopes de Classroom: sin openid, email ni profile.
    assert.deepEqual(rest, { p_user_id: IDENTITY.userId, p_google_id: IDENTITY.googleId,
      p_granted_scope: `${CLASSROOM_SCOPE} ${CLASSROOM_WORK_SCOPE}` });
    assert.equal(sealed.includes("refresh-secreto"), false);
    assert.deepEqual(decrypt(sealed, SECRET, "google-refresh"), { token: "refresh-secreto" });
  });

  it("p_granted_scope lleva SOLO los scopes de Classroom (sin openid, email, profile ni otros)", async () => {
    const { client, calls } = rpcOnlyClient({ data: {}, error: null });
    const noisy = ["openid", "email", "profile", "https://www.googleapis.com/auth/userinfo.email",
      "https://www.googleapis.com/auth/userinfo.profile", CLASSROOM_WORK_SCOPE, "https://www.googleapis.com/auth/drive.readonly",
      CLASSROOM_SCOPE, CLASSROOM_WORK_SCOPE, ""].join(" ");
    await activateTasks({ supabase: client, identity: IDENTITY, grantedScope: noisy, refreshToken: "r", secret: SECRET });
    assert.equal(calls[0].args.p_granted_scope, `${CLASSROOM_WORK_SCOPE} ${CLASSROOM_SCOPE}`);
    // Solo tareas concedidas (sin cursos): llega solo el de tareas.
    await activateTasks({ supabase: client, identity: IDENTITY, grantedScope: `openid email profile ${CLASSROOM_WORK_SCOPE}`, secret: SECRET });
    assert.equal(calls[1].args.p_granted_scope, CLASSROOM_WORK_SCOPE);
  });

  it("sin refresh token nuevo manda null (la función conserva el anterior)", async () => {
    const { client, calls } = rpcOnlyClient({ data: {}, error: null });
    await activateTasks({ supabase: client, identity: IDENTITY, grantedScope: `openid ${CLASSROOM_WORK_SCOPE}`, secret: SECRET });
    assert.equal(calls[0].args.p_refresh_token, null);
  });

  it("valida el scope concedido antes de llamar a la base", async () => {
    const { client, calls } = rpcOnlyClient({ data: {}, error: null });
    await expectCode(activateTasks({ supabase: client, identity: IDENTITY, grantedScope: `openid ${CLASSROOM_SCOPE}`, secret: SECRET }),
      "tareas_no_concedidas", 400);
    await expectCode(activateTasks({ supabase: client, identity: IDENTITY, grantedScope: `openid ${CLASSROOM_WORK_SCOPE}`,
      refreshToken: "r", secret: SECRET }), "cursos_no_incluidos", 400);
    assert.deepEqual(calls, []);
  });

  for (const code of ["PGRST202", "42883"]) {
    it(`sin la 018 (${code}): migracion_pendiente 503 y ningún camino alterno`, async () => {
      const { client, calls } = rpcOnlyClient(fail(code, "Could not find the function"));
      await expectCode(activateTasks({ supabase: client, identity: IDENTITY, grantedScope: GRANTED, refreshToken: "r", secret: SECRET }),
        "migracion_pendiente", 503);
      assert.deepEqual(calls.map(c => c.name), ["activate_classroom_tasks"]);
    });
  }

  it("42501 de negocio → 403; otro 42501 u otro error → 500 genérico", async () => {
    for (const [error, code, status] of [
      [fail("42501", "classroom_authorization_required"), "classroom_requiere_autorizacion", 403],
      [fail("42501", "permission denied for function activate_classroom_tasks"), "error_interno", 500],
      [fail("55P03", "lock timeout detalle"), "error_interno", 500],
      [fail("22023", "classroom_tasks_scope_not_granted"), "error_interno", 500],
    ]) {
      const { client, calls } = rpcOnlyClient(error);
      await expectCode(activateTasks({ supabase: client, identity: IDENTITY, grantedScope: GRANTED, secret: SECRET }), code, status);
      assert.equal(calls.length, 1);
    }
  });
});

describe("ITN-43c disableTasks", () => {
  it("llama solo a disable_classroom_tasks con el alumno de la sesión", async () => {
    const { client, calls } = rpcOnlyClient({ data: { events: 1, coursework: 1, courses: 1 }, error: null });
    await disableTasks(client, IDENTITY);
    assert.deepEqual(calls, [{ name: "disable_classroom_tasks", args: { p_user_id: IDENTITY.userId, p_google_id: IDENTITY.googleId } }]);
  });

  for (const code of ["PGRST202", "42883"]) {
    it(`sin la 018 (${code}): migracion_pendiente 503 y ningún camino alterno`, async () => {
      const { client, calls } = rpcOnlyClient(fail(code, "Could not find the function"));
      await expectCode(disableTasks(client, IDENTITY), "migracion_pendiente", 503);
      assert.deepEqual(calls.map(c => c.name), ["disable_classroom_tasks"]);
    });
  }

  it("42501 de negocio → 403; otro 42501 u otro error → 500 genérico", async () => {
    for (const [error, code, status] of [
      [fail("42501", "classroom_authorization_required"), "classroom_requiere_autorizacion", 403],
      [fail("42501", "permission denied for table classroom_coursework"), "error_interno", 500],
      [fail("40P01", "deadlock detected"), "error_interno", 500],
    ]) {
      const { client } = rpcOnlyClient(error);
      await expectCode(disableTasks(client, IDENTITY), code, status);
    }
  });
});
