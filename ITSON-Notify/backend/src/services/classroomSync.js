// Academic metadata stays in backend. Never persist raw Google objects.
const { z } = require('zod');
const id = z.string().regex(/^[A-Za-z0-9_-]{1,128}$/);
const optionalText = z.string().max(3000).optional().nullable();
const timestamp = z.iso.datetime({ offset: true }).optional().nullable();
const link = z.string().url().max(3000).refine(value => {
  const url = new URL(value);
  return url.protocol === 'https:' && url.hostname === 'classroom.google.com' && !url.username && !url.password;
}).optional().nullable();
const workSchema = z.object({
  id, courseId: id, title: z.string().min(1).max(3000),
  workType: optionalText, state: optionalText, alternateLink: link,
  creationTime: timestamp, updateTime: timestamp,
  dueDate: z.object({ year: z.number().int().min(1).max(9999), month: z.number().int().min(1).max(12),
    day: z.number().int().min(1).max(31) }).optional(),
  dueTime: z.object({ hours: z.number().int().min(0).max(23).default(0),
    minutes: z.number().int().min(0).max(59).default(0), seconds: z.number().int().min(0).max(59).default(0),
    nanos: z.number().int().min(0).max(999999999).default(0) }).optional(),
});
const schema = z.array(z.object({ id, name: z.string().min(1).max(3000), section: optionalText,
  courseState: optionalText, alternateLink: link, coursework: z.array(workSchema) }));

function dueAt(item) {
  if (!item.dueDate) {
    if (item.dueTime) throw new Error('invalid_due_date');
    return null;
  }
  const { year, month, day } = item.dueDate;
  const t = item.dueTime ?? { hours: 23, minutes: 59, seconds: 0, nanos: 0 };
  const date = new Date(0);
  date.setUTCFullYear(year, month - 1, day);
  date.setUTCHours(t.hours, t.minutes, t.seconds, Math.floor(t.nanos / 1000000));
  if (date.getUTCFullYear() !== year || date.getUTCMonth() !== month - 1 || date.getUTCDate() !== day) {
    throw new Error('invalid_due_date');
  }
  return date.toISOString();
}

function normalizeCourses(raw) {
  const courses = schema.parse(raw);
  // Repeated pages are harmless; conflicting copies fail closed before persistence.
  function unique(rows) {
    const values = new Map();
    for (const row of rows) {
      if (values.has(row.id) && JSON.stringify(values.get(row.id)) !== JSON.stringify(row)) {
        throw new Error('conflicting_duplicate');
      }
      values.set(row.id, row);
    }
    return [...values.values()];
  }
  return unique(courses.map(course => ({
    id: course.id, name: course.name, section: course.section ?? null,
    course_state: course.courseState ?? null, alternate_link: course.alternateLink ?? null,
    coursework: unique(course.coursework.map(item => {
      if (item.courseId !== course.id) throw new Error('course_identity_mismatch');
      return { id: item.id, title: item.title, work_type: item.workType ?? null,
        state: item.state ?? 'PUBLISHED', alternate_link: item.alternateLink ?? null,
        due_at: dueAt(item), source_created_at: item.creationTime ?? null, source_updated_at: item.updateTime ?? null };
    })),
  })));
}

async function persistClassroom(supabase, identity, courses) {
  const { data, error } = await supabase.rpc('sync_classroom', {
    p_user_id: identity.userId, p_google_id: identity.googleId, p_courses: courses,
  });
  if (error) {
    // Route sanitizes all messages; only these fixed statuses are public.
    const failure = new Error('classroom_sync_failed');
    // Only this exact pair is emitted by sync_classroom's authorization guards.
    // Generic insufficient_privilege (including RLS/ACL failures) must remain visible.
    const authorizationConflict = error.code === '42501' && error.message === 'classroom_authorization_required';
    failure.syncStatus = authorizationConflict ? 409 :
      ['42883', 'PGRST202', '42703', '42P01'].includes(error.code) ? 503 : 500;
    throw failure;
  }
  if (!data || !['courses', 'coursework', 'newTasks'].every(key => Number.isSafeInteger(data[key]) && data[key] >= 0)) {
    throw new Error('classroom_sync_failed');
  }
  return { sync: { courses: data.courses, coursework: data.coursework, newTasks: data.newTasks } };
}
module.exports = { normalizeCourses, persistClassroom };
