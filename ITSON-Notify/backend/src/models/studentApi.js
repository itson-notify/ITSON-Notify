// ITN-53 - Validación de lo que el alumno manda a /api.
const { z } = require("zod");

const uuidSchema = z.uuid();

// Devuelve el id o null si no es un uuid.
function parseNotificationId(value) {
  const parsed = uuidSchema.safeParse(value);
  return parsed.success ? parsed.data : null;
}

// ITN-57 - Id de curso (subjects.id o classroom_courses.id) en /api/courses/:id/items.
function parseCourseId(value) {
  const parsed = uuidSchema.safeParse(value);
  return parsed.success ? parsed.data : null;
}

module.exports = { parseNotificationId, parseCourseId };
