const path = require("path");
require("dotenv").config({
  path: path.join(__dirname, "..", "..", ".env"),
  quiet: true,
});
const { extractGrades } = require("../rpa/ivirtual-api");
const { notificarFalloCritico } = require("../monitors/alertas");
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
const EXIT_CODES = { ok: 0, credenciales: 1, error: 1, cambio_password: 2 };

// Fallos que no se arreglan solos: avisar y esperar intervención manual.
// Con 'credenciales' además conviene pausar (RPA_PAUSADO=true) para no sumar
// intentos fallidos a la cuenta en cada corrida.
const FALLOS_CRITICOS = new Set(["cambio_password", "credenciales"]);

async function ejecutar({
  env = process.env,
  extract = extractGrades,
  alertar = notificarFalloCritico,
  entregar = entregarResultados,
  log = console.error,
} = {}) {
  if (env.RPA_PAUSADO === "true") {
    log("RPA pausado (RPA_PAUSADO=true). No se consulta iVirtual.");
    return EXIT_CODES.ok;
  }
  if (!env.Id_User || !env.P_User) {
    log("Faltan Id_User o P_User en las variables del servicio.");
    return EXIT_CODES.error;
  }
  // Antes de consultar iVirtual: sin backend la extracción no sirve de nada.
  const entrega = leerConfigEntrega(env);
  if (!entrega.ok) {
    log(entrega.error);
    return EXIT_CODES.error;
  }

  log("Consultando iVirtual (API de Moodle)...");
  const result = await extract({ usuario: env.Id_User, password: env.P_User });

  if (result.status === "ok") {
    const items = result.courses.reduce((n, c) => n + c.items.length, 0);
    const capturedAt = new Date().toISOString();
    log(`Extracción correcta: ${result.courses.length} curso(s), ${items} ítem(s).`);
    const envio = await entregar(result, { config: entrega.config, capturedAt, log });
    return envio.ok ? EXIT_CODES.ok : EXIT_CODES.error;
  }

  if (FALLOS_CRITICOS.has(result.status)) {
    log(`Extracción detenida: ${result.status}. Se requiere intervención manual.`);
    await alertar(
      { tipo: result.status, fuente: "ivirtual-api", fecha: new Date().toISOString() },
      { log },
    );
    return EXIT_CODES[result.status];
  }

  // Falla pasajera (red, 5xx, Moodle): ya hubo reintentos dentro del cliente;
  // la siguiente corrida del cron lo vuelve a intentar.
  log(`Extracción fallida: ${result.error ?? result.status}`);
  return EXIT_CODES.error;
}

if (require.main === module) {
  ejecutar()
    .then((code) => {
      process.exitCode = code;
    })
    .catch((error) => {
      console.error("Error durante la extracción programada:", error.message);
      process.exitCode = 1;
    });
}

module.exports = { ejecutar, EXIT_CODES };
