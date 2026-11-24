> Historical development log (phase by phase). Referenced per-phase files were internal and are not in this repo.

# FixFlow — Phase 2 foundation + Phase 3 auth + Phase 4 workflows + Phase 5 inventory + Phase 6 non-money work + Phase 7 non-money work + Phase 8 non-money work + Phase 9 local validation + Phase 10 redesign + public landing page + Phase 11 usability/accessibility polish

Foundation + auth + first product workflows (customers, devices,
repairs) + inventory/parts + Phase 6 traceability, reports and
pagination + Phase 7 snapshot-consistent reports, durable retry and
search continuation + Phase 8 user-scoped pending operations,
multi-tab correctness and real lost-response tests + Phase 9
one-command isolated PostgreSQL 16 validation and an honest
test runner + Phase 10 mobile-first Arabic RTL redesign and a
per-tenant public landing page + Phase 11 frontend
usability/accessibility and shop-page polish (URL-synced repairs
filters, inline public-profile validation, LTR contact direction,
21 new web regression tests). Not production-ready, not
production-complete. No billing UI yet, no integrations configured,
no real data.

FixFlow is a proposed commercial Arabic-first / English repair-shop SaaS.
Arabic is the default language, RTL by default; English is LTR.

## Scope of Phase 11

- **Repairs filters live in the URL.** Status and branch filters
  are derived from `/repairs?status=…&branchId=…`, so dashboard
  chips and the bottom navigation can no longer leave the list
  showing a stale filter. Cards show the order ID, the real
  problem description, branch and date — the list endpoint returns
  no customer/device names, and none are invented.
- **Public-profile settings validation and accessibility.** Inline
  messages in Arabic + English tied to their fields
  (`aria-invalid`, `aria-describedby`), focus moves to the first
  invalid field, contact inputs and displayed values render
  left-to-right with bidi isolation, long names/URLs wrap in full,
  and the settings + public pages have no horizontal overflow at
  320px. Owner-only nav item; tenant-switch form isolation kept.
- **Regression tests:** 21 new web tests (108 total) and 5 new API
  unit tests for the rate limiter, plus two behaviour checks in
  `scripts/review-ui-check.mjs` (status-filter sync; public page
  publish/unpublish at 320px). Initial JS measured 478,543 bytes /
  153,716 gzip (reviewed Phase 10 tree: 476,554 / 153,143) — no
  reduction found, none claimed.
- **Public endpoint rate limiting.** `GET /api/public/shops/:slug`
  is limited to 100 requests per minute per IP (60-second sliding
  window, 10,000-key fail-closed in-memory store) by reusing the
  existing `createRateLimiter` helper; 429 with `Retry-After` on
  exceed. In-memory and per process: with N API instances the
  effective limit is `100 × N`, not a global limit. Rate-limit cases
  were added to `scripts/test-public-profile-http.mjs` (unrun here).
- See `CHANGES-PHASE11.md` for the exact changed files and the
  verified / untested status in this VM. `prisma generate` was
  deliberately not run here, so API typecheck/build and the HTTP
  harnesses are unrun.

## Scope of Phase 10

- **Mobile-first Arabic RTL redesign.** A consistent design system
  (deep green primary, gold accent used sparingly, soft surfaces,
  AA-contrast text and status sets, 44px touch targets,
  `prefers-reduced-motion` respected; see `docs/DESIGN.md`).
  Mobile: one-row sticky header + fixed bottom navigation + an
  RTL-aware drawer; desktop: a permanent sidebar with a clear
  active route and shop/branch context. The dashboard shows only
  real operational data (repairs summary, stock overview, latest
  repairs) with quick actions to real flows — no fabricated revenue
  or metrics, no charts. Repairs are readable cards with separated
  search/filter and accessible status chips; repair detail is split
  into Summary / Customer & device / Workflow & actions / Parts /
  History / Receipt; reports have collapsed filters, summary tiles
  and mobile cards. No dark mode (deliberately not done). Matched
  BEFORE/AFTER screenshots: run `SHOT_TAG=before npm run
test:ui:review` on the Phase 9 build, then `SHOT_TAG=after` (or
  default) on this build.
