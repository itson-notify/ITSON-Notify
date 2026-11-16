const { test } = require('node:test');
const assert = require('node:assert/strict');
const { createClassroomWorkerClient } = require('..');
test('worker uses backend only, has no Google credential and never retries relink', async () => {
  const calls = [];
  const client = createClassroomWorkerClient({ baseUrl: 'https://backend.example.test', apiKey: 'synthetic-key',
    fetchImpl: async (...args) => { calls.push(args); return new Response('{}', { status: 409 }); } });
  assert.deepEqual(await client.read({ userId: 'student-a', googleId: 'google-a' }),
    { ok: false, status: 409, needsRelink: true });
  assert.equal(calls.length, 1);
  assert.equal(calls[0][0], 'https://backend.example.test/internal/classroom/read');
  assert.equal(calls[0][1].redirect, 'error');
  assert.equal(calls[0][1].headers['x-api-key'], 'synthetic-key');
  assert.deepEqual(JSON.parse(calls[0][1].body), { userId: 'student-a', googleId: 'google-a' });
});
test('worker supports active list and sanitizes transport and HTTP failures', async () => {
  for (const [value, expected] of [
    [new Response('{"students":[]}'), { ok: true, data: { students: [] } }],
    [new Response('{}'), { ok: false, status: 502, needsRelink: false }],
    [new Error('synthetic-secret'), { ok: false, status: 503, needsRelink: false }],
  ]) {
    const client = createClassroomWorkerClient({ baseUrl: 'https://backend.example.test', apiKey: 'synthetic-key',
      fetchImpl: async () => { if (value instanceof Error) throw value; return value; } });
    const result = await client.listActive();
    assert.doesNotMatch(JSON.stringify(result), /synthetic/);
    assert.deepEqual(result, expected);
  }
});
test('worker rejects insecure or credential-bearing backend configuration', () => {
  for (const baseUrl of ['http://remote.test', 'https://user:pass@remote.test', 'https://remote.test/path']) {
    assert.throws(() => createClassroomWorkerClient({ baseUrl, apiKey: 'synthetic-key' }), TypeError);
  }
});
