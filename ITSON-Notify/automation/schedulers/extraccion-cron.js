const path = require("path");
require("dotenv").config({
  path: path.join(__dirname, "..", "..", ".env"),
  quiet: true,
});
const { extractGrades } = require("../rpa/ivirtual-api");
const { notificarFalloCritico, nombreErrorSeguro } = require("../monitors/alertas");
const { entregarResultados, leerConfigEntrega } = require("./entrega-backend");

// Punto de entrada del cron de Railway (ITN-25). Railway lo arranca según el
// cronSchedule de .railway/railway.ts; corre UNA extracción y termina.
// La política de reinicio del servicio es NEVER: un código distinto de 0 no
// provoca reintentos, la siguiente corrida es la del próximo horario.
//
// Códigos de salida (mismos que cli.js y login-demo.js):
//   0  éxito, o RPA_PAUSADO=true
//   1  credenciales incorrectas, error, configuración incompleta o entrega
//      al backend fallida tras los reintentos
//   2  iVirtual pide cambio de contraseña
//
// A diferencia de cli.js, nunca imprime calificaciones: los logs de Railway
// solo llevan conteos. No loguear usuario, contraseña ni token.
//
// Railway marca como error todo lo que sale por stderr: lo informativo va por
// log (stdout) y las fallas por logError (stderr).
//
// Alertas al equipo (ITN-39): todo código distinto de 0 avisa por Telegram y se
// espera el envío antes de terminar. La entrega fallida ya alerta dentro de
// entrega-backend.js, por eso aquí no se repite.
const EXIT_CODES = { ok: 0, credenciales: 1, error: 1, cambio_password: 2 };

const VARIABLES_SECRETAS = [
  "Id_User",
  "P_User",
  "INTERNAL_API_KEY",
  "ALUMNO_EMAIL",
  "TELEGRAM_BOT_TOKEN",
];

// result.error es texto libre (a veces el mensaje de Moodle): se quitan los
// valores conocidos por si los repite antes de llevarlo a los logs.
function ocultarValores(texto, env) {
  return VARIABLES_SECRETAS.reduce((limpio, nombre) => {
    const valor = env[nombre]?.trim();
    return valor ? limpio.split(valor).join("[oculto]") : limpio;
  }, String(texto));
}

// Fallos que no se arreglan solos: avisar y esperar intervención manual.
// Con 'credenciales' además conviene pausar (RPA_PAUSADO=true) para no sumar
// intentos fallidos a la cuenta en cada corrida.
const FALLOS_CRITICOS = new Set(["cambio_password", "credenciales"]);

async function ejecutar({
  env = process.env,
  extract = extractGrades,
  alertar = notificarFalloCritico,
  entregar = entregarResultados,
  log = console.log,
  logError = console.error,
} = {}) {
  // El env de la corrida también decide a qué chat de Telegram se avisa.
  const avisar = (evento) =>
    alertar({ ...evento, fecha: new Date().toISOString() }, { log: logError, env });

  if (env.RPA_PAUSADO === "true") {
    log("RPA pausado (RPA_PAUSADO=true). No se consulta iVirtual.");
    return EXIT_CODES.ok;
  }
  if (!env.Id_User || !env.P_User) {
    logError("Faltan Id_User o P_User en las variables del servicio.");
    await avisar({ tipo: "configuracion", fuente: "worker-rpa" });
    return EXIT_CODES.error;
  }
  // Antes de consultar iVirtual: sin backend la extracción no sirve de nada.
  const entrega = leerConfigEntrega(env);
  if (!entrega.ok) {
    logError(entrega.error);
    await avisar({ tipo: "configuracion", fuente: "worker-rpa" });
    return EXIT_CODES.error;
  }

  log("Consultando iVirtual (API de Moodle)...");
  const result = await extract({ usuario: env.Id_User, password: env.P_User });

  if (result.status === "ok") {
    const items = result.courses.reduce((n, c) => n + c.items.length, 0);
    const capturedAt = new Date().toISOString();
    log(`Extracción correcta: ${result.courses.length} curso(s), ${items} ítem(s).`);
    const envio = await entregar(result, { config: entrega.config, capturedAt, log, logError });
    return envio.ok ? EXIT_CODES.ok : EXIT_CODES.error;
  }

  if (FALLOS_CRITICOS.has(result.status)) {
    logError(`Extracción detenida: ${result.status}. Se requiere intervención manual.`);
    await avisar({ tipo: result.status, fuente: "ivirtual-api" });
    return EXIT_CODES[result.status];
  }

  // Falla pasajera (red, 5xx, Moodle): ya hubo reintentos dentro del cliente;
  // la siguiente corrida del cron lo vuelve a intentar.
  logError(`Extracción fallida: ${ocultarValores(result.error ?? result.status, env)}`);
  await avisar({ tipo: "error", fuente: "ivirtual-api", errorcode: result.errorcode });
  return EXIT_CODES.error;
}

// Última red del proceso. Solo el nombre del error, ni en logs ni en la alerta
// va error.message: podría traer valores de la configuración o de la respuesta.
async function arrancar({
  correr = ejecutar,
  alertar = notificarFalloCritico,
  logError = console.error,
} = {}) {
  try {
    return await correr();
  } catch (error) {
    const nombre = nombreErrorSeguro(error?.name) ?? "Error";
    logError(`Error durante la extracción programada: ${nombre}`);
    await alertar(
      {
        tipo: "excepcion",
        fuente: "worker-rpa",
        nombre_error: nombre,
        fecha: new Date().toISOString(),
      },
      { log: logError },
    );
    return EXIT_CODES.error;
  }
}

if (require.main === module) {
  arrancar().then((code) => {
    process.exitCode = code;
  });
}

module.exports = { ejecutar, arrancar, EXIT_CODES };
