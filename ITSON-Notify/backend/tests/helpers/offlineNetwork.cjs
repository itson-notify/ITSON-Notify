// Preload for offline regression runs. Only Supertest loopback HTTP is allowed.
// Test files may replace these transports with their own in-memory mocks.
const http = require('node:http');
const https = require('node:https');
const forbidden = () => { throw new Error('External network forbidden during offline tests'); };
globalThis.fetch = forbidden;
https.request = forbidden;
https.get = forbidden;
for (const method of ['request', 'get']) {
  const original = http[method];
  http[method] = function (input, ...args) {
    const host = typeof input === 'string' || input instanceof URL ? new URL(input).hostname :
      (input?.hostname || input?.host || 'localhost');
    if (!['localhost', '127.0.0.1', '[::1]', '::1'].includes(host)) return forbidden();
    return original.call(this, input, ...args);
  };
}
