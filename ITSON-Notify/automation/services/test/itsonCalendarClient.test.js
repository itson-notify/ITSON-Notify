// ITN-60 - Cliente del calendario público de ITSON con fetch simulado. Fixtures
// inventados con la forma del portal; sin red.
const { test, describe } = require("node:test");
const assert = require("node:assert/strict");

const {
  crearClienteCalendario, normalizarEvento, htmlATexto, leerFechaLocal, BASE_URL,
} = require("../itsonCalendarClient");

const entrada = (id, token = `tok${id}abcdefgh`) => ({
  calendarId: id, title: `Evento ${id}`, dateStr: "05 Dic", ispublished: true,
  startTimeStr: "Inicia el 5 de Diciembre", url: `${BASE_URL}/x/${token}`, tokenEncriptor: token,
});
const detalle = (id, extra = {}) => ({
  calendarID: id,
  title: `  Evento   de prueba ${id} `,
  includeImg: false,
  location: "Virtual",
  imagePath: null,
  startTime: "2026-12-05T08:00:00",
  endTime: "2026-12-05T23:59:00",
  eventDescription: "<p>Último&nbsp;día&nbsp;de&nbsp;clases.</p><p>Segunda &amp; línea</p>",
  calendarGallery: "galeria",
  campus: ["Campus A"],
  categorys: ["Registro Escolar"],
  documents: [],
  ...extra,
});

const respuesta = (status, cuerpo) => ({
  ok: status >= 200 && status < 300,
  status,
  json: async () => (typeof cuerpo === "function" ? cuerpo() : cuerpo),
});

// fetch simulado: `rutas` mapea un sufijo de URL a una lista de respuestas (o
// errores) que se van consumiendo; la última se repite.
function fetchSimulado(rutas) {
  const llamadas = [];
  const fn = async (url, opciones) => {
    llamadas.push({ url, opciones });
    const clave = Object.keys(rutas).find((k) => url.endsWith(k));
    if (!clave) throw new Error(`ruta no simulada: ${url}`);
    const cola = rutas[clave];
    const r = cola.length > 1 ? cola.shift() : cola[0];
    if (r instanceof Error) throw r;
    return r;
  };
  return { fn, llamadas };
}

const LISTA = "/CalendarBySite?numPage=100&siteId=3";
const cliente = (fetchFn) => crearClienteCalendario({ fetchFn, sleep: async () => {}, pausaMs: 0 });
const errorTimeout = () => Object.assign(new Error("timeout"), { name: "TimeoutError" });

describe("ITN-60 - parseo del portal", () => {
  test("evento de días completos (termina 23:59): de 00:00:00 a 23:59:59 con -07:00", () => {
    assert.deepEqual(normalizarEvento(detalle(137)), {
      externalId: "137",
      title: "Evento de prueba 137",
      description: "Último día de clases.\nSegunda & línea",
      startsAt: "2026-12-05T00:00:00-07:00",
      endsAt: "2026-12-05T23:59:59-07:00",
      allDay: true,
      category: "Registro Escolar",
    });
  });

  test("evento de varios días completos conserva día de inicio y de fin", () => {
    const e = normalizarEvento(detalle(143, { startTime: "2026-12-17T08:00:00", endTime: "2027-01-03T23:59:00" }));
    assert.equal(e.startsAt, "2026-12-17T00:00:00-07:00");
    assert.equal(e.endsAt, "2027-01-03T23:59:59-07:00");
    assert.equal(e.allDay, true);
  });

  test("evento con hora: conserva la hora local de Hermosillo", () => {
    const e = normalizarEvento(detalle(4589, {
      startTime: "2026-11-19T14:30:00", endTime: "2026-11-19T16:00:00", categorys: [],
    }));
    assert.equal(e.allDay, false);
    assert.equal(e.startsAt, "2026-11-19T14:30:00-07:00");
    assert.equal(e.endsAt, "2026-11-19T16:00:00-07:00");
    assert.equal(e.category, null);
    assert.equal(Date.parse(e.startsAt), Date.parse("2026-11-19T21:30:00Z"));
  });

  for (const [nombre, extra] of [
    ["sin id", { calendarID: null }],
    ["título vacío", { title: "  " }],
    ["fecha que no existe", { startTime: "2026-02-30T08:00:00" }],
    ["fecha con otro formato", { startTime: "05/12/2026" }],
    ["fin antes del inicio", { startTime: "2026-12-05T10:00:00", endTime: "2026-12-05T09:00:00" }],
  ]) {
    test(`descarta: ${nombre}`, () => {
      assert.equal(normalizarEvento(detalle(1, extra)), null);
    });
  }

  test("htmlATexto quita etiquetas y scripts y decodifica entidades", () => {
    assert.equal(htmlATexto("<script>x()</script><b>Hola</b>&#233;&#x41;<br>fin"), "HolaéA\nfin");
    assert.equal(htmlATexto("<p></p>"), null);
    assert.equal(htmlATexto(null), null);
  });

  test("leerFechaLocal acepta segundos opcionales y rechaza horas imposibles", () => {
    assert.deepEqual(leerFechaLocal("2026-12-05T08:00"), { fecha: "2026-12-05", hora: 8, minuto: 0, segundo: 0 });
    assert.equal(leerFechaLocal("2026-12-05T24:00:00"), null);
  });
});

