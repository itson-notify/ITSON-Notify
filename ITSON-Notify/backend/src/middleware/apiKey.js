// ITN-27 - Autenticación del worker con el header x-api-key.
// Se comparan los SHA-256 de ambas llaves con crypto.timingSafeEqual: así los
// buffers siempre miden lo mismo (timingSafeEqual lanza si no) y el tiempo de
// la comparación no revela ni el contenido ni la longitud de la llave.
const crypto = require("crypto");

const sha256 = (value) => crypto.createHash("sha256").update(value, "utf8").digest();

function requireApiKey(expectedKey) {
  if (typeof expectedKey !== "string" || expectedKey === "") {
    throw new Error("requireApiKey necesita la llave esperada");
  }
  const expected = sha256(expectedKey);

  return function apiKeyMiddleware(req, res, next) {
    const provided = req.get("x-api-key");
    if (typeof provided === "string" && provided !== "" && crypto.timingSafeEqual(sha256(provided), expected)) {
      return next();
    }
    // Sin detalles: el mismo 401 para llave ausente o incorrecta.
    return res.status(401).json({ error: "no_autorizado" });
  };
}

module.exports = { requireApiKey };
