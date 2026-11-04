const { sendTeamAlert, validarMensaje } = require("./telegram");

// Aviso al equipo cuando falla una corrida del RPA (ITN-39). Lo llama
// schedulers/extraccion-cron.js antes de terminar con código distinto de 0.
// Deja una línea en los logs de Railway, fácil de buscar con "ALERTA_RPA", y
// manda el mensaje por Telegram con sendTeamAlert.
//
// Evento esperado:
//   { tipo, fuente, fecha: ISO, errorcode?: 'invalidtoken', nombre_error?: 'TypeError' }
//
// Lista blanca: log y mensaje se arman solo con estos campos, y solo si tienen
// la forma esperada. Lo demás se descarta aunque venga en el evento (usuario,
// matrícula, correo, contraseña, token, URL, error.message).
//
// No hay deduplicación: el worker no guarda estado entre corridas, así que un
// fallo que persista alerta en cada una. Para callarlo: RPA_PAUSADO=true.

const PLANTILLAS = {
  cambio_password: (origen) =>
    `ITSON Notify: extracción detenida por cambio_password (${origen}). Requiere intervención manual.`,
  credenciales: (origen) =>
    `ITSON Notify: credenciales de iVirtual rechazadas (${origen}). Pausa el worker con RPA_PAUSADO=true y revisa.`,
  error: (origen) =>
    `ITSON Notify: extracción fallida tras los reintentos (${origen}). Se intentará en la siguiente corrida; revisa los logs de worker-rpa.`,
  excepcion: (origen) =>
    `ITSON Notify: excepción no controlada en la corrida (${origen}). Revisa los logs de worker-rpa en Railway.`,
  configuracion: (origen) =>
    `ITSON Notify: corrida cancelada, falta configuración o es inválida (${origen}). Revisa las variables del servicio en Railway.`,
  desconocido: (origen) =>
    `ITSON Notify: fallo sin clasificar en la corrida (${origen}). Revisa los logs de worker-rpa en Railway.`,
};

const FUENTES = new Set(["ivirtual-api", "worker-rpa"]);
const FUENTE_POR_DEFECTO = "worker-rpa";

const RE_ERRORCODE = /^[a-z_]{1,40}$/;
const RE_NOMBRE_ERROR = /^[A-Z][A-Za-z]{0,39}$/;
const RE_FECHA = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?Z$/;

const coincide = (valor, re) => typeof valor === "string" && re.test(valor);

// El nombre de un error solo sirve si parece un nombre de clase (TypeError).
function nombreErrorSeguro(nombre) {
  return coincide(nombre, RE_NOMBRE_ERROR) ? nombre : null;
}

function normalizarEvento(evento) {
  const { tipo, fuente, fecha, errorcode, nombre_error: nombreError } = evento ?? {};
  const seguro = {
    tipo: typeof tipo === "string" && Object.hasOwn(PLANTILLAS, tipo) ? tipo : "desconocido",
    fuente: FUENTES.has(fuente) ? fuente : FUENTE_POR_DEFECTO,
  };
  if (coincide(fecha, RE_FECHA)) seguro.fecha = fecha;
  if (coincide(errorcode, RE_ERRORCODE)) seguro.errorcode = errorcode;
  if (nombreErrorSeguro(nombreError)) seguro.nombre_error = nombreError;
  return seguro;
}

function armarTexto({ tipo, fuente, errorcode, nombre_error: nombreError }) {
  const plantilla = PLANTILLAS[tipo];
  const detalles = [];
  if (errorcode) detalles.push(`código ${errorcode}`);
  if (nombreError) detalles.push(`error ${nombreError}`);
  const texto = plantilla([fuente, ...detalles].join(", "));
  // Un código de 32 a 40 letras pasa RE_ERRORCODE pero el filtro de Telegram lo
  // toma por llave y rechazaría el mensaje completo: mejor avisar sin el detalle.
  return validarMensaje(texto) === null ? texto : plantilla(fuente);
}

async function notificarFalloCritico(evento, opciones) {
  const { log = console.error, env, enviar = sendTeamAlert } = opciones ?? {};
  try {
    const seguro = normalizarEvento(evento);
    log(`ALERTA_RPA ${JSON.stringify(seguro)}`);
    return await enviar(armarTexto(seguro), { log, env });
  } catch (error) {
    // Una alerta caída nunca debe cambiar el código de salida de la corrida.
    try {
      log(`Alerta del RPA no enviada: ${nombreErrorSeguro(error?.name) ?? "Error"}.`);
    } catch {
      // Sin dónde registrarlo: la corrida termina con su propio código.
    }
    return { ok: false, motivo: "error_alerta" };
  }
}

module.exports = { notificarFalloCritico, nombreErrorSeguro };
