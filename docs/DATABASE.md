# Database — FixFlow Phase 2

PostgreSQL 16, Prisma schema in `apps/api/prisma/schema.prisma`,
SQL migrations in `apps/api/prisma/migrations/`.

## Prisma 7

Prisma 7 (7.10.1) changed the setup, and the Phase 2 schema had to
be fixed for it (Phase 3, migration of the config, not the data):

- The schema `datasource` block contains ONLY `provider =
"postgresql"`. The URL lives in `apps/api/prisma7.config.ts`
  (`defineConfig` from `prisma/config`, `datasource.url:
env("DATABASE_URL")`). A `url` in the schema is rejected by
  Prisma 7 — that was the actual Phase 2 failure, not just the
  network.
- The generator is `prisma-client` with a REQUIRED custom output:
  `output = "../src/generated/prisma"`. The client is no longer in
  `node_modules` and is not committed; run `npm run prisma:generate`
  on every fresh checkout / build (CI does it before typecheck).
  All imports use the generated path, e.g.
  `import { PrismaClient } from "../generated/prisma/client"`.
- A driver adapter is mandatory: `@prisma/adapter-pg` 7.10.1.
  `PrismaService` builds a `pg` Pool (`connectionTimeoutMillis:
5000`, because pg has no timeout by default) and constructs
  `new PrismaClient({ adapter: new PrismaPg(pool) })`. A
  parameterless `new PrismaClient()` does not work in Prisma 7.
- Transactions use `Prisma.TransactionClient` as the callback type.
- `prisma generate` needs `DATABASE_URL` to be resolvable by the config even though it does not connect. Set a placeholder value if no `.env` exists.

## Migration startup (real, not initdb)

PostgreSQL init directories do NOT recursively execute nested
files. The Phase 2 approach of mounting
`apps/api/prisma/migrations` into `/docker-entrypoint-initdb.d`
never applied the migrations. Phase 3 replaces it:

- `docker/postgres/01-app-role.sh` — a SINGLE flat init file that
  creates the `fixflow_app` role (LOGIN, NOBYPASSRLS) on first init
  of an empty data directory. It fails loudly if
  `APP_DB_PASSWORD` is unset.
- `apps/api/scripts/migrate-and-start.sh` — the API container
  entrypoint. It runs `npx prisma migrate deploy` as the OWNER
  (using `MIGRATION_DATABASE_URL`, passed as `DATABASE_URL` for
  that command only, with retries while Postgres starts), then
  `exec node dist/main.js` as the app role. The app never runs as
  the owner and migrations never run as the app role.
- `docs/db/app-role.sql` is reference only; the `.sh` file is the
  executable version.
- `apps/api/Dockerfile` runs `prisma generate` at build time
  (placeholder `DATABASE_URL`, no connection) so the image has a
  generated client, then starts via `migrate-and-start.sh`.

## Normalized entity groups

- Tenancy: Tenant, Branch, User, Membership, Role, Permission,
  RolePermission.
- Customer: Customer, Device.
- Repair: RepairOrder, RepairEvent, RepairApproval.
- Inventory: Part, BranchStock, StockMovement, Supplier,
  PurchaseOrder, PurchaseOrderLine.
- Money (repair, tenant-owned): Invoice, Payment, Refund, LedgerEntry.
- Money (SaaS, platform-owned): Plan, PlanVersion, Subscription,
  Entitlement, WebhookEvent. These are separate from repair money.
- White-label / reseller: TenantBranding, Reseller, ResellerTenant.
- Audit: AuditLog, append-only.

## Money

PostgreSQL `Decimal` (`DECIMAL(19,4)` in SQL, Prisma `Decimal`).
Arithmetic only via `decimal.js` helpers in `apps/api/src/money/`.
Currency is stored per invoice (`currency` column, e.g. `SAR`).
Never use floating-point arithmetic for money. `0.1 + 0.2` must be
`0.3`, not `0.30000000000000004` — covered by `money.spec.ts`.

## Tenant-aware constraints

- Every tenant-owned table has `tenant_id`.
- Composite uniques: `(tenant_id, sku)` on parts,
  `(tenant_id, branch_id, part_id)` on branch stock,
  `(tenant_id, idempotency_key)` on payments,
  `(tenant_id, provider, event_id)` on webhook events.
- Composite foreign keys in SQL enforce tenant consistency, e.g.
  `FOREIGN KEY (tenant_id, customer_id) REFERENCES customers(tenant_id, id)`
  and `FOREIGN KEY (tenant_id, branch_id, part_id)
REFERENCES branch_stock(tenant_id, branch_id, part_id)`.
  Prisma cannot express every composite FK; where Prisma cannot,
  the SQL migration enforces it and this document says so.
