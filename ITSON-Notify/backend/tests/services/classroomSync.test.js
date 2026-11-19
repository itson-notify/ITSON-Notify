const { test } = require('node:test');
const assert = require('node:assert/strict');
const { normalizeCourses, persistClassroom } = require('../../src/services/classroomSync');
const { saveGoogleAuthorization, CLASSROOM_SCOPE, CLASSROOM_WORK_SCOPE } = require('../../src/services/googleAuthService');
const course = () => ({ id: 'c1', name: 'Synthetic course', section: 'Section',
  ownerId: 'PRIVATE', coursework: [{ id: 'w1', courseId: 'c1', title: 'Synthetic task',
    creatorUserId: 'PRIVATE', description: 'PRIVATE', materials: [{ private: true }],
    dueDate: { year: 2026, month: 11, day: 20 }, dueTime: { hours: 1, minutes: 30 } }] });

test('metadata whitelist, UTC conversion, defaults and exact duplicate pages', () => {
  const c = course(); c.coursework.push({ ...c.coursework[0] });
  const rows = normalizeCourses([c, structuredClone(c)]);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].coursework.length, 1);
  assert.equal(rows[0].coursework[0].due_at, '2026-11-20T01:30:00.000Z');
  assert.doesNotMatch(JSON.stringify(rows), /PRIVATE|creator|owner|materials|description|user_id|first_seen/);
  delete c.coursework[0].dueTime; c.coursework.pop();
  assert.equal(normalizeCourses([c])[0].coursework[0].due_at, '2026-11-20T23:59:00.000Z');
  delete c.coursework[0].dueDate;
  assert.equal(normalizeCourses([c])[0].coursework[0].due_at, null);
});

for (const [label, mutate] of [
  ['wrong course', c => { c.coursework[0].courseId = 'other'; }],
  ['invalid date', c => { c.coursework[0].dueDate = { year: 2026, month: 2, day: 30 }; }],
  ['time without date', c => { delete c.coursework[0].dueDate; }],
  ['invalid time', c => { c.coursework[0].dueTime.hours = 24; }],
  ['bad timestamp', c => { c.coursework[0].creationTime = 'private'; }],
  ['non Classroom link', c => { c.alternateLink = 'https://untrusted.test'; }],
  ['credential link', c => { c.alternateLink = 'https://secret@classroom.google.com/c/1'; }],
  ['conflicting duplicate', c => { c.coursework.push({ ...c.coursework[0], title: 'different' }); }],
  ['empty title', c => { c.coursework[0].title = ''; }],
]) test(`sync rejects ${label}`, () => {
  const c = course(); mutate(c); assert.throws(() => normalizeCourses([c]));
});

test('RPC only receives normalized metadata and authenticated identity, returns fixed counts', async () => {
  const identity = { userId: 'u1', googleId: 'g1' }, rows = normalizeCourses([course()]);
  const result = await persistClassroom({ rpc: async (name, args) => {
    assert.equal(name, 'sync_classroom');
    assert.deepEqual(args, { p_user_id: 'u1', p_google_id: 'g1', p_courses: rows });
    return { data: { courses: 1, coursework: 1, newTasks: 0, private: 'PRIVATE' } };
  } }, identity, rows);
  assert.deepEqual(result, { sync: { courses: 1, coursework: 1, newTasks: 0 } });
  for (const [code, status] of [['42501', 409], ['PGRST202', 503], ['XX000', 500]]) {
    await assert.rejects(persistClassroom({ rpc: async () => ({ error: { code, message: 'PRIVATE' } }) }, identity, rows),
      error => error.syncStatus === status && !error.message.includes('PRIVATE'));
  }
});

test('OAuth refuses missing requested coursework scope before any writes', async () => {
  await assert.rejects(saveGoogleAuthorization({ scope: CLASSROOM_SCOPE,
    requiredScopes: [CLASSROOM_SCOPE, CLASSROOM_WORK_SCOPE], supabase: {} }), /classroom_scope_not_granted/);
});