- **Per-tenant public landing page at `/s/:slug`.** Owner-configured
  only (name, description, logo, theme, services, contact, hours);
  nothing is copied from private operational data. Default
  unpublished/disabled; the public endpoint `GET
/api/public/shops/:slug` returns exactly eight fields when
  published and 404 otherwise. Owner settings at
  `/settings/public-profile` (owner-only) with a preview. See
  `docs/PUBLIC_PROFILE.md` for the design, the public-vs-private
  boundary and the validation rules. The public repair-status lookup
  is a proposal only — no endpoint, no repair-ID or phone search.
- See `CHANGES-PHASE10.md` for the exact changed files and the
  verified / untested status in this VM. `prisma generate` still
  needs approval (timed out again in this VM, not retried), so API
  typecheck/build and the HTTP harnesses are unrun here, including
  the new `test:public-profile:http`; the browser review (including
  the matched screenshots) is untested here too.

## Scope of Phase 9

- One-command isolated normal PostgreSQL 16 validation:
  `npm run test:pg16` starts a throwaway `postgres:16-alpine`
  container, creates owner/app roles, runs the full migration
  lineage, runs the four HTTP harnesses against the real server
  and the contention suite, then tears everything down. The gate
  (`FIXFLOW_TEST_DATABASE_URL` localhost-only, name contains
  "test", `FIXFLOW_TEST_DB_CONFIRM=test`) refuses anything else
  with exit 2 and never prints the URL. See
  `docs/LOCAL_VALIDATION.md`.
- Honest test runner: `npm run test:all` / `test:ci` runs format,
  lint, unit, DB, HTTP and gate checks, and runs the PG16/Docker/
  Node 24 steps only when their prerequisites exist — otherwise
  it SKIPs them with a reason, never fake-passes.
- Claim-lock removal (reviewed Phase 8 correction): the unused
  claim helpers are deleted; reconciliation uses read-only outcome
  lookups that are safe in more than one tab. Ownerless legacy
  records are left untouched and never attributed to the current
  login. No cross-tab mutex is claimed; server idempotency remains
  per operation key.
- Tenant-switch UI: a "switch workshop" button in the header for
  multi-tenant users, so the same-user tenant switch happens via
  the UI without logging out. Browser tests now cover the
  cookie-refresh scope change (aborts, no third request) and the
  same-user tenant switch (no replay, no stale data).
- Team pagination was evaluated and skipped (staff list inherently
  small; the harness asserts the full list). Team stays owner-only,
  read-only, unpaginated.
- See `CHANGES-PHASE9.md` for the exact changed files and the
  verified / untested status in this VM. `prisma generate` still
  needs approval (timed out again in this VM, not retried), so API
  typecheck/build and the HTTP harnesses are unrun here; the full
  `test:pg16` run and the browser review are untested here too.

## Scope of Phase 8

- User-scoped pending operations: pending stock-operation metadata
  is now keyed by (user, tenant) with one storage key per operation,
  cross-tab claims and storage-event sync, and a stock-changed
  broadcast so other tabs refresh. Another user's records are never
  read, reconciled or deleted. Nothing is ever re-submitted
  automatically; an unknown outcome still needs a human ledger
  check. See `docs/WORKFLOWS.md` and `docs/TENANCY.md`.
  (Correction from REVIEWED-PHASE8.md: the claim-lock part of this
  is superseded — runtime reconciliation no longer uses claims,
  and ownerless legacy records are never attributed to the current
  login. See CHANGES-PHASE9.md.)
- Real lost-response / reload tests: the client test drives the real
  stock-write flow (response lost after the server recorded it),
  then reloads and reconciles — completed and unknown cases, no
  re-POST, no seeded fixtures. The browser review script adds the
  same flows for real, plus multi-tab and account-switch tests and
  a network profiling capture.
- Broader auth / tenant-switch harness coverage: dual-membership
  tenant switching, stale-scope 403s, cross-account denial, logout
  family revocation, and operationKey cross-tenant isolation.
  These harness cases are written and syntax-checked but unrun here
  (they need the generated client); their pass/fail is unknown
  until the reviewer runs them.
- Reproducible initial-JS measurement: `scripts/measure-initial-js.mjs`
  reproduces the reviewer's Phase 7 numbers exactly (464,167 bytes /
  149,373 gzip for the six direct initial assets). Phase 8 measures
  467,200 / 150,118 (+3,033 / +745, the cost of the new code). Import
  profiling found no duplicated modules; the MUI no-vars entry point
  was verified absent (not exported, deep subpath blocked); the i18n
  split would save only ~4–8 kB and was not justified. No import
  reductions were kept, and no impossibility claim about under-400 kB
  is made.
