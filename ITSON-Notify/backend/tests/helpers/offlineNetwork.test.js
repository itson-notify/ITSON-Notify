const { test } = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
require('./offlineNetwork.cjs');

test('offline fetch blocks external destinations and HTTPS before transport', () => {
  for (const input of ['https://oauth2.googleapis.com/token', 'http://external.invalid',
    'http://127.0.0.1.external.invalid', 'https://127.0.0.1', 'http://user:password@127.0.0.1',
    new Request('http://external.invalid')]) {
    assert.throws(() => fetch(input), /External network forbidden/);
  }
});

test('offline fetch allows local HTTP but never follows a redirect', async t => {
  let requests = 0;
  const server = http.createServer((req, res) => {
    requests++;
    if (req.url === '/redirect') {
      res.writeHead(302, { Location: '/destination' });
      return res.end();
    }
    res.end('LOCAL_OK');
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => server.close(resolve)));
  const base = `http://127.0.0.1:${server.address().port}`;
  assert.equal(await (await fetch(new URL(base))).text(), 'LOCAL_OK');
  await assert.rejects(fetch(new Request(base + '/redirect'), { redirect: 'follow' }), TypeError);
  assert.equal(requests, 2, 'the redirected request must not be made');
});
