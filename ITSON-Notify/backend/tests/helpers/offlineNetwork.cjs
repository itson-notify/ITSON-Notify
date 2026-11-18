// Preload for offline regression runs. Only loopback HTTP is allowed.
// Test files may replace these transports with their own in-memory mocks.
const http = require('node:http');
const https = require('node:https');
const forbidden = () => { throw new Error('External network forbidden during offline tests'); };
const nativeFetch = globalThis.fetch;
globalThis.fetch = function (input, init) {
  const url = new URL(input instanceof Request ? input.url : input);
  if (url.protocol !== 'http:' || !['localhost', '127.0.0.1', '[::1]'].includes(url.hostname) ||
      url.username || url.password) return forbidden();
  // Native fetch follows redirects by default; a local response must never
  // redirect the transport (or the internal API key) to an external service.
  return nativeFetch(input, { ...init, redirect: 'error' });
};
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
