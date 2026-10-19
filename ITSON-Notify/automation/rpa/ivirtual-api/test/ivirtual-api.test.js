// Pruebas de la API de iVirtual con fetch simulado. Los fixtures son datos
// inventados (sin alumnos, matrículas ni tokens reales).
const { test, describe } = require("node:test");
const assert = require("node:assert/strict");
const path = require("path");
const fs = require("fs");

const { extractGrades } = require("../index");
const { callWs, encodeParams, MoodleError } = require("../client");

const FIXTURES = path.join(__dirname, "fixtures");
const fixture = (name) =>
  JSON.parse(fs.readFileSync(path.join(FIXTURES, `${name}.json`), "utf8"));

const CREDS = { usuario: "00000000000", password: "pass-de-prueba" };
const TOKEN = fixture("token").token;
const OPTS = { backoffMs: 0 }; // sin esperas entre reintentos en las pruebas

const json = (data, status = 200) =>
  new Response(JSON.stringify(data), {
    status,
    headers: { "Content-Type": "application/json" },
  });

// fetch simulado: responde según la URL y la wsfunction del cuerpo.
// `overrides` permite reemplazar la respuesta de una wsfunction (o "token").
function mockMoodle(t, overrides = {}) {
  const calls = [];
  const fetchMock = t.mock.method(globalThis, "fetch", async (url, init) => {
    const body = new URLSearchParams(init.body);
    const key = url.endsWith("/login/token.php") ? "token" : body.get("wsfunction");
    calls.push({ url, key, body });

    if (key in overrides) return overrides[key](body, calls);
    switch (key) {
      case "token":
        return json(fixture("token"));
      case "core_webservice_get_site_info":
        return json(fixture("site_info"));
      case "core_enrol_get_users_courses":
        return json(fixture("courses"));
      case "gradereport_user_get_grade_items":
        return json(fixture(`grade_items_${body.get("courseid")}`));
      default:
        return json({ exception: "x", errorcode: "invalidfunction", message: key });
    }
  });
  return { calls, fetchMock };
}

describe("mapeo de calificaciones", () => {
  test("mapea cursos e ítems al formato esperado", async (t) => {
    mockMoodle(t);
    const result = await extractGrades(CREDS, OPTS);

    assert.equal(result.status, "ok");
    assert.equal(result.courses.length, 2);

    const [a, b] = result.courses;
    assert.equal(a.externalId, "501");
    assert.equal(a.subject, "Materia de prueba A");
    assert.deepEqual(a.items[0], {
      externalItemId: "9001",
      label: "Tarea 1",
      type: "mod",
      value: 85.5,
      text: "85.50",
      min: 0,
      max: 100,
      percentage: "85.50 %",
      categoryId: 70,
      cmid: 3001,
      hidden: false,
    });

    // Moodle a veces manda números como texto: se normalizan
    assert.deepEqual(
      { value: b.items[0].value, min: b.items[0].min, max: b.items[0].max, hidden: b.items[0].hidden },
      { value: 95, min: 0, max: 100, hidden: false },
    );
  });

  test("ítems con el mismo nombre conservan ids distintos", async (t) => {
    mockMoodle(t);
    const { courses } = await extractGrades(CREDS, OPTS);
    const tareas = courses[0].items.filter((i) => i.label === "Tarea 1");

    assert.equal(tareas.length, 2);
    assert.deepEqual(tareas.map((i) => i.externalItemId), ["9001", "9002"]);
  });

  test("un ítem sin calificar queda con value null", async (t) => {
    mockMoodle(t);
    const { courses } = await extractGrades(CREDS, OPTS);
    const examen = courses[0].items.find((i) => i.externalItemId === "9003");

    assert.equal(examen.value, null);
    assert.equal(examen.text, "-");
  });

  test("omite ocultos solo si no tienen valor", async (t) => {
    mockMoodle(t);
    const { courses } = await extractGrades(CREDS, OPTS);
    const ids = courses[0].items.map((i) => i.externalItemId);

    assert.ok(!ids.includes("9004"), "oculto sin valor debe omitirse");
    assert.ok(ids.includes("9005"), "oculto con valor debe conservarse");
    assert.ok(ids.includes("9006"), "el total del curso se conserva");
  });
});

