// ITN-27 - Logger de una línea JSON por evento.
// Privacidad: solo deja pasar campos de una lista blanca (ids, conteos,
// códigos) y solo si el valor es número, booleano, null, un texto corto con
// forma de id o una lista corta de esos textos. Así un dato sensible (calificación, materia, correo, matrícula,
// llave, body) no llega a los logs aunque alguien lo pase por error.

const CAMPOS_PERMITIDOS = new Set([
  "snapshot_id",
  "user_id",
  "snapshot_created",
  "courses",
  "items",
  "baseline",
  "reason",
  "changes_detected",
  "changes_inserted",
  "issues",
  "status",
  "step",
  "error_code",
  "compensation",
  "port",
  // ITN-28: solo ids de grade_changes y conteos, nunca el mensaje.
  "grade_change_id",
  "grade_change_ids",
  "channel",
  "attempts",
  "retried",
  "notified",
  "failed",
  // ITN-36: valores de lista cerrada y la versión de la llave, nunca el secreto.
  "portal",
  "kind",
  "key_version",
  // ITN-52: cuántas cuentas activas se entregaron al worker, nunca sus correos.
  "count",
]);

// uuid, códigos de Postgres (23505), nombres de paso (snapshot_grades), etc.
const TEXTO_SEGURO = /^[A-Za-z0-9_.:-]{1,64}$/;

// Listas de ids (p. ej. grade_change_ids de un grupo), con tope de largo.
const MAX_LISTA = 20;

function valorSeguro(value) {
  if (value === null || typeof value === "boolean") return true;
  if (typeof value === "number") return Number.isFinite(value);
  if (Array.isArray(value)) {
    return value.length <= MAX_LISTA && value.every((v) => typeof v === "string" && TEXTO_SEGURO.test(v));
  }
  return typeof value === "string" && TEXTO_SEGURO.test(value);
}

function createLogger(write = (line) => console.log(line)) {
  function log(level, event, fields = {}) {
    const safe = {};
    for (const [key, value] of Object.entries(fields)) {
      if (CAMPOS_PERMITIDOS.has(key) && valorSeguro(value)) safe[key] = value;
    }
    write(JSON.stringify({ ts: new Date().toISOString(), level, event, ...safe }));
  }
  return {
    info: (event, fields) => log("info", event, fields),
    warn: (event, fields) => log("warn", event, fields),
    error: (event, fields) => log("error", event, fields),
  };
}

module.exports = { createLogger, CAMPOS_PERMITIDOS };
