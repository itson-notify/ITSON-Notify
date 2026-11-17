// Only the precise missing-status errors permit legacy-schema compatibility.
// Other database failures must propagate; never log their external messages.
function isMissingAuthorizationStatus(error) {
  const message = typeof error?.message === 'string' ? error.message : '';
  if (error?.code === '42703') {
    return /^column (?:public\.)?google_authorizations\.status does not exist$/.test(message);
  }
  return error?.code === 'PGRST204' &&
    /^Could not find the 'status' column of 'google_authorizations' in the schema cache$/.test(message);
}
module.exports = { isMissingAuthorizationStatus };
