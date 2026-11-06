// ITN-53: texto relativo de las fechas ISO de la API.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { compile } = require('./harness.cjs');

const { timeAgo } = compile('utils/time.ts', require);
const NOW = Date.parse('2026-11-06T12:00:00.000Z');
const antes = ms => new Date(NOW - ms).toISOString();
const MIN = 60_000; const HORA = 60 * MIN; const DIA = 24 * HORA;

test('convierte fechas ISO a texto relativo', () => {
  for (const [ms, esperado] of [
    [0, 'Hace un momento'],
    [59_000, 'Hace un momento'],
    [MIN, 'Hace 1 min'],
    [59 * MIN, 'Hace 59 min'],
    [HORA, 'Hace 1 h'],
    [2 * HORA, 'Hace 2 h'],
    [23 * HORA, 'Hace 23 h'],
    [DIA, 'Hace 1 día'],
    [5 * DIA, 'Hace 5 días'],
    [30 * DIA, 'Hace 1 mes'],
    [65 * DIA, 'Hace 2 meses'],
  ]) assert.equal(timeAgo(antes(ms), NOW), esperado);
});

test('acepta el desfase +00:00 de PostgREST', () => {
  assert.equal(timeAgo('2026-11-06T10:00:00+00:00', NOW), 'Hace 2 h');
});

test('una fecha futura por desfase de reloj no da un número negativo', () => {
  assert.equal(timeAgo(antes(-5 * MIN), NOW), 'Hace un momento');
});

test('deja igual los textos de mockData y lo que no es una fecha', () => {
  for (const texto of ['Hace 2 h', 'Hace 1 día', 'test 2', '', '2026-99-99T00:00:00Z']) {
    assert.equal(timeAgo(texto, NOW), texto);
  }
});
