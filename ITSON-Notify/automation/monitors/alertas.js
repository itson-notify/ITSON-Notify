// Punto de enganche para avisar de fallos que necesitan intervención manual
// (contraseña por cambiar, credenciales rechazadas). Lo llama
// schedulers/extraccion-cron.js antes de terminar con código distinto de 0.
//
// PENDIENTE ITN-38/ITN-39: aquí se enviará la alerta por Telegram. Mientras
// tanto solo deja una línea en los logs de Railway, fácil de buscar con
// "ALERTA_RPA".
//
// El evento nunca debe llevar usuario, matrícula, contraseña ni token:
//   { tipo: 'cambio_password' | 'credenciales', fuente: 'ivirtual-api', fecha: ISO }

async function notificarFalloCritico(evento, { log = console.error } = {}) {
  log(`ALERTA_RPA ${JSON.stringify(evento)} (aviso por Telegram pendiente: ITN-38/ITN-39)`);
}

module.exports = { notificarFalloCritico };
