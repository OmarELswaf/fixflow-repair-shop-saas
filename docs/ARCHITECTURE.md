# Architecture — FixFlow Phase 2

Modular monolith. One NestJS app, one PostgreSQL database, one shared
schema. Modules must not access another module's tables directly;
they go through that module's service and the shared `TenantContext`.

## Modules (API)

- `env` — Zod-validated environment, fails fast.
- `prisma` — PrismaClient, `withTenant()` transaction helper.
- `tenancy` — TenantContext resolution, permissions, entitlements.
- `health` — `GET /health`, `GET /health/ready` (no DB required for `/health`).
- `queue` — BullMQ, tenant_id in every job payload, worker re-resolves tenant.
- `inventory` — pure stock functions (see corrections in DECISIONS.md).
- `money` — Decimal-safe helpers (decimal.js).
- `common/pagination` — indexed, tenant-scoped cursor pagination.

Later modules, in the same monolith: branches, customers/devices,
repairs, inventory/purchasing, invoices/payments, reports, subscriptions,
white-label/resellers, notifications. Each is a NestJS module with its
own service, controller, and tests.

## Frontend

React 18+ / TypeScript / Vite / MUI, React Router with lazy routes,
TanStack Query, React Hook Form + Zod, Axios (`/api` base).
Arabic default, RTL; English toggle changes `lang` and `dir`.
PWA shell is tenant-agnostic and contains no tenant data.

## Infrastructure

Docker Compose: `postgres:16-alpine`, `redis:7-alpine`, `api`, `web`,
`nginx`. Nginx proxies `/api` to the API and `/` to the web app.
Redis is for BullMQ and namespaced cache only, never as a source of truth.

## Corrections applied (from Phase 1 review)

1. Inventory: reservation increases `reserved_qty` ONLY, never
   decrements `qty_on_hand`. Consumption decrements `qty_on_hand` AND
   `reserved_qty` once, in one transaction.
2. Phase 1 tests were planned, not passed. Nothing here claims they passed.
3. A missing RLS policy on an RLS-enabled table is default-deny, not a
   leak. Disabled RLS or a bypass role can leak.
4. Money is PostgreSQL `Decimal` (Prisma `Decimal`), decimal-safe
   arithmetic with decimal.js, currency stored per invoice.
5. Provider webhooks alone do NOT drive trials / time expiry. Internal
   clock transitions are audited too.
6. Object-storage prefixes are NOT access controls. Signed URLs +
   server-side tenant checks are.
7. Never interpolate a tenant setting into SQL. Set it via a
   parameterized transaction-local configuration on the SAME DB
   connection as the transaction.
