/* global console, process, setTimeout, clearTimeout */
import { spawn, execFile } from 'node:child_process';
import { existsSync } from 'node:fs';

/**
 * Honest test runner.
 *
 *   npm run test:all   (alias: npm run test:ci — what CI calls)
 *
 * Runs, in order: format check, lint, contention-gate unit tests,
 * gate refusal paths, API unit tests, web tests, web typecheck, web
 * build, test:db, the four HTTP harnesses (PGlite mode by default),
 * and — when prerequisites exist — the isolated normal-PostgreSQL 16
 * run (`npm run test:pg16`, which includes the contention suite),
 * the Docker build check, and the Node 24 runtime check.
 *
 * Honest-skip contract: a check that cannot run is SKIPPED with its
 * reason, never PASS. Exit code is non-zero ONLY on FAIL; a run with
 * skips exits 0 but prints a summary manifest including how many
 * checks were skipped.
 *
 * Prerequisites and their skips:
 * - HTTP harnesses need the generated Prisma client
 *   (apps/api/src/generated/prisma). Missing → SKIP with "run
 *   npm run prisma:generate && npm run build first". CI runs
 *   prisma:generate as a separate step before this runner.
 * - The PG16 run needs Docker with the compose plugin. Missing →
 *   SKIP "docker not found". It also needs network (image pull,
 *   Prisma engine download).
 * - The Docker build check needs Docker. Missing → SKIP.
 * - The Node 24 check passes only when this process runs on Node
 *   24; any other major version → SKIP with the actual version
 *   printed. When it passes, it means the unit/web/DB suites in
 *   THIS run executed under that Node 24 version — it does not claim
 *   the Docker/PG16 parts ran under Node 24 (those are separate
 *   steps with their own results).
 *
 * The runner never invents a result: every step is a real child
 * process and its exit code decides PASS/FAIL.
 */
const STEP_TIMEOUT_MS = 10 * 60 * 1000;
const results = [];

function record(name, status, reason = '') {
  results.push({ name, status, reason });
  console.log(`${status} ${name}${reason ? ` — ${reason}` : ''}`);
}

