# Decisions — FixFlow Phase 2

## Adopted

- Modular monolith over microservices for Phase 2: one app, one
  database, transactions and tenant isolation stay auditable.
- Shared PostgreSQL schema with `tenant_id` + RLS, not a database
  per tenant.
- Money as PostgreSQL `Decimal` / Prisma `Decimal`, decimal.js
  arithmetic, currency per invoice.
- PWA: hand-written service worker, no vite-plugin-pwa / Workbox.
  Static shell only, never `/api`. See `docs/PWA.md`.
- Route code splitting with React.lazy + Suspense.
- Cursor pagination ordered by `(tenant_id, created_at DESC, id DESC)`.

## Corrections from the Phase 1 review

1. Inventory reservation increases `reserved_qty` ONLY, never
   decrements `qty_on_hand`. Consumption decrements `qty_on_hand`
   AND `reserved_qty` once, in one transaction.
2. Phase 1 tests were planned, not passed.
3. A missing RLS policy on an RLS-enabled table is default-deny,
   not a leak. Disabled RLS or a bypass role can leak.
4. Money is PostgreSQL Decimal, decimal-safe arithmetic, currency
   stored per invoice.
5. Provider webhooks alone do NOT drive trials / time expiry.
   Internal clock transitions are audited too.
6. Object-storage prefixes are NOT access controls. Signed URLs +
   server-side tenant checks are.
7. Never interpolate a tenant setting into SQL. Set it through
   parameterized transaction-local configuration on the same DB
   connection as the transaction.

## Not decided / out of scope for Phase 2

- Payment provider, tax / VAT, e-invoicing, refund policy.
- Plan limits and pricing (all limits are proposed, unpriced).
- White-label domains / SSL, reseller commission terms.
- WhatsApp template approval, data residency, backup / restore,
  customer data deletion, AI scope and provider.
- TypeScript ESLint plugin: no version was supplied in the pinned
  list, so it is intentionally not added.
- `@types/*` packages: not in the pinned list. Versions added are
  the matching major versions and are flagged unverified in
