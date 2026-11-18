const { test } = require('node:test');
const assert = require('node:assert/strict');
const { isMissingAuthorizationStatus } = require('../../src/services/googleAuthorizationSchema');
test('legacy compatibility recognizes only the precise PostgreSQL or PostgREST missing status error', () => {
  for (const [code, message] of [
    ['42703', 'column google_authorizations.status does not exist'],
    ['42703', 'column public.google_authorizations.status does not exist'],
    ['PGRST204', "Could not find the 'status' column of 'google_authorizations' in the schema cache"],
  ]) assert.equal(isMissingAuthorizationStatus({ code, message }), true);
  for (const error of [null, { code: '42703' },
    { code: '42501', message: 'column google_authorizations.status does not exist' },
    { code: '42703', message: 'column google_authorizations.refresh_token does not exist' },
    { code: '42703', message: 'column student_credentials.status does not exist' },
    { code: 'PGRST204', message: "Could not find the 'scope' column of 'google_authorizations' in the schema cache" },
  ]) assert.equal(isMissingAuthorizationStatus(error), false);
});
