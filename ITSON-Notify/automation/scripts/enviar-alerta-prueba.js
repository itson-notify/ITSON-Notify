const path = require("path");
require("dotenv").config({
  path: path.join(__dirname, "..", "..", ".env"),
  quiet: true,
});
const { sendTeamAlert } = require("../monitors/telegram");

// Manda un mensaje de prueba fijo al chat del equipo (ITN-38) para confirmar
// que TELEGRAM_BOT_TOKEN y TELEGRAM_CHAT_ID están bien. Lee las variables del
// .env de ITSON-Notify/ o del entorno (p. ej. `railway run`).
//
//   npm run alert:test        (desde ITSON-Notify/ o desde automation/)
//
// Sale con 0 si Telegram aceptó el mensaje y con 1 en cualquier otro caso.
const MENSAJE = "ITSON Notify: mensaje de prueba de alertas (ITN-38). Si lo ves, el bot funciona.";

sendTeamAlert(MENSAJE).then((resultado) => {
  if (resultado.ok) {
    console.error("Mensaje de prueba enviado al chat del equipo.");
  } else {
    console.error(`No se envió el mensaje de prueba (${resultado.motivo}).`);
    process.exitCode = 1;
  }
});
