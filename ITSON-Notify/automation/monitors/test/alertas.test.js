// Pruebas de notificarFalloCritico con el envío simulado. Datos inventados.
const { test, describe } = require("node:test");
const assert = require("node:assert/strict");

const { notificarFalloCritico, nombreErrorSeguro } = require("../alertas");
const { validarMensaje } = require("../telegram");

const FECHA = "2026-10-20T14:00:00.000Z";

function simular(t, respuesta = { ok: true }) {
  const lineas = [];
  const enviar = t.mock.fn(async () => respuesta);
  const log = (linea) => lineas.push(linea);
  const notificar = (evento) => notificarFalloCritico(evento, { log, enviar });
  const texto = () => enviar.mock.calls[0].arguments[0];
  return { notificar, enviar, lineas, texto };
}

const CASOS = [
  [
    "cambio_password",
    { tipo: "cambio_password", fuente: "ivirtual-api" },
    "ITSON Notify: extracción detenida por cambio_password (ivirtual-api). Requiere intervención manual.",
  ],
  [
    "credenciales",
    { tipo: "credenciales", fuente: "ivirtual-api" },
    "ITSON Notify: credenciales de iVirtual rechazadas (ivirtual-api). Pausa el worker con RPA_PAUSADO=true y revisa.",
  ],
  [
    "error sin código",
    { tipo: "error", fuente: "ivirtual-api", errorcode: null },
    "ITSON Notify: extracción fallida tras los reintentos (ivirtual-api). Se intentará en la siguiente corrida; revisa los logs de worker-rpa.",
  ],
  [
    "error con código",
    { tipo: "error", fuente: "ivirtual-api", errorcode: "invalidtoken" },
    "ITSON Notify: extracción fallida tras los reintentos (ivirtual-api, código invalidtoken). Se intentará en la siguiente corrida; revisa los logs de worker-rpa.",
  ],
  [
    "excepción",
    { tipo: "excepcion", fuente: "worker-rpa", nombre_error: "TypeError" },
    "ITSON Notify: excepción no controlada en la corrida (worker-rpa, error TypeError). Revisa los logs de worker-rpa en Railway.",
  ],
  [
    "configuración",
    { tipo: "configuracion", fuente: "worker-rpa" },
    "ITSON Notify: corrida cancelada, falta configuración o es inválida (worker-rpa). Revisa las variables del servicio en Railway.",
  ],
  [
    "tipo desconocido",
    { tipo: "constructor", fuente: "worker-rpa" },
    "ITSON Notify: fallo sin clasificar en la corrida (worker-rpa). Revisa los logs de worker-rpa en Railway.",
  ],
];