- See `CHANGES-PHASE8.md` for the exact changed files and the
  verified / untested status in this VM. `prisma generate` still
  needs approval (timed out again in this VM, not retried), so API
  typecheck/build and the HTTP harnesses are unrun here; the
  contention suite's full run and the browser review are untested
  here too.

## Scope of Phase 7

- Snapshot-consistent operational reports: the repairs summary and
  the new combined stock overview (`GET /reports/stock/overview`)
  are each read in one REPEATABLE READ transaction and carry a
  `snapshotAt` label shown as "as of <time>" in the UI. Each
  response is consistent within itself; two pages are separate
  snapshots. See `docs/DATABASE.md`.
- Durable pending retry keys across page reload: pending stock
  operations survive a reload in tenant-scoped localStorage, storing
  only the operation key, kind, repair reference and timestamp — no
  tokens, no request body — and are reconciled against the movements
  ledger (`GET /stock/movements?operationKey=`). Nothing is ever
  re-submitted automatically. See `docs/WORKFLOWS.md`.
- Search continuation: the SearchPicker pages through results
  ("Load more results"), and the last first-100 trap (the Stock page
  part filter) is now a SearchPicker.
- Total initial JS measured honestly: 452.94 kB (vs 450.6 kB in
  Phase 6). The under-400 kB goal is not achievable without changing
  frameworks — the i18n dictionaries are only ~17.7 kB and the large
  chunks are React + MUI machinery. Recorded in
  `apps/web/vite.config.ts`.
- Extended checks: the reports harness covers snapshot agreement and
  the operation-key lookup; the browser review script covers English
  reports/team at desktop and mobile widths, SearchPicker
  continuation, and the durable-retry banner. Staff lifecycle and
  branch writes are proposed in `docs/PROPOSALS.md` only, not
  implemented.
- See `CHANGES-PHASE7.md` for the exact changed files and the
  verified / untested status in this VM. `prisma generate` still
  needs approval (timed out again in this VM, not retried), so API
  typecheck/build and the HTTP harnesses including the extended
  `test:reports:http` are unrun here; the contention suite's full
  run and the browser review are untested here too.

## Scope of Phase 6

- Stock movement traceability (migration 0008): every movement
  records the repair, part line, idempotency key and actor; the
  ledger shows the repair link and actor name. A quantity ceiling of
  1,000,000,000 is enforced by DB CHECKs and the pure inventory
  helpers. No pricing/tax/provider choices were invented.
- Read-only reports (`report:read`): repair counts by status with
  aging buckets (0–1d / 2–7d / 8–30d / 30d+), stock/reservation
  reconciliation (discrepancy highlighted), and a read-only Team view
  (owner only). See `docs/WORKFLOWS.md` and `docs/TENANCY.md`.
- Normal-PostgreSQL contention tests (`scripts/test-contention.mjs`,
  `npm run test:contention:pg`) gated to an explicit localhost TEST
  database — last-unit reserve, reserve-vs-cancel,
  consume-vs-reassignment, duplicate retries, rollback. Never run
  against real data. See `docs/DATABASE.md`.
- Frontend: Reports and Team pages (Arabic/English, lazy-loaded,
  permission-gated), cursor-based "Load more" on the main lists, a
  reusable debounced SearchPicker for large pickers, and a measured
  chunk reduction: index 260.83 kB → 50.22 kB with total initial JS
  unchanged at 450.6 kB (React-only vendor split; a full vendor split
  was tried and reverted because it made total initial JS ~575 kB).
- See `CHANGES-PHASE6.md` for the exact changed files and the
  verified / untested status in this VM. `prisma generate` still
  needs approval (timed out again in this VM, not retried), so API
  typecheck/build and the HTTP harnesses including
  `test:reports:http` are unrun here; the contention suite's full
  run is untested here too.

## Scope of Phase 5

- Parts catalog (create/list/search/detail, SKU unique per tenant),
  branch stock (`qtyOnHand` / `reservedQty` / `available`), and an
  immutable stock-movements ledger (migration 0007). Parts carry no
  price: pricing/tax/provider choices were not invented.
