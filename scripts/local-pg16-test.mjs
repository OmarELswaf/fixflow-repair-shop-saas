/* global console, process, URL, setTimeout, clearTimeout */
import { spawn, execFile } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { checkContentionGate } from './contention-gate.mjs';

/**
 * One-command isolated normal-PostgreSQL 16 validation.
 *
 *   npm run test:pg16
 *
 * Starts a throwaway postgres:16-alpine container (run-suffixed name
 * and volume, localhost-only port), creates the owner role
 * (fixflow_owner) and the non-owner NOBYPASSRLS app role
 * (fixflow_app) with per-run random passwords, creates a throwaway
 * database owned by the owner role, runs the full migration lineage
 * (`prisma migrate deploy`), then runs the four HTTP harnesses in
 * normal-PG16 mode and the contention suite against it. The container
 * and volume are stopped and removed in teardown, even on failure.
 *
 * Gate (checked FIRST, before any Docker call — same gate as the
 * contention suite, scripts/contention-gate.mjs):
 * - FIXFLOW_TEST_DATABASE_URL must be set. It declares the target:
 *   the host must be localhost, 127.0.0.1 or ::1, and the database
 *   name must contain 'test' (case-insensitive). The port, when
 *   given, is the localhost port the container publishes; when
 *   absent it defaults to 15440. The user/password in this URL are
 *   NOT used: the script generates fresh per-run credentials and
 *   hands the real URLs to the suites. The URL is never printed.
 * - FIXFLOW_TEST_DB_CONFIRM must be 'test'.
 * - The database name must be a plain SQL identifier
 *   ([A-Za-z_][A-Za-z0-9_]*); anything else is refused.
 * Anything else is refused with exit code 2.
 *
 * Existing data: the target database is probed (via the maintenance
 * database) before anything is created. If it already exists, the
 * run refuses with exit code 2 unless FIXFLOW_TEST_DB_RECREATE=1 is
 * set (off by default). A database this run creates is always
 * dropped and recreated empty before each suite, so every suite
 * starts from an empty database exactly like PGlite mode. Nothing
 * outside the throwaway container is ever touched, and no remote
 * host is ever contacted: the host must be loopback.
 *
 * What it does NOT do:
 * - No --use-local path: there is no mode that reuses an already
 *   running PostgreSQL server. Reusing a shared server would need a
 *   second admin credential input and "only drop what we created"
 *   tracking for roles and databases; the container path is
 *   self-contained and deterministic instead. Use the container.
 * - test:db is PGlite-only (scripts/test-database.mjs imports
 *   @electric-sql/pglite); it is SKIPPED here with that reason, not
 *   faked. It runs in the normal suite (`npm run test:db`).
 * - No Docker build, no Redis, no deployment. The Docker build
 *   check lives in scripts/run-checks.mjs.
 *
 * Exit codes: 0 = every suite that ran passed (skips allowed);
 * 1 = a setup step or a suite failed; 2 = refused to run (gate,
 * Docker unavailable, target database already exists).
 *
 * Requires: Docker with the compose plugin, network for the
 * postgres:16-alpine image (first run) and for the Prisma engine
 * download (`npm run prisma:generate`).
 */
process.chdir(fileURLToPath(new URL('../', import.meta.url)));
const require = createRequire(import.meta.url);
const { Pool } = require('pg');

const COMPOSE_FILE = 'docker/compose.pg16.test.yml';
const DEFAULT_PORT = 15440;
const STEP_TIMEOUT_MS = 10 * 60 * 1000;
const READY_TIMEOUT_MS = 60 * 1000;
const OWNER_ROLE = 'fixflow_owner';
const APP_ROLE = 'fixflow_app';

const results = [];
function record(name, status, reason = '') {
  results.push({ name, status, reason });
  console.log(`${status} ${name}${reason ? ` — ${reason}` : ''}`);
}

function run(command, args, options = {}) {
  const { env = process.env, timeoutMs = STEP_TIMEOUT_MS } = options;
  return new Promise((resolve) => {
    const child = spawn(command, args, { env, stdio: 'inherit' });
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      resolve({ code: null, timedOut: true });
    }, timeoutMs);
    child.once('exit', (code) => {
      clearTimeout(timer);
      resolve({ code, timedOut: false });
    });
    child.once('error', (error) => {
      clearTimeout(timer);
      console.error(`${command} failed to start: ${error.message}`);
      resolve({ code: null, timedOut: false });
    });
  });
}

