// ITN-53 - Validación de lo que el alumno manda a /api.
const { z } = require("zod");

const notificationId = z.uuid();

// Devuelve el id o null si no es un uuid.
function parseNotificationId(value) {
  const parsed = notificationId.safeParse(value);
  return parsed.success ? parsed.data : null;
}

module.exports = { parseNotificationId };
