// ITN-58e - Validación del enlace de una tarea de Classroom (función pura).
const { test, describe } = require("node:test");
const assert = require("node:assert/strict");

const { urlClassroomSegura } = require("../../src/utils/classroomUrl");

describe("ITN-58e - urlClassroomSegura", () => {
  test("acepta enlaces https de classroom.google.com", () => {
    for (const url of [
      "https://classroom.google.com/c/MTIz/a/NDU2/details",
      "https://classroom.google.com/u/0/c/MTIz/a/NDU2/details",
      "https://classroom.google.com/",
    ]) {
      assert.equal(urlClassroomSegura(url), url);
    }
  });

  test("rechaza http, otros esquemas y otros hosts", () => {
    for (const url of [
      "http://classroom.google.com/c/1/a/2/details",
      "javascript:alert(1)",
      "JavaScript:alert(1)",
      "data:text/html,<script>alert(1)</script>",
      "ftp://classroom.google.com/c/1",
      "https://evil.com/c/1/a/2/details",
      "https://google.com/c/1",
      "https://docs.google.com/c/1",
      "https://classroom.google.com.evil.com/c/1/a/2/details",
      "https://evilclassroom.google.com/c/1",
      "https://classroom.google.com:8443/c/1",
      "https://usuario:clave@classroom.google.com/c/1",
      "https://usuario@classroom.google.com/c/1",
      "//classroom.google.com/c/1",
      "/c/1/a/2/details",
    ]) {
      assert.equal(urlClassroomSegura(url), null, url);
    }
  });

  test("rechaza vacíos, no-strings y textos demasiado largos", () => {
    for (const valor of ["", "   ", null, undefined, 42, {}, [], true]) {
      assert.equal(urlClassroomSegura(valor), null, String(valor));
    }
    assert.equal(urlClassroomSegura(`https://classroom.google.com/${"a".repeat(3000)}`), null);
  });
});
