/* global URL */
/**
 * Gate for the normal-PostgreSQL contention suite
 * (scripts/test-contention.mjs). Pure: no database, no network.
 * The suite only ever runs against a database the operator
 * explicitly marked as a localhost TEST database; anything else is
 * refused with a reason that never includes the URL.
 */
export function checkContentionGate(env) {
  const url = env.FIXFLOW_TEST_DATABASE_URL;
  if (!url) {
    return { ok: false, reason: 'FIXFLOW_TEST_DATABASE_URL is not set.' };
  }
  if (env.FIXFLOW_TEST_DB_CONFIRM !== 'test') {
    return { ok: false, reason: "FIXFLOW_TEST_DB_CONFIRM is not 'test'." };
  }
  let parsed;
  try {
    parsed = new URL(url);
  } catch {
    return { ok: false, reason: 'FIXFLOW_TEST_DATABASE_URL is not a valid URL.' };
  }
  if (!['postgres:', 'postgresql:'].includes(parsed.protocol)) {
    return { ok: false, reason: 'Test database URL must use PostgreSQL.' };
  }
  // URL parsing keeps IPv6 hosts bracketed ("[::1]"), so strip the
  // brackets before comparing. Localhost only: the loopback names
  // and the IPv6 loopback.
  const host = (parsed.hostname || '').toLowerCase().replace(/^\[|\]$/g, '');
  if (host !== 'localhost' && host !== '127.0.0.1' && host !== '::1') {
    return { ok: false, reason: 'Test database host must be localhost, 127.0.0.1 or ::1.' };
  }
  let dbName;
  try {
    dbName = decodeURIComponent(parsed.pathname.replace(/^\//, '').split('/')[0] ?? '');
  } catch {
    return { ok: false, reason: 'Invalid database name encoding.' };
  }
  if (!dbName.toLowerCase().includes('test')) {
    return { ok: false, reason: "Test database name must contain 'test'." };
  }
  if (env.FIXFLOW_TEST_MIGRATION_DATABASE_URL) {
    const migration = env.FIXFLOW_TEST_MIGRATION_DATABASE_URL;
    const migrationGate = checkContentionGate({
      ...env,
      FIXFLOW_TEST_DATABASE_URL: migration,
      FIXFLOW_TEST_MIGRATION_DATABASE_URL: undefined,
    });
    if (!migrationGate.ok)
      return { ok: false, reason: 'Migration target failed the test database gate.' };
    const target = new URL(migration);
    if (
      target.hostname !== parsed.hostname ||
      (target.port || '5432') !== (parsed.port || '5432') ||
      decodeURIComponent(target.pathname) !== decodeURIComponent(parsed.pathname)
    ) {
      return { ok: false, reason: 'Migration and app URLs must name the same test database.' };
    }
  }
  return { ok: true };
}
