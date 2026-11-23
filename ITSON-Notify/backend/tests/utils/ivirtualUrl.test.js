// ITN-58g - Enlace a la página de una materia de iVirtual (función pura). Ids inventados.
const { test, describe } = require("node:test");
const assert = require("node:assert/strict");

const { urlMateriaIvirtual } = require("../../src/utils/ivirtualUrl");

const BASE = "https://ivirtual.itson.edu.mx/course/view.php?id=";

describe("ITN-58g - urlMateriaIvirtual", () => {
  test("ids válidos: entero positivo de 1 a 10 dígitos, string o número", () => {
    for (const [id, esperado] of [
      ["12345", "12345"],
      ["1", "1"],
      ["9999999999", "9999999999"],
      [12345, "12345"],
      [7, "7"],
    ]) {
      assert.equal(urlMateriaIvirtual(id), `${BASE}${esperado}`);
    }
  });

  test("no numéricos, vacíos, cero, negativos, con espacios o de más de 10 dígitos devuelven null", () => {
    for (const malo of [
      "", "   ", "abc", "12a45", "CAT-1", "1.5", "1e5", "0x1F", "+123", "-5", "0", "00", "012345",
      " 12345", "12345 ", "12 345", "\n12345", "12345678901", "123456789012345",
      "12345&id=2", "12345#x", "javascript:alert(1)",
      0, -5, 1.5, 12345678901, Number.NaN, Infinity,
    ]) {
      assert.equal(urlMateriaIvirtual(malo), null, JSON.stringify(malo));
    }
  });

  test("no-string ni número devuelven null", () => {
    for (const malo of [null, undefined, true, false, {}, [], ["12345"], 12345n, () => "12345"]) {
      assert.equal(urlMateriaIvirtual(malo), null, String(malo));
    }
  });
});