function run(command, args, options = {}) {
  const { env = process.env, timeoutMs = STEP_TIMEOUT_MS, stdio = 'inherit' } = options;
  return new Promise((resolve) => {
    const child = spawn(command, args, { env, stdio });
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
  return new Promise((resolve) => {
    execFile(file, args, options, (error) => resolve(!error));
  });
}

async function dockerAvailable() {
  const info = await execFileAsync('docker', ['info'], { timeout: 30000 });
  if (!info) return false;
  return execFileAsync('docker', ['compose', 'version'], { timeout: 15000 });
}

function envWithout(keys) {
  const env = { ...process.env };
  for (const key of keys) delete env[key];
  return env;
}

async function step(name, command, args, options = {}) {
  console.log(`--- ${name} ---`);
  const { code, timedOut } = await run(command, args, options);
  if (timedOut) {
    record(name, 'FAIL', 'timed out');
    return false;
  }
  if (code === 0) {
    record(name, 'PASS');
    return true;
  }
  record(name, 'FAIL', `exit code ${code}`);
  return false;
}

let failed = false;

console.log('FixFlow check runner — PASS/SKIP/FAIL per check, never a fake pass.');

// 1. Format check.
if (!(await step('format:check', 'npm', ['run', 'format:check']))) failed = true;

// 2. Lint.
if (!(await step('lint', 'npm', ['run', 'lint']))) failed = true;

// 3. Contention-gate unit tests (pure, no database, no Docker).
if (!(await step('gate unit tests', 'node', ['--test', 'scripts/contention-gate.test.mjs']))) {
  failed = true;
}

// 4. Gate refusal paths: the contention script must refuse each of
// these with exit code 2 and never touch a database.
{
  console.log('--- gate refusal paths ---');
  const cases = [
    { name: 'no env', env: {} },
    {
      name: 'remote host',
      env: {
        FIXFLOW_TEST_DATABASE_URL: 'postgresql://app@db.internal:5432/fixflow_test',
        FIXFLOW_TEST_DB_CONFIRM: 'test',
      },
    },
    {
      name: 'missing confirm',
      env: {
        FIXFLOW_TEST_DATABASE_URL: 'postgresql://app@127.0.0.1:5432/fixflow_test',
      },
    },
    {
      name: 'name without test',
      env: {
        FIXFLOW_TEST_DATABASE_URL: 'postgresql://app@127.0.0.1:5432/fixflow',
        FIXFLOW_TEST_DB_CONFIRM: 'test',
      },
    },
  ];
  let allRefused = true;
  for (const c of cases) {
    const env = envWithout([
      'FIXFLOW_TEST_DATABASE_URL',
      'FIXFLOW_TEST_DB_CONFIRM',
      'FIXFLOW_TEST_MIGRATION_DATABASE_URL',
    ]);
    Object.assign(env, c.env);
    const { code } = await run('node', ['scripts/test-contention.mjs'], {
      env,
      stdio: 'pipe',
      timeoutMs: 60000,
    });
    if (code !== 2) {
      console.log(`FAIL gate refusal (${c.name}): expected exit 2, got ${code}`);
      allRefused = false;
    } else {
      console.log(`refused as expected (${c.name})`);
    }
  }
  if (allRefused) record('gate refusal paths', 'PASS', '4/4 refused with exit 2');
  else {
    record('gate refusal paths', 'FAIL');
    failed = true;
  }
}

// 5. API unit tests.
if (!(await step('test:api', 'npm', ['run', 'test:api']))) failed = true;

// 6. Web tests.
if (!(await step('test:web', 'npm', ['run', 'test:web']))) failed = true;

// 7. Web typecheck.
if (!(await step('web typecheck', 'npm', ['run', 'typecheck', '--workspace=@fixflow/web']))) {
  failed = true;
}

// 8. Web build.
if (!(await step('web build', 'npm', ['run', 'build', '--workspace=@fixflow/web']))) {
  failed = true;
}

// 9. Embedded-PostgreSQL migration/RLS/constraint checks.
if (!(await step('test:db', 'npm', ['run', 'test:db']))) failed = true;

// 10. HTTP harnesses (PGlite mode by default). They need the
// generated Prisma client; without it the build inside each harness
// script cannot run, so skip honestly instead of failing on a
// missing prerequisite.
if (!existsSync('apps/api/src/generated/prisma')) {
  record(
    'http harnesses (pglite)',
    'SKIP',
    'generated Prisma client missing — run npm run prisma:generate && npm run build first',
  );
} else {
  for (const harness of [
    'auth',
    'repairs',
    'inventory',
    'reports',
    'public-profile',
    'tracking',
    'threats',
  ]) {
    if (!(await step(`test:${harness}:http`, 'npm', ['run', `test:${harness}:http`]))) {
      failed = true;
    }
  }
}

// 11. Isolated normal-PostgreSQL 16 run (includes contention).
// The URL below only declares the target; local-pg16-test.mjs
// generates fresh per-run credentials and never uses the password
// in this URL. An operator-set FIXFLOW_TEST_DATABASE_URL is
// respected instead.
if (!(await dockerAvailable())) {
  record('test:pg16 (normal PostgreSQL 16)', 'SKIP', 'docker not found');
} else {
  const pg16Env = {
    FIXFLOW_TEST_DATABASE_URL:
      process.env.FIXFLOW_TEST_DATABASE_URL ??
      'postgresql://fixflow_app:runner-placeholder@127.0.0.1:15440/fixflow_test_pg16',
    FIXFLOW_TEST_DB_CONFIRM: process.env.FIXFLOW_TEST_DB_CONFIRM ?? 'test',
  };
  if (
    !(await step('test:pg16 (normal PostgreSQL 16)', 'npm', ['run', 'test:pg16'], {
      env: { ...process.env, ...pg16Env },
      timeoutMs: 30 * 60 * 1000,
    }))
  ) {
    failed = true;
  }
}

// 12. Docker build check (api + web images).
if (!(await dockerAvailable())) {
  record('docker build (api + web)', 'SKIP', 'docker not found');
} else if (
  !(await step(
    'docker build (api + web)',
    'docker',
    ['compose', '-f', 'docker-compose.yml', 'build', 'api', 'web'],
    { timeoutMs: 15 * 60 * 1000 },
  ))
) {
  failed = true;
}

// 13. Node 24 runtime check: this process's own Node version. The
// suites above executed under it when they ran.
{
  const version = process.version;
  const major = Number(version.slice(1).split('.')[0]);
  if (major === 24) {
    record(
      'node24 runtime',
      'PASS',
      `${version} — unit/web/DB suites in this run executed under this Node version`,
    );
  } else {
    record('node24 runtime', 'SKIP', `node is ${version}, not v24`);
  }
}

const passed = results.filter((r) => r.status === 'PASS').length;
const skipped = results.filter((r) => r.status === 'SKIP').length;
const failedCount = results.filter((r) => r.status === 'FAIL').length;
console.log(
  `run-checks summary: ${passed} passed, ${skipped} skipped, ${failedCount} failed` +
    (skipped > 0 ? ' — skipped checks did not run and were not passed' : ''),
);
process.exit(failed ? 1 : 0);