- Repair-part reserve/release/consume in one tenant-scoped
  transaction with conditional writes and idempotency keys: reserve
  raises `reservedQty` only, release lowers it only, consume lowers
  both exactly once; no negative stock, no cross-tenant references,
  no branch bypass. Cancelling or marking a repair unrepairable
  auto-releases its reserved parts. See `docs/WORKFLOWS.md`.
- Permissions: `stock:reserve` / `stock:release` / `stock:consume`
  (owner/admin/manager; technician consumes only on assigned
  repairs). See `docs/TENANCY.md`.
- Frontend: real Arabic RTL / English LTR Parts and Stock pages,
  movements ledger, and a Parts section on repair detail, all
  role-gated. See `CHANGES-PHASE5.md` for the exact changed files
  and the verified / untested status in this VM. The inventory HTTP
  suite has not executed anywhere yet.

## Scope of Phase 4

- Auth hardening: rate limits (login/register/refresh), HttpOnly
  SameSite `ff_refresh` cookie, Origin/CSRF check on
  cookie-authenticated auth mutations (`WEB_ORIGINS`). Access token
  lives in memory only; no token in localStorage. See `docs/AUTH.md`.
- Roles: receptionist + accountant least-privilege backend roles
  (migration 0005). See `docs/TENANCY.md`.
- Repair workflow: customers (list/search/create/detail), device
  intake (no unlock passwords, ever), repair create/list/detail,
  branch-scoped technician assignment (with a technician directory),
  validated state transitions incl. `quality_check` and
  `unrepairable`, optimistic concurrency (409 on stale version),
  immutable history, printable receipt. See `docs/WORKFLOWS.md`.
- Frontend: real Arabic RTL / English LTR login, owner onboarding,
  tenant picker, protected shell, customers, devices, repairs.
  See `CHANGES-PHASE4.md` for the exact changed files and the
  verified / untested status in this VM.

## Scope of Phase 3

- Prisma 7 fix: `prisma7.config.ts`, required generator output,
  `@prisma/adapter-pg` driver adapter, `Prisma.TransactionClient`
  typing. See `docs/DATABASE.md` and `CHANGES-PHASE3.md`.
- Real migration startup: `prisma migrate deploy` as the owner in
  `migrate-and-start.sh`; `fixflow_app` is a non-owner NOBYPASSRLS
  role created by a single flat init file. The nested-migration
  initdb mount is gone.
- Tenant isolation: tenant-aware FKs for `role_permissions`,
  `reseller_tenants`, `purchase_orders`, `purchase_order_lines`,
  `webhook_events`, `refresh_sessions`; `reservedQty <= qtyOnHand`
  CHECK on `branch_stock` (migration 0003).
- PWA caching restricted to an explicit static allowlist
  (`docs/PWA.md`).
- Auth/onboarding: Argon2id passwords, 15-minute access JWT,
  rotating refresh sessions with reuse detection, logout,
  owner registration + initial branch, server-side
  membership/branch RBAC. See `docs/AUTH.md`. No email
  verification or password-reset delivery — those gaps are
  labelled, not faked.
- E2E tests for auth and tenant isolation, gated by
  `E2E_DATABASE_URL` (they skip without a local PostgreSQL):
  ```sh
  E2E_DATABASE_URL=postgresql://fixflow_owner:...@localhost:5432/fixflow_test npm run test:e2e --workspace=@fixflow/api
  ```

## Scope of Phase 2

- Maintainable local monorepo: React + TypeScript + Vite + MUI web app,
  NestJS + Prisma + PostgreSQL API, Redis / BullMQ, Nginx, Docker Compose.
- Normalized database foundation with tenant-aware composite constraints
  and row-level security (RLS) SQL migrations.
- A small tested core boundary: authenticated `TenantContext`,
  permissions, branch checks, versioned entitlements.
- PWA: Arabic RTL manifest, hand-written service worker (static shell
  only, never `/api`), offline shell, update prompt, offline indicator.
  See `docs/PWA.md` and `docs/PERFORMANCE.md`.
- No fake UI controls, no claims of production completion.

## Target

```sh
docker compose up --build
```

This target is **untested in this delivery** — no Docker daemon was
available for the independent review. Install, generation, test and build
results are recorded in `REVIEWED-PHASE4.md`. Earlier `BUILD_NOTES.md` and
phase-change files are historical builder notes, not current review results.