- Checks: `qty_on_hand >= 0`, `reserved_qty >= 0`,
  `reserved_qty <= qty_on_hand` (added in migration 0003, and
  enforced in `reserveStock` in application code too),
  money amounts `>= 0` where applicable.
- Migration 0003 (Phase 3) filled the tenant-aware FKs 0001 missed:
  `role_permissions (tenant_id, role_id) → roles(tenant_id, id)`,
  `reseller_tenants.tenant_id → tenants(id)`,
  `purchase_orders (tenant_id, branch_id) → branches(tenant_id, id)`,
  `purchase_order_lines (tenant_id, part_id) → parts(tenant_id, id)`,
  `webhook_events.tenant_id → tenants(id)`, and
  `refresh_sessions (tenant_id, user_id) → memberships(tenant_id, user_id)`.
  `roles` gained `UNIQUE (tenant_id, id)` so the composite FK can
  reference it; `memberships` gained `UNIQUE (tenant_id, user_id)`.
- Migration 0005 (Phase 4) adds the `receptionist` and `accountant`
  membership roles and the `quality_check` and `unrepairable` repair
  statuses (enum values), `repair_orders.assignedTechnicianId`
  (FK → `users.id`), `repair_orders.version` (optimistic
  concurrency, default 0), `repair_orders.problemDescription`,
  `repair_events.note`, and the index
  `(tenant_id, status, created_at DESC, id DESC)` on repair orders
  for status-filtered lists.
- Migration 0007 (Phase 5) adds `repair_parts` (FKs
  `(tenant_id, order_id) → repair_orders(tenant_id, id)`,
  `(tenant_id, part_id) → parts(tenant_id, id)`,
  `(tenant_id, branch_id) → branches(tenant_id, id)`;
  `CHECK (qty > 0)`; partial unique index
  `(tenant_id, order_id, part_id) WHERE status = 'reserved'`, so at
  most one active line exists per order+part) and
  `stock_idempotency` (`UNIQUE (tenant_id, scope, key)`,
  `responseJson` JSONB holding `{ request, response }`).
  `stock_movements` gains the same append-only trigger as
  `repair_events`/`audit_log` (0006). The non-negative
  `branch_stock` CHECKs already exist in 0001 and are not repeated.

## Inventory semantics (corrected)

- `reserveStock`: `reserved_qty += qty` only. `qty_on_hand` unchanged.
- `consumeStock`: `qty_on_hand -= qty` AND `reserved_qty -= qty`,
  once, in one transaction. Throws if insufficient.
- `releaseStock`: `reserved_qty -= qty` only.
  See `apps/api/src/inventory/inventory.ts` and its tests.
- Phase 5 stock writes go through `applyStockChange` in
  `apps/api/src/inventory/stock-ops.ts`: the pure helpers validate
  the resulting state first, then one conditional `updateMany`
  (WHERE guards: post-change quantities stay non-negative) applies
  increments; the `reserved_qty <= qty_on_hand` CHECK is the
  backstop against a concurrent reservation. A lost update is a
  422, never a silent overwrite.
- `stock_movements` is the append-only ledger: signed quantities
  (`reserve` +qty, `release` −qty, `consume` −qty, `adjust` delta),
  one row per stock change, no update/delete API or trigger bypass.
- Reserve/release/consume/adjust are idempotent per
  `(tenant_id, scope, key)` in `stock_idempotency`: a replay
  returns the stored response, a key reused with a different body
  is a 409. The key is claimed last, inside the same transaction
  as the work; a concurrent duplicate hits the unique index and
  the service re-reads and returns the stored response.

## Movement traceability and ceilings (Phase 6)

- `stock_movements` carries direct references (migration 0008):
  `repairOrderId`, `repairPartId`, `operationKey`, `actorId`, with
  tenant-aware FKs to `repair_orders` / `repair_parts` and an FK to
  `users`. Reserve/release/consume write the order id, the line
  id, the idempotency key and the acting user; adjust writes the
  idempotency key and the actor; auto-release writes the
  deterministic key `auto-release:<orderId>:<lineId>`. Rows written
  before 0008 keep NULL references — no backfill is attempted.
  Indexes on `(tenantId, repairOrderId, …)`,
  `(tenantId, operationKey, …)` and `(tenantId, actorId, …)`.
- Quantity ceiling: `MAX_QTY = 1,000,000,000` in
  `apps/api/src/inventory/inventory.ts` (pure pre-check in
  reserve/consume/release) and named CHECKs in migration 0008
  (`branch_stock.qtyOnHand/reservedQty <= 1000000000`,
  `repair_parts.qty <= 1000000000`,
  `stock_movements.qty` between −1,000,000,000 and 1,000,000,000).
  int4 tops out at 2,147,483,647; the ceiling leaves headroom for
  one max-size increment. DTO bounds are unchanged (reserve qty
  1..100000, adjust |delta| ≤ 100000) — the ceiling is the
  backstop layer, not a new user-facing limit.
