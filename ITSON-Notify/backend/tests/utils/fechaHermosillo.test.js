// ITN-56 - Fechas de entrega en hora de Hermosillo (UTC-7 todo el año).
const { test, describe } = require("node:test");
const assert = require("node:assert/strict");

const { formatearFechaHermosillo, fraseEntrega } = require("../../src/utils/fechaHermosillo");

describe("formatearFechaHermosillo", () => {
  test("una fecha UTC pasada la medianoche cae en el día anterior en Hermosillo", () => {
    // 06:59 UTC del sábado 21 = 23:59 del viernes 20 en Hermosillo.
    assert.equal(formatearFechaHermosillo("2026-11-21T06:59:00Z"), "viernes 20 de noviembre de 2026, 23:59");
  });

  test("a las 07:00 UTC ya es medianoche del mismo día en Hermosillo", () => {
    assert.equal(formatearFechaHermosillo("2026-11-21T07:00:00Z"), "sábado 21 de noviembre de 2026, 00:00");
  });

  test("respeta el desfase si la fecha trae otra zona", () => {
    assert.equal(formatearFechaHermosillo("2026-11-20T23:59:00-07:00"), "viernes 20 de noviembre de 2026, 23:59");
  });

  test("sin horario de verano: en julio también es UTC-7", () => {
    assert.equal(formatearFechaHermosillo("2026-07-01T06:30:00Z"), "martes 30 de junio de 2026, 23:30");
  });

  test("cambio de año", () => {
    assert.equal(formatearFechaHermosillo("2027-01-01T03:00:00Z"), "jueves 31 de diciembre de 2026, 20:00");
  });

  test("null, vacío o basura devuelven null", () => {
    for (const v of [null, undefined, "", "mañana"]) assert.equal(formatearFechaHermosillo(v), null);
  });
});

describe("fraseEntrega", () => {
  test("con fecha, sin fecha (null) y desconocida (undefined)", () => {
    assert.equal(
      fraseEntrega("2026-11-21T06:59:00.000Z"),
      "Fecha de entrega: viernes 20 de noviembre de 2026, 23:59 (hora de Hermosillo).",
    );
    assert.equal(fraseEntrega(null), "Sin fecha de entrega.");
    assert.equal(fraseEntrega(undefined), null);
  });
});
