// ITN-27 - Contrato del body de POST /internal/grade-snapshots.
// Parte de la salida real de extractGrades() (ITN-23, status 'ok') más los
// datos de la corrida que agrega el worker (ITN-25). Documentado en
// backend/README.md.
const { z } = require("zod");
const { CODIGO_VALIDO, normalizarCodigo } = require("../services/itsonGradeCodes");

// ITN-55 - Fuentes aceptadas. itson_api es la API REST de ITSON (getGrades):
// cada materia es un curso con un solo ítem (su idCatalog) y el semestre
// consultado va en `period`.
const SOURCES = ["ivirtual", "itson_api"];
const ITSON_API = "itson_api";
// Clave de semestre de la API ("01".."08"); "0" no se consulta.
const PERIOD = /^[0-9]{2}$/;

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

// ITN-56 - Campos de fecha del ítem y su columna en snapshot_grades (migración 013).
const FECHAS_TAREA = [
  { key: "dueAt", column: "due_at" },
  { key: "opensAt", column: "opens_at" },
  { key: "closesAt", column: "closes_at" },
];

// ITN-56 - Fechas de una tarea de iVirtual (ISO 8601 con zona). Omitida significa
// "desconocida" (el backend copia la del snapshot anterior del mismo ítem); null
// significa "la tarea no tiene esa fecha". Por eso es optional() + nullable() y
// no nullish() con default: zod deja la llave ausente si no vino.
const fechaTarea = z.iso.datetime({ offset: true }).nullable().optional();

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
  // ITN-56 - Solo iVirtual (en itson_api se descartan): entrega, apertura y cierre.
  dueAt: fechaTarea,
  opensAt: fechaTarea,
  closesAt: fechaTarea,
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
      source: z.enum(SOURCES).default("ivirtual"),
      period: z.string().trim().regex(PERIOD).nullish(),
      user: z.object({
        email: z.string().trim().toLowerCase().max(320).pipe(z.email()),
      }),
      // Vacío se rechaza: un snapshot sin cursos haría que el detector viera
      // como borradas todas las calificaciones del snapshot anterior.
      courses: z.array(course).min(1).max(200),
    })
    .superRefine((payload, ctx) => {
      if (payload.source === ITSON_API) refineItsonApi(payload, ctx);
      else if (payload.period !== null && payload.period !== undefined) {
        // iVirtual no tiene semestre: un period cambiaría con qué snapshot se compara.
        ctx.addIssue({ code: "custom", path: ["period"], message: "solo itson_api" });
      }

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

// ITN-55 - Reglas de itson_api: period obligatorio; un solo ítem por materia,
// con el mismo id que la materia (idCatalog); sin valor numérico (el código va
// en `text`) y con un código válido o "-".
function refineItsonApi(payload, ctx) {
  if (payload.period === null || payload.period === undefined) {
    ctx.addIssue({ code: "custom", path: ["period"], message: "obligatorio en itson_api" });
  }
  payload.courses.forEach((c, i) => {
    if (c.items.length !== 1) {
      ctx.addIssue({ code: "custom", path: ["courses", i, "items"], message: "un solo ítem en itson_api" });
      return;
    }
    const it = c.items[0];
    const base = ["courses", i, "items", 0];
    if (it.externalItemId !== c.externalId) {
      ctx.addIssue({ code: "custom", path: [...base, "externalItemId"], message: "debe ser el idCatalog" });
    }
    if (it.value !== null && it.value !== undefined) {
      ctx.addIssue({ code: "custom", path: [...base, "value"], message: "debe ser null en itson_api" });
    }
    const codigo = normalizarCodigo(it.text);
    if (codigo !== null && !CODIGO_VALIDO.test(codigo)) {
      ctx.addIssue({ code: "custom", path: [...base, "text"], message: "código no válido" });
    }
  });
}

// "-" de la API se guarda como null: así el detector ve "sin calificación" y
// no un texto. iVirtual queda igual, con period null.
function normalizarItsonApi(data) {
  if (data.source !== ITSON_API) return { ...data, period: null };
  return {
    ...data,
    courses: data.courses.map((c) => ({
      ...c,
      // ITN-56 - itson_api no tiene fechas de entrega: se descartan si llegaran.
      items: c.items.map(({ dueAt, opensAt, closesAt, ...it }) => ({ ...it, value: null, text: normalizarCodigo(it.text) })),
    })),
  };
}

// Devuelve { success: true, data } o { success: false, issues }.
// issues solo trae ruta, código y mensaje fijo: nunca el valor recibido (el
// body lleva correo, materias y calificaciones).
function parseGradeSnapshotPayload(body, { now = Date.now() } = {}) {
  const result = buildSchema(now).safeParse(body);
  if (result.success) return { success: true, data: normalizarItsonApi(result.data) };
  return {
    success: false,
    issues: result.error.issues.slice(0, 20).map((issue) => ({
      path: issue.path.join("."),
      code: issue.code,
      ...(issue.code === "custom" ? { message: issue.message } : {}),
    })),
  };
}

module.exports = { parseGradeSnapshotPayload, MAX_FUTURO_MS, SOURCES, ITSON_API, FECHAS_TAREA };
