import { test } from 'node:test';
import assert from 'node:assert/strict';
import { checkContentionGate } from './contention-gate.mjs';

const good = {
  FIXFLOW_TEST_DATABASE_URL: 'postgresql://fixflow_test_app@127.0.0.1:5432/fixflow_test',
  FIXFLOW_TEST_DB_CONFIRM: 'test',
};

test('accepts a localhost test database with the confirm flag', () => {
  assert.deepEqual(checkContentionGate(good), { ok: true });
});

test('accepts localhost hostname and TEST in the name case-insensitively', () => {
  assert.deepEqual(
    checkContentionGate({
      FIXFLOW_TEST_DATABASE_URL: 'postgresql://app@localhost:5432/FixFlow_TEST_db',
      FIXFLOW_TEST_DB_CONFIRM: 'test',
    }),
    { ok: true },
  );
});

test('refuses when the test URL is missing', () => {
  const r = checkContentionGate({ FIXFLOW_TEST_DB_CONFIRM: 'test' });
  assert.equal(r.ok, false);
  assert.match(r.reason, /FIXFLOW_TEST_DATABASE_URL is not set/);
});

test('refuses when the confirm flag is missing or wrong', () => {
  assert.equal(checkContentionGate({ ...good, FIXFLOW_TEST_DB_CONFIRM: undefined }).ok, false);
  assert.equal(checkContentionGate({ ...good, FIXFLOW_TEST_DB_CONFIRM: 'yes' }).ok, false);
  assert.equal(checkContentionGate({ ...good, FIXFLOW_TEST_DB_CONFIRM: 'TEST' }).ok, false);
});

test('refuses a database name without test', () => {
  const r = checkContentionGate({
    ...good,
    FIXFLOW_TEST_DATABASE_URL: 'postgresql://app@127.0.0.1:5432/fixflow',
  });
  assert.equal(r.ok, false);
  assert.match(r.reason, /must contain 'test'/);
});

test('accepts the IPv6 loopback as a localhost host', () => {
  assert.deepEqual(
    checkContentionGate({
      FIXFLOW_TEST_DATABASE_URL: 'postgresql://app@[::1]:5432/fixflow_test',
      FIXFLOW_TEST_DB_CONFIRM: 'test',
    }),
    { ok: true },
  );
});

test('refuses a non-localhost host', () => {
  const r = checkContentionGate({
    ...good,
    FIXFLOW_TEST_DATABASE_URL: 'postgresql://app@db.internal:5432/fixflow_test',
  });
  assert.equal(r.ok, false);
  assert.match(r.reason, /localhost/);
});

test('refuses an invalid URL without leaking it', () => {
  const r = checkContentionGate({ ...good, FIXFLOW_TEST_DATABASE_URL: 'not a url' });
  assert.equal(r.ok, false);
  assert.doesNotMatch(r.reason, /not a url/);
});

test('refuses a migration URL outside the approved local test target', () => {
  assert.equal(
    checkContentionGate({
      ...good,
      FIXFLOW_TEST_MIGRATION_DATABASE_URL: 'postgresql://owner@remote.invalid/fixflow_test',
    }).ok,
    false,
  );
  assert.equal(
    checkContentionGate({
      ...good,
      FIXFLOW_TEST_MIGRATION_DATABASE_URL: 'postgresql://owner@127.0.0.1:5432/production',
    }).ok,
    false,
  );
  assert.equal(
    checkContentionGate({
      ...good,
      FIXFLOW_TEST_MIGRATION_DATABASE_URL: 'postgresql://owner@127.0.0.1:5432/other_test',
    }).ok,
    false,
  );
});
test('accepts a migration owner on the exact same local test database', () => {
  assert.equal(
    checkContentionGate({
      ...good,
      FIXFLOW_TEST_MIGRATION_DATABASE_URL: 'postgresql://owner@127.0.0.1:5432/fixflow_test',
    }).ok,
    true,
  );
});
test('refuses invalid encodings and non-postgres schemes', () => {
  assert.equal(
    checkContentionGate({ ...good, FIXFLOW_TEST_DATABASE_URL: 'https://127.0.0.1/fixflow_test' })
      .ok,
    false,
  );
  assert.equal(
    checkContentionGate({
      ...good,
      FIXFLOW_TEST_DATABASE_URL: 'postgresql://app@127.0.0.1/%ZZtest',
    }).ok,
    false,
  );
});
