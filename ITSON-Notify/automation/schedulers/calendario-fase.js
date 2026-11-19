// ITN-60 - Fase del calendario académico de ITSON. Corre después de las fases de
// iVirtual y de la API de ITSON (extraccion-cron.js), en su propio try/catch.
//
//   1. Lee el calendario público del portal institucional (services/itsonCalendarClient.js).
//   2. Manda los eventos que sí se pudieron leer a POST /internal/calendar-events
//      (INTERNAL_API_KEY), que hace upsert por external_id en un solo lote.
//
// A diferencia de las otras fases, esta NUNCA alerta ni hace que el worker salga con 1:
// el calendario no es crítico y cambia poco. Una falla (portal caído, 4xx, 5xx,
// timeout, backend inalcanzable) se registra en el log y la corrida sigue. Siempre
// devuelve 0.
//
// Para no consultar el portal en cada corrida del cron (cada 2 horas), por defecto
// solo corre cuando la hora de Hermosillo está en CALENDARIO_HORAS ("7,13,19").
// CALENDARIO_HORAS=* corre siempre. `npm run sync:calendar` la corre a mano, sin
// importar la hora.
//
// Privacidad: el calendario es público y no tiene datos de alumnos. Los logs llevan
// conteos, status HTTP y motivos; nunca la API key ni la URL del backend.
const { leerConfigEntrega } = require("./entrega-backend");
const { crearClienteCalendario } = require("../services/itsonCalendarClient");

const EXIT_CODES = { ok: 0, error: 1 };
const RUTA = "/internal/calendar-events";
const TIMEOUT_MS = 30_000;
const MAX_REINTENTOS = 2;
const BACKOFF_BASE_MS = 1_000;
const HORAS_POR_DEFECTO = [7, 13, 19];
const ZONA = "America/Hermosillo";

const esperar = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const esReintentable = (status) => status === null || status >= 500;

// Hora actual (0-23) en Hermosillo.
const horaEnHermosillo = (fecha = new Date()) =>
  Number(new Intl.DateTimeFormat("en-US", { timeZone: ZONA, hour: "numeric", hourCycle: "h23" }).format(fecha));

// "*" -> null (siempre). Lista "7,13" -> [7, 13]. Vacío -> por defecto. Inválido -> undefined.
function leerHoras(valor) {
  const crudo = valor?.trim();
  if (!crudo) return HORAS_POR_DEFECTO;
  if (crudo === "*") return null;
  const horas = crudo.split(",").map((h) => h.trim());
  if (!horas.every((h) => /^\d{1,2}$/.test(h) && Number(h) <= 23)) return undefined;
  return horas.map(Number);
}

// POST del lote al backend con reintentos ante red, timeout o 5xx.
// { ok: true, resultado } o { ok: false, status }.
async function entregarCalendario(eventos, { config, fetchFn = globalThis.fetch, sleep = esperar } = {}) {
  let ultimo;
  for (let intento = 0; intento <= MAX_REINTENTOS; intento += 1) {
    try {
      const res = await fetchFn(`${config.backendUrl}${RUTA}`, {
        method: "POST",
        headers: { "x-api-key": config.apiKey, "Content-Type": "application/json", Accept: "application/json" },
        body: JSON.stringify({ events: eventos }),
        signal: AbortSignal.timeout(TIMEOUT_MS),
      });
      const datos = await res.json().catch(() => null);
      ultimo = { ok: res.ok, status: res.status, resultado: datos };
    } catch (error) {
      ultimo = { ok: false, status: null, error: error?.name === "TimeoutError" ? "timeout" : "red" };
    }
    if (ultimo.ok || !esReintentable(ultimo.status) || intento === MAX_REINTENTOS) break;
    await sleep(BACKOFF_BASE_MS * 2 ** intento);
  }
  if (!ultimo.ok) return { ok: false, status: ultimo.status ?? ultimo.error };
  return { ok: true, resultado: ultimo.resultado };
}

async function ejecutarCalendario({
  env = process.env,
  forzar = false,
  crearCliente = crearClienteCalendario,
  entregar = entregarCalendario,
  hora = horaEnHermosillo,
  ocultar = (texto) => String(texto),
  log = console.log,
  logError = console.error,
} = {}) {
  const info = (linea) => log(ocultar(linea));
  const falla = (linea) => logError(ocultar(linea));

  try {
    if (env.RPA_PAUSADO === "true") {
      info("RPA pausado (RPA_PAUSADO=true). No se consulta el calendario.");
      return EXIT_CODES.ok;
    }
    if (!forzar) {
      const horas = leerHoras(env.CALENDARIO_HORAS);
      if (horas === undefined) {
        falla("Fase del calendario omitida: CALENDARIO_HORAS debe ser * o horas 0-23 separadas por coma.");
        return EXIT_CODES.ok;
      }
      if (horas !== null && !horas.includes(hora())) {
        info("Fase del calendario omitida: no es una hora programada.");
        return EXIT_CODES.ok;
      }
    }

    const entrega = leerConfigEntrega(env);
    if (!entrega.ok) {
      falla(`Fase del calendario omitida: ${entrega.error}`);
      return EXIT_CODES.ok;
    }

    const lectura = await crearCliente().obtenerEventos();
    if (!lectura.ok) {
      falla(`Calendario no disponible: motivo=${lectura.motivo} status=${lectura.status ?? "sin_respuesta"}. Se sigue.`);
      return EXIT_CODES.ok;
    }
    const { eventos, descartados, fallidos } = lectura;
    if (eventos.length === 0) {
      const linea = `Calendario sin eventos válidos: descartados=${descartados} fallidos=${fallidos}. No se envía.`;
      (descartados + fallidos > 0 ? falla : info)(linea);
      return EXIT_CODES.ok;
    }

    const envio = await entregar(eventos, { config: entrega.config });
    if (!envio.ok) {
      falla(`Entrega del calendario fallida: status=${envio.status}. Se sigue.`);
      return EXIT_CODES.ok;
    }
    const r = envio.resultado ?? {};
    const conteo = (n) => (Number.isInteger(n) ? n : "?");
    const resumen =
      `Fase del calendario terminada: leidos=${eventos.length} nuevos=${conteo(r.inserted)} ` +
      `actualizados=${conteo(r.updated)} sin_cambios=${conteo(r.unchanged)} ` +
      `descartados=${descartados} fallidos=${fallidos}`;
    (descartados + fallidos > 0 ? falla : info)(resumen);
    return EXIT_CODES.ok;
  } catch (error) {
    // Solo el tipo: el mensaje podría traer la URL o la respuesta.
    falla(`Excepción en la fase del calendario: ${/^[A-Z][A-Za-z]{0,39}$/.test(error?.name ?? "") ? error.name : "Error"}. Se sigue.`);
    return EXIT_CODES.ok;
  }
}

module.exports = {
  ejecutarCalendario,
  entregarCalendario,
  leerHoras,
  horaEnHermosillo,
  HORAS_POR_DEFECTO,
  RUTA,
  EXIT_CODES,
};

if (require.main === module) {
  const path = require("path");
  require("dotenv").config({ path: path.join(__dirname, "..", "..", ".env"), quiet: true });
  const { ocultarValores } = require("./extraccion-cron");
  ejecutarCalendario({ forzar: true, ocultar: (texto) => ocultarValores(texto, process.env) }).then((code) => {
    process.exitCode = code;
  });
}
