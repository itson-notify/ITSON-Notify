// ITN-56 - Fechas de entrega en hora de Hermosillo para los avisos.
// Sonora está en UTC-7 todo el año (sin horario de verano), así que se resta un
// desfase fijo en lugar de depender de los datos de zonas horarias del sistema.
// Ejemplo: "2026-11-21T06:59:00Z" -> "viernes 20 de noviembre de 2026, 23:59".

const DESFASE_MS = 7 * 60 * 60 * 1000;
const DIAS = ["domingo", "lunes", "martes", "miércoles", "jueves", "viernes", "sábado"];
const MESES = [
  "enero", "febrero", "marzo", "abril", "mayo", "junio",
  "julio", "agosto", "septiembre", "octubre", "noviembre", "diciembre",
];
const ZONA = "hora de Hermosillo";

// Devuelve el texto de la fecha, o null si no hay fecha o no es válida.
function formatearFechaHermosillo(iso) {
  if (iso === null || iso === undefined || iso === "") return null;
  const ms = Date.parse(iso);
  if (Number.isNaN(ms)) return null;
  const d = new Date(ms - DESFASE_MS);
  const hh = String(d.getUTCHours()).padStart(2, "0");
  const mm = String(d.getUTCMinutes()).padStart(2, "0");
  return `${DIAS[d.getUTCDay()]} ${d.getUTCDate()} de ${MESES[d.getUTCMonth()]} de ${d.getUTCFullYear()}, ${hh}:${mm}`;
}

// Frase para el aviso: con fecha, "sin fecha de entrega" (null) o null si la
// fecha es desconocida (undefined: la 013 no está aplicada o no se encontró).
function fraseEntrega(dueAt) {
  if (dueAt === undefined) return null;
  const texto = formatearFechaHermosillo(dueAt);
  return texto ? `Fecha de entrega: ${texto} (${ZONA}).` : "Sin fecha de entrega.";
}

module.exports = { formatearFechaHermosillo, fraseEntrega, ZONA };
