# Local validation — normal PostgreSQL 16, Docker, Node 24

Phase 9. This is the reproducible local validation path. It exists
because the default suites do **not** prove a normal PostgreSQL 16
installation, Docker startup, or the Node 24 runtime: unit tests run
against mocks, `test:db` runs against embedded PGlite, and the HTTP
harnesses run against PGlite over a socket. Those suites are real
checks of the code, but they are not a normal-server check.

## One command: `npm run test:pg16`

```sh
FIXFLOW_TEST_DATABASE_URL=postgresql://fixflow_app:change-me@127.0.0.1:15440/fixflow_test_pg16 \
FIXFLOW_TEST_DB_CONFIRM=test \
npm run test:pg16
```

What it does, in order:

1. **Gate first, before any Docker call** (same gate as the
   contention suite, `scripts/contention-gate.mjs`):
   `FIXFLOW_TEST_DATABASE_URL` must be set, host must be localhost,
   127.0.0.1 or ::1, database name must contain `test`
   (case-insensitive) and be a plain SQL identifier, and
   `FIXFLOW_TEST_DB_CONFIRM` must be `test`. Anything else is
   refused with exit code 2. The URL is never printed.
2. Starts a throwaway `postgres:16-alpine` container
   (`docker/compose.pg16.test.yml`): run-suffixed container and
   volume names, localhost-only port, no other service. Waits for
   readiness with a bounded 60-second `pg_isready` loop.
3. Probes whether the target database already exists. If it does,
   the run refuses (exit 2) unless `FIXFLOW_TEST_DB_RECREATE=1` is
   set. A database this run creates is dropped and recreated empty
   before each suite, so every suite starts from an empty database
   exactly like PGlite mode.
4. Creates the roles with the same names as the production compose
   setup: `fixflow_owner` (migration/owner role) and `fixflow_app`
   (LOGIN, NOBYPASSRLS, never a superuser, never a table owner),
   with per-run random passwords that are held in memory only and
   never printed. The user/password in the URL you declared are
   **not used** — the URL only declares the target (host, port,
   database name). The script hands the real generated URLs to the
   suites.
5. Runs `npm run prisma:generate` and builds the API.
6. Runs the four HTTP harnesses in normal-PG16 mode (the same
   cases, unmodified, against the real server) and then the
   contention suite (`test:contention:pg`: last-unit reserve,
   reserve-vs-cancel, consume-vs-reassignment, duplicate retries,
   rollback, and the stock invariants).
7. Prints a summary manifest (PASS/SKIP/FAIL per check) and tears
   down: the throwaway database and app role are dropped, the
   container is stopped and removed, and the volume is removed —
   even on failure.

Exit codes: 0 = every suite that ran passed (skips allowed);
1 = a setup step or a suite failed; 2 = refused to run (gate,
Docker unavailable, target database already exists).

## What it does NOT do

- **No `--use-local` mode.** There is no path that reuses an
  already running PostgreSQL server. Reusing a shared server would
  need a second admin credential input and "only drop what we
  created" tracking for roles and databases; the container path is
  self-contained and deterministic instead.
- **`test:db` is skipped, honestly.** `scripts/test-database.mjs`
  imports `@electric-sql/pglite` and cannot run against a normal
  server without a rewrite. The run prints SKIP with that reason —
  it does not fake the check. Run `npm run test:db` for the
  embedded migration/RLS/constraint checks.
- **No Docker build, no Redis, no deployment.** The Docker build
  check is a step of the runner below.
- **No remote hosts, no existing business data, no printed
  credentials, no unbounded waits, no silent failures.** The
  container and volume are the only things created, and both are
  removed in teardown.

Requires: Docker with the compose plugin, and network for the
`postgres:16-alpine` image (first run) and the Prisma engine
download.

## The runner: `npm run test:all` (`npm run test:ci` in CI)

`scripts/run-checks.mjs` runs, in order: format check, lint,
contention-gate unit tests, gate refusal paths, API unit tests, web
tests, web typecheck, web build, `test:db`, the four HTTP harnesses
(PGlite mode by default), and — when prerequisites exist — the
isolated PG16 run, the Docker build check, and the Node 24 runtime
check.

**Honest-skip contract:** a check that cannot run is SKIPPED with
its reason, never PASS. The run exits non-zero only on FAIL; a run
with skips exits 0 and prints a summary manifest including how many
checks were skipped.

Prerequisite rules:

| Check                     | Runs when                                                        | Otherwise                                                     |
| ------------------------- | ---------------------------------------------------------------- | ------------------------------------------------------------- |
| HTTP harnesses (PGlite)   | Generated Prisma client exists (`apps/api/src/generated/prisma`) | SKIP — "run `npm run prisma:generate && npm run build` first" |
| `test:pg16` (normal PG16) | Docker with compose plugin is available                          | SKIP — "docker not found"                                     |
| Docker build (api + web)  | Docker is available                                              | SKIP — "docker not found"                                     |
| Node 24 runtime           | This process runs on Node 24                                     | SKIP — prints the actual version                              |

The Node 24 check is precise: when it passes, it means the
unit/web/DB suites in **that run** executed under that Node 24
version. It does not claim the Docker/PG16 parts ran under Node 24
— those are separate steps with their own results. The full
"Node 24 runtime" proof (Docker + PG16 + suites under Node 24)
exists only when the PG16 and Docker steps also ran.

CI (`.github/workflows/ci.yml`) runs `npm ci --ignore-scripts`,
`npm run prisma:generate`, then `npm run test:ci`. Docker exists on
`ubuntu-latest`, so the PG16 and Docker build steps run there; on a
machine without Docker they skip.

## Running the HTTP harnesses against normal PG16 directly

The four harnesses accept an env-driven switch
(`scripts/http-test-db.mjs`): when `FIXFLOW_HTTP_DATABASE_URL` is
set (and gated — localhost only, name contains `test`,
`FIXFLOW_TEST_DB_CONFIRM=test`), the harness runs against that real
database instead of PGlite. Default (unset) is PGlite, unchanged.
Every harness case is kept in order; no assertion changes. The
database must already be migrated with the app role — the supported
path is `npm run test:pg16`, which does that setup first.

## What is still unproved

- Redis readiness and the production compose target
  (`docker compose up --build`) are not covered by this path; the
  runner's Docker build check only builds the api and web images.
- Real-device performance and the browser visual check are
  separate (`npm run test:ui:review`, needs Chrome).
- Normal-PG16 contention is proved only when `npm run test:pg16`
  (or `npm run test:contention:pg` against an operator-provided
  throwaway TEST database) actually runs; the gate tests and the
  refusal paths are gate evidence, not concurrency evidence.
