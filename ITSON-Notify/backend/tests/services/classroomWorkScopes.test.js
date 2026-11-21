// ITN-43c - Helpers del permiso de tareas: ambos nombres (canónico y alias empírico) cuentan, sin
// traducir uno al otro. openid, email, profile y cualquier otro scope se descartan al guardar.
const { test } = require("node:test");
const assert = require("node:assert/strict");
const { CLASSROOM_SCOPE, CLASSROOM_WORK_SCOPE, CLASSROOM_WORK_SCOPE_ALIAS, tienePermisoTareas, cumpleScopes,
  classroomScopesOnly, withoutWorkScopes, hasWorkScopeAlias } = require("../../src/services/googleAuthService");

const OTHERS = ["openid", "email", "profile", "https://www.googleapis.com/auth/userinfo.email",
  "https://www.googleapis.com/auth/classroom.coursework.me",
  "https://www.googleapis.com/auth/classroom.coursework.students.readonly",
  "https://www.googleapis.com/auth/classroom.student-submissions.students.readonly"];

test("tienePermisoTareas acepta ambos nombres y nada más", () => {
  assert.equal(CLASSROOM_WORK_SCOPE_ALIAS, "https://www.googleapis.com/auth/classroom.student-submissions.me.readonly");
  assert.equal(tienePermisoTareas(`openid ${CLASSROOM_SCOPE} ${CLASSROOM_WORK_SCOPE}`), true);
  assert.equal(tienePermisoTareas(`openid ${CLASSROOM_SCOPE} ${CLASSROOM_WORK_SCOPE_ALIAS}`), true);
  assert.equal(tienePermisoTareas(`${CLASSROOM_SCOPE} ${OTHERS.join(" ")}`), false);
  for (const value of [undefined, null, 42, {}, ""]) assert.equal(tienePermisoTareas(value), false);
});

test("cumpleScopes: el requisito de tareas se cumple con cualquiera de los nombres", () => {
  const required = [CLASSROOM_SCOPE, CLASSROOM_WORK_SCOPE];
  assert.equal(cumpleScopes(`${CLASSROOM_SCOPE} ${CLASSROOM_WORK_SCOPE_ALIAS}`, required), true);
  assert.equal(cumpleScopes(`${CLASSROOM_SCOPE} ${CLASSROOM_WORK_SCOPE}`, required), true);
  assert.equal(cumpleScopes(CLASSROOM_SCOPE, required), false);
  assert.equal(cumpleScopes(CLASSROOM_WORK_SCOPE_ALIAS, [CLASSROOM_SCOPE]), false);
});

test("classroomScopesOnly conserva el nombre de Google, sin duplicados y en orden", () => {
  assert.equal(classroomScopesOnly(`openid email profile ${CLASSROOM_WORK_SCOPE_ALIAS} ${CLASSROOM_SCOPE} ${CLASSROOM_WORK_SCOPE_ALIAS}`),
    `${CLASSROOM_WORK_SCOPE_ALIAS} ${CLASSROOM_SCOPE}`);
  assert.equal(classroomScopesOnly(OTHERS.join(" ")), "");
  assert.equal(classroomScopesOnly(undefined), "");
});

test("withoutWorkScopes quita ambos nombres; la marca del alias es booleana", () => {
  assert.equal(withoutWorkScopes(`${CLASSROOM_SCOPE} ${CLASSROOM_WORK_SCOPE} ${CLASSROOM_WORK_SCOPE_ALIAS}`), CLASSROOM_SCOPE);
  assert.equal(hasWorkScopeAlias(`openid ${CLASSROOM_WORK_SCOPE_ALIAS}`), true);
  assert.equal(hasWorkScopeAlias(`openid ${CLASSROOM_WORK_SCOPE}`), false);
  assert.equal(hasWorkScopeAlias(undefined), false);
});