function execFileAsync(file, args, options = {}) {
  return new Promise((resolve, reject) => {
    execFile(file, args, options, (error, stdout, stderr) => {
      if (error) {
        error.stdout = stdout;
        error.stderr = stderr;
        reject(error);
      } else resolve({ stdout, stderr });
    });
  });
}

async function dockerAvailable() {
  try {
    await execFileAsync('docker', ['--version'], { timeout: 15000 });
    await execFileAsync('docker', ['info'], { timeout: 30000, maxBuffer: 1024 * 1024 });
    await execFileAsync('docker', ['compose', 'version'], { timeout: 15000 });
    return true;
  } catch {
    return false;
  }
}

async function withPool(connectionString, fn) {
  const pool = new Pool({ connectionString, max: 1 });
  try {
    return await fn(pool);
  } finally {
    await pool.end();
  }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// --- Gate FIRST, before any Docker call. ---
const gate = checkContentionGate({
  FIXFLOW_TEST_DATABASE_URL: process.env.FIXFLOW_TEST_DATABASE_URL,
  FIXFLOW_TEST_DB_CONFIRM: process.env.FIXFLOW_TEST_DB_CONFIRM,
});
if (!gate.ok) {
  console.error(`REFUSED: ${gate.reason}`);
  console.error(
    'Set FIXFLOW_TEST_DATABASE_URL to a localhost TEST database and FIXFLOW_TEST_DB_CONFIRM=test.',
  );
  process.exit(2);
}
if (process.env.FIXFLOW_TEST_MIGRATION_DATABASE_URL) {
  console.log(
    'NOTE: FIXFLOW_TEST_MIGRATION_DATABASE_URL is set in your shell but is ignored here; the owner URL is generated per run.',
  );
}

const target = new URL(process.env.FIXFLOW_TEST_DATABASE_URL);
const dbName = decodeURIComponent(target.pathname.replace(/^\//, '').split('/')[0] ?? '');
if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(dbName)) {
  console.error('REFUSED: test database name must be a plain SQL identifier.');
  process.exit(2);
}
const port = target.port || String(DEFAULT_PORT);
const suffix = randomBytes(6).toString('hex');
const containerName = `fixflow-pg16-test-${suffix}`;
const volumeName = `fixflow-pg16-test-${suffix}`;
const projectName = `fixflow-pg16-test-${suffix}`;
const ownerPassword = randomBytes(24).toString('hex');
const appPassword = randomBytes(24).toString('hex');
// Hex passwords contain no quote, so they are safe inside a SQL
// string literal. They are generated per run, held in memory only,
// and never printed.
const ownerUrl = `postgresql://${OWNER_ROLE}:${ownerPassword}@127.0.0.1:${port}/${dbName}?schema=public`;
const appUrl = `postgresql://${APP_ROLE}:${appPassword}@127.0.0.1:${port}/${dbName}?schema=public`;
const maintenanceUrl = `postgresql://${OWNER_ROLE}:${ownerPassword}@127.0.0.1:${port}/postgres`;

const composeEnv = {
  ...process.env,
  PG16_TEST_SUFFIX: suffix,
  PG16_TEST_PORT: port,
  PG16_TEST_OWNER_PASSWORD: ownerPassword,
  PG16_TEST_APP_PASSWORD: appPassword,
};

let exitCode = 0;
let containerUp = false;

async function teardown() {
  // Best effort: drop what this run created, then remove the
  // container and its volume. Teardown failures are warnings, not
  // suite failures — the run's exit code is decided by the suites.
  if (!containerUp) return;
  try {
    await withPool(maintenanceUrl, async (pool) => {
      await pool.query(`DROP DATABASE IF EXISTS "${dbName}"`);
      await pool.query(`DROP ROLE IF EXISTS ${APP_ROLE}`);
    });
  } catch (error) {
    console.error(`Teardown warning: could not drop the throwaway database/role: ${error.message}`);
  }
  const down = await run(
    'docker',
    ['compose', '-f', COMPOSE_FILE, '-p', projectName, 'down', '-v', '--timeout', '10'],
    { env: composeEnv, timeoutMs: 60000 },
  );
  if (down.code !== 0) console.error('Teardown warning: docker compose down did not succeed.');
  await run('docker', ['volume', 'rm', '-f', volumeName], { timeoutMs: 30000 });
  await run('docker', ['rm', '-f', containerName], { timeoutMs: 30000 });
  containerUp = false;
}

async function prepareFreshDb() {
  await withPool(maintenanceUrl, async (pool) => {
    await pool.query(`DROP DATABASE IF EXISTS "${dbName}"`);
    await pool.query(`CREATE DATABASE "${dbName}" OWNER ${OWNER_ROLE}`);
  });
  await execFileAsync('npx', ['prisma', 'migrate', 'deploy'], {
    cwd: 'apps/api',
    env: { ...process.env, DATABASE_URL: ownerUrl, DATABASE_OWNER_URL: ownerUrl },
    maxBuffer: 10 * 1024 * 1024,
    timeout: STEP_TIMEOUT_MS,
  });
  await withPool(ownerUrl, async (pool) => {
    await pool.query(
      `GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO ${APP_ROLE}`,
    );
    await pool.query(`GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO ${APP_ROLE}`);
  });
}

async function runSuite(name, file, envExtra) {
  console.log(`--- ${name} (normal PostgreSQL 16) ---`);
  try {
    await prepareFreshDb();
  } catch (error) {
    console.error(
      `${name}: database reset/migration failed: ${String(error.stderr || error.message).slice(-2000)}`,
    );
    record(name, 'FAIL', 'database reset/migration failed');
    exitCode = 1;
    return;
  }
  const { code, timedOut } = await run('node', [file], {
    env: { ...process.env, ...envExtra },
  });
  if (timedOut) {
    record(name, 'FAIL', 'timed out');
    exitCode = 1;
  } else if (code === 0) {
    record(name, 'PASS');
  } else {
    record(name, 'FAIL', `exit code ${code}`);
    exitCode = 1;
  }
}

async function main() {
  // --- Docker preflight (no container exists yet) ---
  if (!(await dockerAvailable())) {
    console.error('REFUSED: Docker (with the compose plugin) is not available.');
    console.error('Install Docker and start the daemon, then run npm run test:pg16 again.');
    exitCode = 2;
    return;
  }
  record('docker available', 'PASS');

  // --- Start the throwaway container ---
  console.log(`Container: ${containerName} (localhost:${port}, database name withheld)`);
  const up = await run('docker', ['compose', '-f', COMPOSE_FILE, '-p', projectName, 'up', '-d'], {
    env: composeEnv,
  });
  if (up.code !== 0) {
    console.error('Failed to start the throwaway PostgreSQL 16 container.');
    exitCode = 1;
    return;
  }
  containerUp = true;

  // --- Bounded readiness wait (pg_isready inside the container) ---
  const readySince = Date.now();
  let ready = false;
  while (Date.now() - readySince < READY_TIMEOUT_MS) {
    const probe = await run(
      'docker',
      ['exec', containerName, 'pg_isready', '-U', OWNER_ROLE, '-d', 'postgres'],
      { timeoutMs: 15000 },
    );
    if (probe.code === 0) {
      ready = true;
      break;
    }
    await sleep(1000);
  }
  if (!ready) {
    console.error('PostgreSQL 16 did not become ready in 60 seconds.');
    record('container ready', 'FAIL', 'pg_isready timed out after 60s');
    exitCode = 1;
    return;
  }
  record('container ready', 'PASS');

  // --- Refuse to touch existing data (fresh container: this must
  // not find the database; the probe is the documented safety net) ---
  const exists = await withPool(maintenanceUrl, async (pool) => {
    const { rows } = await pool.query('SELECT 1 AS one FROM pg_database WHERE datname = $1', [
      dbName,
    ]);
    return rows.length > 0;
  });
  if (exists && process.env.FIXFLOW_TEST_DB_RECREATE !== '1') {
    console.error(
      'REFUSED: the target database already exists. Set FIXFLOW_TEST_DB_RECREATE=1 to allow this run to drop and recreate it.',
    );
    exitCode = 2;
    return;
  }
  if (exists) {
    console.log('Target database already exists; FIXFLOW_TEST_DB_RECREATE=1 allows the reset.');
  }

  // --- Roles (same names as the production compose setup) ---
  await withPool(maintenanceUrl, async (pool) => {
    await pool.query(`DO $$
      BEGIN
        IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = '${APP_ROLE}') THEN
          EXECUTE format('CREATE ROLE ${APP_ROLE} WITH LOGIN NOBYPASSRLS PASSWORD %L', '${appPassword}');
        ELSE
          EXECUTE format('ALTER ROLE ${APP_ROLE} WITH LOGIN NOBYPASSRLS PASSWORD %L', '${appPassword}');
        END IF;
      END $$`);
    await pool.query(`REVOKE ALL ON SCHEMA public FROM ${APP_ROLE}`);
    await pool.query(`GRANT USAGE ON SCHEMA public TO ${APP_ROLE}`);
    await pool.query(
      `ALTER DEFAULT PRIVILEGES FOR ROLE ${OWNER_ROLE} IN SCHEMA public GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO ${APP_ROLE}`,
    );
    await pool.query(
      `ALTER DEFAULT PRIVILEGES FOR ROLE ${OWNER_ROLE} IN SCHEMA public GRANT USAGE, SELECT ON SEQUENCES TO ${APP_ROLE}`,
    );
  });
  record('roles created', 'PASS', `${OWNER_ROLE} (owner) + ${APP_ROLE} (NOBYPASSRLS)`);

  // --- Generate + build (needed by the harnesses and contention) ---
  const generate = await run('npm', ['run', 'prisma:generate']);
  if (generate.code !== 0) {
    record('prisma generate', 'FAIL', `exit code ${generate.code}`);
    exitCode = 1;
    return;
  }
  record('prisma generate', 'PASS');
  const build = await run('npm', ['run', 'build', '--workspace=@fixflow/api']);
  if (build.code !== 0) {
    record('api build', 'FAIL', `exit code ${build.code}`);
    exitCode = 1;
    return;
  }
  record('api build', 'PASS');

  // --- The four HTTP harnesses, each from an empty database ---
  const httpEnv = {
    FIXFLOW_HTTP_DATABASE_URL: appUrl,
    FIXFLOW_TEST_DB_CONFIRM: 'test',
  };
  await runSuite('auth http (pg16)', 'scripts/test-auth-http.mjs', httpEnv);
  await runSuite('repairs http (pg16)', 'scripts/test-repairs-http.mjs', httpEnv);
  await runSuite('inventory http (pg16)', 'scripts/test-inventory-http.mjs', httpEnv);
  await runSuite('reports http (pg16)', 'scripts/test-reports-http.mjs', httpEnv);

  // --- Contention suite (runs its own migrate deploy; idempotent) ---
  await runSuite('contention (pg16)', 'scripts/test-contention.mjs', {
    FIXFLOW_TEST_DATABASE_URL: appUrl,
    FIXFLOW_TEST_MIGRATION_DATABASE_URL: ownerUrl,
    FIXFLOW_TEST_DB_CONFIRM: 'test',
  });

  // --- test:db is PGlite-only: skip honestly, do not fake it ---
  record(
    'test:db (pg16)',
    'SKIP',
    'scripts/test-database.mjs is PGlite-only; run npm run test:db for those checks',
  );
}

try {
  await main();
} catch (error) {
  // An unexpected throw mid-run: teardown still runs (finally), and
  // the run fails rather than passing silently.
  console.error(`local-pg16-test error: ${error.message}`);
  if (exitCode === 0) exitCode = 1;
} finally {
  await teardown();
}

const passed = results.filter((r) => r.status === 'PASS').length;
const skipped = results.filter((r) => r.status === 'SKIP').length;
const failed = results.filter((r) => r.status === 'FAIL').length;
console.log(
  `local-pg16-test summary: ${passed} passed, ${skipped} skipped, ${failed} failed (throwaway container and volume removed)`,
);
process.exit(exitCode);