describe("errores", () => {
  test("credenciales inválidas devuelven status 'credenciales'", async (t) => {
    const { calls } = mockMoodle(t, { token: () => json(fixture("invalidlogin")) });
    const result = await extractGrades(CREDS, OPTS);

    assert.deepEqual(result, { status: "credenciales", courses: [] });
    assert.equal(calls.length, 1, "no se reintenta un error de Moodle");
  });

  test("token inválido devuelve 'error' sin exponer el token", async (t) => {
    mockMoodle(t, {
      core_webservice_get_site_info: () => json(fixture("invalidtoken")),
    });
    const result = await extractGrades(CREDS, OPTS);

    assert.equal(result.status, "error");
    assert.equal(result.errorcode, "invalidtoken");
    assert.deepEqual(result.courses, []);
    assert.ok(!JSON.stringify(result).includes(TOKEN));
    assert.ok(!JSON.stringify(result).includes(CREDS.password));
  });

  test("un error de Moodle lanza MoodleError y no se reintenta", async (t) => {
    const { calls } = mockMoodle(t, {
      gradereport_user_get_grade_items: () => json(fixture("nopermissions")),
    });

    await assert.rejects(
      callWs(TOKEN, "gradereport_user_get_grade_items", { courseid: 501 }, OPTS),
      (error) => {
        assert.ok(error instanceof MoodleError);
        assert.equal(error.errorcode, "nopermissions");
        assert.match(error.message, /^gradereport_user_get_grade_items: /);
        return true;
      },
    );
    assert.equal(calls.length, 1);
  });

  test("si falla un curso falla toda la extracción", async (t) => {
    mockMoodle(t, {
      gradereport_user_get_grade_items: (body) =>
        body.get("courseid") === "502"
          ? json(fixture("nopermissions"))
          : json(fixture("grade_items_501")),
    });
    const result = await extractGrades(CREDS, OPTS);

    assert.equal(result.status, "error");
    assert.deepEqual(result.courses, []);
  });
});

describe("cliente HTTP", () => {
  test("reintenta en 5xx y luego tiene éxito", async (t) => {
    let fallas = 0;
    const { calls } = mockMoodle(t, {
      core_webservice_get_site_info: () =>
        fallas++ < 1 ? new Response("caído", { status: 503 }) : json(fixture("site_info")),
    });
    const data = await callWs(TOKEN, "core_webservice_get_site_info", {}, OPTS);

    assert.equal(data.userid, 4242);
    assert.equal(calls.length, 2);
  });

  test("reintento limitado en fallas de red", async (t) => {
    const { calls } = mockMoodle(t, {
      core_webservice_get_site_info: () => {
        throw new TypeError("fetch failed");
      },
    });

    await assert.rejects(
      callWs(TOKEN, "core_webservice_get_site_info", {}, { ...OPTS, retries: 2 }),
      /Falla de red/,
    );
    assert.equal(calls.length, 3, "1 intento + 2 reintentos");
  });

  test("no reintenta en 4xx", async (t) => {
    const { calls } = mockMoodle(t, {
      core_webservice_get_site_info: () => new Response("no", { status: 403 }),
    });

    await assert.rejects(
      callWs(TOKEN, "core_webservice_get_site_info", {}, OPTS),
      /HTTP 403/,
    );
    assert.equal(calls.length, 1);
  });

  test("el token y la contraseña nunca van en la URL", async (t) => {
    const { calls } = mockMoodle(t);
    await extractGrades(CREDS, OPTS);

    for (const call of calls) {
      assert.ok(!call.url.includes("wstoken"));
      assert.ok(!call.url.includes(TOKEN));
      assert.ok(!call.url.includes(CREDS.password));
    }
    assert.equal(calls.find((c) => c.key === "token").body.get("service"), "moodle_mobile_app");
  });

  test("encodeParams usa el formato de arreglos de Moodle", () => {
    const body = encodeParams({ courseids: [1, 2], options: { a: true }, x: null });
    assert.equal(body.toString(), "courseids%5B0%5D=1&courseids%5B1%5D=2&options%5Ba%5D=1");
  });
});
