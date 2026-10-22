// ITN-27 - Contrato del body de POST /internal/grade-snapshots.
// Parte de la salida real de extractGrades() (ITN-23, status 'ok') más los
// datos de la corrida que agrega el worker (ITN-25). Documentado en
// backend/README.md.
const { z } = require("zod");

// El snapshot previo se elige por captured_at: un reloj adelantado en el
// worker haría que una corrida vieja pareciera la más reciente.
const MAX_FUTURO_MS = 5 * 60 * 1000;

// grade_value es numeric(5,2): ya redondeado a 2 decimales debe caber en
// ±999.99. Se valida aquí para responder 400 y no un error de Postgres.
function cabeEnNumeric52(value) {
  return Math.abs(Math.round(value * 100)) <= 99999;
}

// Prefijo reservado por la migración 003 para filas viejas sin id de Moodle.
const LEGACY_PREFIX = "legacy:";

const idExterno = z
  .union([z.string(), z.number().int()])
  .transform((v) => String(v).trim())
  .pipe(z.string().min(1).max(100));

const numeroONull = z.number().finite().nullish();

const item = z.object({
  externalItemId: idExterno.refine((v) => !v.startsWith(LEGACY_PREFIX), {
    message: "prefijo reservado",
  }),
  // null en el total del curso (itemtype 'course').
  label: z.string().max(500).nullish(),
  value: numeroONull.refine((v) => v === null || v === undefined || cabeEnNumeric52(v), {
    message: "fuera de rango de numeric(5,2)",
  }),
  // Moodle manda "-" cuando no hay calificación.
  text: z.string().max(100).nullish(),
  // Campos extra del ítem: van a snapshot_grades.raw_payload.
  type: z.string().max(50).nullish(),
  min: numeroONull,
  max: numeroONull,
  percentage: z.string().max(50).nullish(),
  categoryId: z.union([z.string().max(100), z.number()]).nullish(),
  cmid: z.union([z.string().max(100), z.number()]).nullish(),
  hidden: z.boolean().nullish(),
});

const course = z.object({
  externalId: idExterno,
  subject: z.string().trim().min(1).max(300),
  items: z.array(item).max(2000),
});

function buildSchema(now) {
  return z
    .object({
      run_id: z.uuid(),
      captured_at: z.iso
        .datetime({ offset: true })
        .refine((v) => Date.parse(v) <= now + MAX_FUTURO_MS, { message: "en el futuro" }),
      source: z.enum(["ivirtual"]).default("ivirtual"),
      user: z.object({
        email: z.string().trim().toLowerCase().max(320).pipe(z.email()),
      }),
      // Vacío se rechaza: un snapshot sin cursos haría que el detector viera
      // como borradas todas las calificaciones del snapshot anterior.
      courses: z.array(course).min(1).max(200),
    })
    .superRefine((payload, ctx) => {
      const cursos = new Set();
      payload.courses.forEach((c, i) => {
        if (cursos.has(c.externalId)) {
          ctx.addIssue({ code: "custom", path: ["courses", i, "externalId"], message: "duplicado" });
        }
        cursos.add(c.externalId);

        const items = new Set();
        c.items.forEach((it, j) => {
          if (items.has(it.externalItemId)) {
            ctx.addIssue({
              code: "custom",
              path: ["courses", i, "items", j, "externalItemId"],
              message: "duplicado",
            });
          }
          items.add(it.externalItemId);
        });
      });
    });
}

// Devuelve { success: true, data } o { success: false, issues }.
// issues solo trae ruta, código y mensaje fijo: nunca el valor recibido (el
// body lleva correo, materias y calificaciones).
function parseGradeSnapshotPayload(body, { now = Date.now() } = {}) {
  const result = buildSchema(now).safeParse(body);
  if (result.success) return { success: true, data: result.data };
  return {
    success: false,
    issues: result.error.issues.slice(0, 20).map((issue) => ({
      path: issue.path.join("."),
      code: issue.code,
      ...(issue.code === "custom" ? { message: issue.message } : {}),
    })),
  };
}

module.exports = { parseGradeSnapshotPayload, MAX_FUTURO_MS };