## Run locally (after install)

```sh
cp .env.example .env   # then replace every CHANGE_ME placeholder
npm ci
npm run prisma:generate
npm run prisma:migrate
npm run dev            # api on :3000, web on :5173
```

Local validation against a real server is a separate path — see
`docs/LOCAL_VALIDATION.md`: `npm run test:pg16` starts an isolated
throwaway PostgreSQL 16 container and runs the HTTP harnesses plus
the contention suite against it, and `npm run test:all` runs every
check with honest skips for anything whose prerequisite is missing.

Commands:

- `npm run typecheck` — TypeScript in all workspaces
- `npm run lint` — ESLint (JS/MJS only; see `eslint.config.mjs`)
- `npm run format` / `npm run format:check` — Prettier
- `npm run test` / `npm run test:api` / `npm run test:web`
- `npm run test:db` — embedded-PostgreSQL migration/RLS/constraint checks (PGlite)
- `npm run test:auth:http` / `test:repairs:http` / `test:inventory:http` / `test:reports:http` / `test:public-profile:http` — HTTP harnesses (PGlite by default; normal PG16 with `FIXFLOW_HTTP_DATABASE_URL`, see `docs/LOCAL_VALIDATION.md`)
- `npm run test:contention:pg` — normal-PostgreSQL 16 contention suite (gated to a localhost TEST database; see `docs/LOCAL_VALIDATION.md`)
- `npm run test:pg16` — one-command isolated normal-PG16 validation (throwaway container; see `docs/LOCAL_VALIDATION.md`)
- `npm run test:all` / `npm run test:ci` — honest runner: every check above plus the PG16 run, Docker build and Node 24 checks when their prerequisites exist; skips are printed, never faked as passes
- `npm run build`
- `npm run prisma:generate` / `npm run prisma:migrate`

## Integrations — explicitly UNCONFIGURED

All disabled by default, env flags `*_ENABLED=false` placeholders only:

- WhatsApp Cloud API — not configured, not assumed to work
- Email — not configured
- AI (provider-abstracted, optional) — not configured, no diagnosis
  guarantee, no autonomous financial changes
- Payment provider / SaaS billing webhooks — not configured

Do not enable any of these by editing a flag alone; each needs its
own credentials, verification, and review.

## PWA

- Manifest: `apps/web/public/manifest.webmanifest` (ar, RTL)
- Service worker: `apps/web/public/sw.js`, registered only in
  production builds, only after the user confirms an update.
- The service worker caches the static shell only. It never caches
  `/api`, invoices, or customer photos. There is no offline mutation
  queue: offline, the app shows offline state and refuses payment /
  stock actions instead of queuing them silently. See `docs/PWA.md`.

## Performance

Budgets are targets to measure, not claims. See `docs/PERFORMANCE.md`.
All performance and PWA verification is untested until the parent
runs it in a real browser / build.

## Docs

- `docs/AUTH.md` — Phase 3 auth: tokens, rotation/reuse, registration, RBAC, gaps; Phase 4: rate limits, cookie/CSRF design
- `docs/WORKFLOWS.md` — Phase 4 customers/devices/repairs flows, state machine, optimistic concurrency; Phase 5 inventory flows
- `docs/ARCHITECTURE.md` — modular monolith, boundaries
- `docs/DATABASE.md` — Prisma 7, migrations, Decimal money, pagination indexes
- `docs/TENANCY.md` — TenantContext, RLS, branch authorization
- `docs/SECURITY.md` — auth, webhooks, audit, threat tests
- `docs/DECISIONS.md` — decisions and corrections
- `docs/PWA.md` — service worker, logout / tenant switch, offline rules
- `docs/PERFORMANCE.md` — measurable budgets and how to measure them
- `docs/LOCAL_VALIDATION.md` — one-command isolated normal-PG16 validation, the honest check runner, and what is still unproved
- `docs/db/app-role.sql` — non-owner app DB role (reference only; the
  executable version is `docker/postgres/01-app-role.sh`)
- `CHANGES-PHASE3.md` — Phase 3 changed files, exact command outcomes, limitations
- `CHANGES-PHASE4.md` — Phase 4 changed files, exact command outcomes, limitations
- `CHANGES-PHASE5.md` — Phase 5 changed files, exact command outcomes, limitations