- Contention: the embedded-PG checks serialize connections and
  cannot prove independent-connection behavior. The separate
  suite `scripts/test-contention.mjs` (`npm run
test:contention:pg`) runs against a real PostgreSQL 16 server
  and the built API. It is gated (see
  `scripts/contention-gate.mjs`): it refuses to run unless
  `FIXFLOW_TEST_DATABASE_URL` points at a localhost database whose
  name contains `test` and `FIXFLOW_TEST_DB_CONFIRM=test`; it
  never runs against real data. It is not part of `npm test` or CI.

## RLS

`ENABLE ROW LEVEL SECURITY` on all tenant tables in migration 0002,
plus `role_permissions`, `reseller_tenants` and `refresh_sessions`
in migration 0003, and `repair_parts` / `stock_idempotency` in
migration 0007. Policies require
`tenant_id = current_setting('app.tenant_id', true)`.
A missing policy on an RLS-enabled table is default-deny, not a leak.
Disabled RLS or a `BYPASSRLS` / owner role can leak — the app role
must be a non-owner role without `BYPASSRLS`. See `docs/db/app-role.sql`
and `docker/postgres/01-app-role.sh`.

The tenant setting is never interpolated into SQL. It is set via a
parameterized transaction-local configuration on the same connection
as the transaction (Prisma `$executeRaw` with a bound parameter,
`SELECT set_config('app.tenant_id', $1, true)`).

Two narrow exceptions exist for login/refresh, which happen before
any tenant is known (migration 0003, documented in `docs/AUTH.md`
"Bootstrap reads"): `memberships` and `refresh_sessions` have an
additional SELECT policy that applies only while no tenant context
is set. `users`, `tenants`, `plans`, `plan_versions` and
`entitlements` are platform tables with no tenant RLS; access to
them is via server code.

## Indexed, tenant-scoped pagination

List endpoints use cursor pagination ordered by a unique indexed key:
`(tenant_id, created_at DESC, id DESC)`. The shared schema is
`PaginationQuerySchema` in `packages/shared` (cursor + limit, limit
capped at 100). Supporting Prisma indexes:

- `Customer @@index([tenantId, createdAt, id])`
- `RepairOrder @@index([tenantId, createdAt, id])`,
  `@@index([tenantId, branchId, createdAt, id])`,
  `@@index([tenantId, status, createdAt, id])` (migration 0005,
  for status-filtered repair lists)
- `Invoice @@index([tenantId, createdAt, id])`
- `Part @@index([tenantId, createdAt, id])`
- `AuditLog @@index([tenantId, createdAt, id])`

Offset pagination is not used for tenant lists: it is unstable under
concurrent inserts and does not use the cursor key. The API helper is
`apps/api/src/common/pagination.ts`.

## Snapshot-consistent reports (Phase 7)

Phase 6's summary queries used separate statements, so one response
could mix two snapshots during concurrent writes. Phase 7 fixes
that per response, not per page:

- `GET /reports/repairs/summary` and `GET /reports/stock/overview`
  each run inside ONE transaction at `REPEATABLE READ` isolation
  (`PrismaService.withTenantSnapshot`, `$transaction(fn, {
isolationLevel: 'RepeatableRead' })`). Total, by-status counts
  and aging buckets — or stock summary and one page of
  reconciliation rows — are all read from the same snapshot.
- The tenant context is set on the same transaction/connection,
  parameterized (`SELECT set_config('app.tenant_id', $1, true)`),
  exactly as `withTenant` does. Nothing is interpolated.
- Each response carries `snapshotAt`: `SELECT now()` inside the
  same transaction. PostgreSQL's `now()` is constant within a
  transaction, so it labels the snapshot exactly. The UI shows it
  so the reader can see which moment the numbers describe.
- PGlite accepts the explicit isolation level (the Phase 7 check
  in `scripts/test-database.mjs` asserts `SHOW
transaction_isolation = 'repeatable read'` and that `now()` is
  constant inside the transaction). No fallback is in use.
- Honest limit: a response is snapshot-consistent WITHIN itself.
  Two separate requests — including two pages of one cursor scan —
  are separate snapshots, so cross-page stability is NOT claimed.
  A cursor page can, under concurrent writes, disagree with a
  later page. The summary in each overview page is the summary of
  that page's snapshot, which is why the harness checks summary
  stability only when no writes happen between pages.
- The existing SQL rules are unchanged: no int4 aggregate casts
  (float8 sums; the 3,000,000,000 regression in
  `scripts/test-reports-http.mjs` still passes), qualified cursor
  fields, cursor/limit/date validation as reviewed.