describe("ITN-60 - lectura con reintentos", () => {
  test("lee la lista y cada detalle por su token, solo GET con timeout", async () => {
    const { fn, llamadas } = fetchSimulado({
      [LISTA]: [respuesta(200, [entrada(137), entrada(143), { ...entrada(9), ispublished: false }])],
      "/GetEvent/tok137abcdefgh": [respuesta(200, detalle(137))],
      "/GetEvent/tok143abcdefgh": [respuesta(200, detalle(143))],
    });
    const r = await cliente(fn).obtenerEventos();
    assert.equal(r.ok, true);
    assert.deepEqual(r.eventos.map((e) => e.externalId), ["137", "143"]);
    assert.equal(r.fallidos, 0);
    assert.equal(r.descartados, 0);
    assert.equal(llamadas.length, 3);
    for (const { opciones } of llamadas) {
      assert.equal(opciones.method, "GET");
      assert.ok(opciones.signal instanceof AbortSignal);
    }
  });

  test("reintenta ante red, timeout y 5xx y sigue con éxito", async () => {
    const { fn, llamadas } = fetchSimulado({
      [LISTA]: [new TypeError("fetch failed"), errorTimeout(), respuesta(200, [entrada(137)])],
      "/GetEvent/tok137abcdefgh": [respuesta(503, null), respuesta(200, detalle(137))],
    });
    const r = await cliente(fn).obtenerEventos();
    assert.equal(r.ok, true);
    assert.equal(r.eventos.length, 1);
    assert.equal(llamadas.length, 5);
  });

  test("tras agotar los reintentos de la lista devuelve ok: false con el motivo", async () => {
    const { fn, llamadas } = fetchSimulado({ [LISTA]: [errorTimeout()] });
    const r = await cliente(fn).obtenerEventos();
    assert.deepEqual(r, { ok: false, motivo: "timeout", status: null });
    assert.equal(llamadas.length, 3);
  });

  test("un 4xx no se reintenta", async () => {
    const { fn, llamadas } = fetchSimulado({ [LISTA]: [respuesta(404, null)] });
    const r = await cliente(fn).obtenerEventos();
    assert.deepEqual(r, { ok: false, motivo: "http", status: 404 });
    assert.equal(llamadas.length, 1);
  });

  test("un detalle que falla no tumba la corrida: se cuenta y se siguen los demás", async () => {
    const { fn, llamadas } = fetchSimulado({
      [LISTA]: [respuesta(200, [entrada(1), entrada(2), entrada(3)])],
      "/GetEvent/tok1abcdefgh": [respuesta(400, null)],
      "/GetEvent/tok2abcdefgh": [respuesta(500, null)],
      "/GetEvent/tok3abcdefgh": [respuesta(200, detalle(3))],
    });
    const r = await cliente(fn).obtenerEventos();
    assert.equal(r.ok, true);
    assert.deepEqual(r.eventos.map((e) => e.externalId), ["3"]);
    assert.equal(r.fallidos, 2);
    const detalles = (t) => llamadas.filter((l) => l.url.endsWith(t)).length;
    assert.equal(detalles("tok1abcdefgh"), 1); // 400: sin reintento
    assert.equal(detalles("tok2abcdefgh"), 3); // 500: 1 + 2 reintentos
  });

  test("descarta entradas con token raro o detalles de otro evento", async () => {
    const { fn } = fetchSimulado({
      [LISTA]: [respuesta(200, [entrada(1, "../../x"), entrada(2), "basura"])],
      "/GetEvent/tok2abcdefgh": [respuesta(200, detalle(99))],
    });
    const r = await cliente(fn).obtenerEventos();
    assert.deepEqual({ ok: r.ok, n: r.eventos.length, descartados: r.descartados }, { ok: true, n: 0, descartados: 3 });
  });

  test("lista que no es arreglo: forma_invalida", async () => {
    const { fn } = fetchSimulado({ [LISTA]: [respuesta(200, { mensaje: "x" })] });
    assert.deepEqual(await cliente(fn).obtenerEventos(), { ok: false, motivo: "forma_invalida", status: null });
  });
});
