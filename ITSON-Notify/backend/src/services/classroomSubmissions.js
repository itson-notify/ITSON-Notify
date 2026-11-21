// ITN-58f - Estado de entrega del alumno por tarea de Classroom (solo lectura, solo para mostrar).
// Nunca persiste objetos crudos de Google ni genera eventos/avisos: la RPC 022 solo escribe
// classroom_submissions. Los errores son códigos fijos, sin cuerpos ni datos.
const { z } = require('zod');

const id = z.string().regex(/^[A-Za-z0-9_-]{1,128}$/);
const submissionSchema = z.object({
  courseId: id,
  courseWorkId: id,
  state: z.string().regex(/^[A-Z_]{1,64}$/),
  late: z.boolean().optional().nullable(),
  assignedGrade: z.number().finite().gt(-1e9).lt(1e9).optional().nullable(),
  updateTime: z.iso.datetime({ offset: true }).optional().nullable(),
});

// Mismos límites que la 022 (máx. 1000 por llamada); lotes más chicos por holgura.
const BATCH_SIZE = 500;
const MISSING_MIGRATION = new Set(['42883', 'PGRST202', '42P01', 'PGRST205', '42703']);

class SubmissionsSyncError extends Error {
  constructor(status, code) {
    super(code);
    this.status = status;
    this.code = code;
  }
}

// Convierte las entregas de un curso a la forma que espera la 022. Una entrada inválida o de
// otro curso se descarta (y se cuenta); nunca tumba el resto del curso.
function normalizeSubmissions(raw, courseId) {
  const items = [];
  let invalid = 0;
  for (const value of Array.isArray(raw) ? raw : []) {
    const parsed = submissionSchema.safeParse(value);
    if (!parsed.success || parsed.data.courseId !== courseId) { invalid++; continue; }
    const s = parsed.data;
    items.push({
      courseId: s.courseId,
      courseWorkId: s.courseWorkId,
      state: s.state,
      late: s.late === true,
      assignedGrade: s.assignedGrade ?? null,
      updateTime: s.updateTime ?? null,
    });
  }
  return { items, invalid };
}

const counter = value => Number.isSafeInteger(value) && value >= 0;

// Envía las entregas en lotes. Devuelve { stored, unknown, tasksAllowed }.
async function persistSubmissions(supabase, identity, items) {
  let stored = 0;
  let unknown = 0;
  for (let i = 0; i < items.length; i += BATCH_SIZE) {
    const { data, error } = await supabase.rpc('sync_classroom_submissions', {
      p_user_id: identity.userId, p_google_id: identity.googleId, p_items: items.slice(i, i + BATCH_SIZE),
    });
    if (error) {
      if (error.code === '42501' && error.message === 'classroom_authorization_required') {
        throw new SubmissionsSyncError(409, 'classroom_requiere_autorizacion');
      }
      if (MISSING_MIGRATION.has(error.code)) throw new SubmissionsSyncError(503, 'classroom_migracion_requerida');
      throw new SubmissionsSyncError(500, 'error_interno');
    }
    if (!data || typeof data.tasksAllowed !== 'boolean' || !['items', 'stored', 'unknown'].every(k => counter(data[k]))) {
      throw new SubmissionsSyncError(500, 'error_interno');
    }
    // Sin permiso de tareas la 022 no escribe; los lotes siguientes tampoco lo harían.
    if (!data.tasksAllowed) return { stored, unknown, tasksAllowed: false };
    stored += data.stored;
    unknown += data.unknown;
  }
  return { stored, unknown, tasksAllowed: true };
}

module.exports = { normalizeSubmissions, persistSubmissions, SubmissionsSyncError, BATCH_SIZE, MISSING_MIGRATION };