describe("notificarFalloCritico", () => {
  for (const [nombre, evento, esperado] of CASOS) {
    test(`${nombre}: manda el texto esperado y pasa validarMensaje`, async (t) => {
      const s = simular(t);

      await s.notificar({ ...evento, fecha: FECHA });

      assert.equal(s.enviar.mock.callCount(), 1);
      assert.equal(s.texto(), esperado);
      assert.equal(validarMensaje(s.texto()), null);
    });
  }

  test("deja ALERTA_RPA en el log, sin la leyenda de pendiente", async (t) => {
    const s = simular(t);

    await s.notificar({ tipo: "credenciales", fuente: "ivirtual-api", fecha: FECHA });

    assert.deepEqual(s.lineas, [
      `ALERTA_RPA {"tipo":"credenciales","fuente":"ivirtual-api","fecha":"${FECHA}"}`,
    ]);
  });

  test("pasa log y env al envío", async (t) => {
    const enviar = t.mock.fn(async () => ({ ok: true }));
    const log = () => {};
    const env = { TELEGRAM_CHAT_ID: "-100123" };

    await notificarFalloCritico({ tipo: "error" }, { log, env, enviar });

    const [, opciones] = enviar.mock.calls[0].arguments;
    assert.equal(opciones.log, log);
    assert.equal(opciones.env, env);
  });

  test("campos extra no llegan al mensaje ni al log", async (t) => {
    const s = simular(t);
    const extras = {
      usuario: "usuario-fuga",
      matricula: "00000123456",
      correo: "alumno-fuga@example.test",
      password: "password-fuga",
      token: "token-fuga",
      url: "https://fuga.example.test/ruta",
      message: "mensaje-libre-fuga",
      error: "error-libre-fuga",
    };

    await s.notificar({ tipo: "error", fuente: "ivirtual-api", fecha: FECHA, ...extras });

    const todo = [s.texto(), ...s.lineas].join("\n");
    for (const valor of Object.values(extras)) {
      assert.ok(!todo.includes(valor), `se filtró ${valor}`);
    }
    assert.equal(validarMensaje(s.texto()), null);
  });

  const CAMPOS_INVALIDOS = [
    ["errorcode con mayúsculas", { errorcode: "Invalid_Token" }, "Invalid_Token"],
    ["errorcode con correo", { errorcode: "a@example.test" }, "a@example.test"],
    ["errorcode con salto de línea", { errorcode: "abc\nfuga" }, "fuga"],
    ["errorcode que no es texto", { errorcode: ["abc"] }, "abc"],
    ["errorcode de 41 letras", { errorcode: "a".repeat(41) }, "a".repeat(41)],
    ["nombre_error con texto libre", { nombre_error: "falló para alumno" }, "alumno"],
    ["fuente no permitida", { fuente: "alumno-fuga" }, "alumno-fuga"],
    ["tipo con texto libre", { tipo: "usuario-fuga" }, "usuario-fuga"],
    ["fecha con texto libre", { fecha: "usuario-fuga" }, "usuario-fuga"],
  ];
  for (const [nombre, campos, fuga] of CAMPOS_INVALIDOS) {
    test(`descarta ${nombre}`, async (t) => {
      const s = simular(t);

      await s.notificar({ tipo: "error", fuente: "ivirtual-api", ...campos });

      assert.ok(![s.texto(), ...s.lineas].join("\n").includes(fuga));
      assert.equal(validarMensaje(s.texto()), null);
    });
  }

  test("errorcode válido pero largo: avisa sin él, no pierde la alerta", async (t) => {
    const s = simular(t);
    const largo = "a".repeat(35);

    await s.notificar({ tipo: "error", fuente: "ivirtual-api", errorcode: largo });

    assert.ok(!s.texto().includes(largo));
    assert.equal(validarMensaje(s.texto()), null);
  });

  test("si el envío devuelve ok:false no lanza", async (t) => {
    const s = simular(t, { ok: false, motivo: "error_telegram" });

    await assert.doesNotReject(s.notificar({ tipo: "credenciales" }));
  });

  test("si el envío lanza no lanza ni repite el mensaje del error", async (t) => {
    const lineas = [];
    const enviar = async () => {
      throw new TypeError("https://api.telegram.org/botsecreto-fuga/sendMessage");
    };

    const r = await notificarFalloCritico(
      { tipo: "credenciales" },
      { log: (l) => lineas.push(l), enviar },
    );

    assert.deepEqual(r, { ok: false, motivo: "error_alerta" });
    assert.equal(lineas.at(-1), "Alerta del RPA no enviada: TypeError.");
    assert.ok(!lineas.join("\n").includes("secreto-fuga"));
  });

  test("si el log lanza no lanza", async () => {
    const log = () => {
      throw new Error("sin log");
    };

    await assert.doesNotReject(notificarFalloCritico({ tipo: "error" }, { log }));
  });

  for (const evento of [undefined, null, "texto", 42]) {
    test(`evento ${JSON.stringify(evento)}: no lanza y avisa sin clasificar`, async (t) => {
      const s = simular(t);

      await s.notificar(evento);

      assert.match(s.texto(), /fallo sin clasificar/);
    });
  }
});

describe("nombreErrorSeguro", () => {
  test("acepta nombres de clase", () => assert.equal(nombreErrorSeguro("TypeError"), "TypeError"));

  for (const nombre of ["usuario-fuga", "Error: fuga", "a@b.test", "", null, undefined, {}]) {
    test(`rechaza ${JSON.stringify(nombre)}`, () => assert.equal(nombreErrorSeguro(nombre), null));
  }
});
