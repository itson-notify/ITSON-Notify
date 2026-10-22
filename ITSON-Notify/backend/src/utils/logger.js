// ITN-27 - Logger de una línea JSON por evento.
// Privacidad: solo deja pasar campos de una lista blanca (ids, conteos,
// códigos) y solo si el valor es número, booleano, null o un texto corto con
// forma de id. Así un dato sensible (calificación, materia, correo, matrícula,
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
]);

// uuid, códigos de Postgres (23505), nombres de paso (snapshot_grades), etc.
const TEXTO_SEGURO = /^[A-Za-z0-9_.:-]{1,64}$/;

function valorSeguro(value) {
  if (value === null || typeof value === "boolean") return true;
  if (typeof value === "number") return Number.isFinite(value);
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
