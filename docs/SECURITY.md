# Security — FixFlow Phase 2

## Auth

- Short-lived JWT access tokens (900s default) + rotating refresh
  tokens. Refresh-token reuse revokes the session family (unit-tested
  in `refresh-sessions.spec.ts` and `auth.service.spec.ts`; the
  database-backed reuse path is covered only by the gated e2e tests).
- Strong password hashing with Argon2id (memoryCost 19456, timeCost
  2, parallelism 1). Minimum password length 12. No password is
  stored in the repo; the seed hashes `DEMO_PASSWORD` from the
  environment at seed time.
- No bypass DB credentials in the app. The app connects as a
  non-owner role without `BYPASSRLS`. Migrations run as a separate
  owner role via `migrate-and-start.sh`.
- No email verification or password-reset delivery exists in Phase 3
  — see `docs/AUTH.md` "Gaps". Do not present accounts as verified.

## Subscriptions and webhooks

- Subscription state machine: `trial → active → past_due →
suspended → cancelled`, plus `expired`.
- Provider webhooks alone do NOT drive trials / time expiry.
  Internal clock transitions (e.g. trial expiry) are audited too,
  in `Subscription` / `AuditLog`.
- Webhooks: verify signature and timestamp, store by provider
  `event_id` with a unique constraint, process idempotently.
  Replays return the stored result.

## Entitlements and quotas

- Entitlements are versioned: subscriptions point to a
  `plan_version_id`. Changing a plan creates a new version.
- Quotas are enforced atomically in the database (single
  conditional update / locked counter row), never check-then-act
  in application code alone.

## Audit

Append-only `AuditLog` for status changes, approvals, payments,
refunds, stock adjustments, permission changes, subscription
changes, and branding/reseller changes. No update/delete path.

## Threat tests — planned, not passed

Phase 1 tests were planned, not passed. The following must be
run by the parent before any production claim:

- Cross-tenant IDOR (order, customer, invoice, part, file, report)
- Client tenant spoof (ignored)
- Branch escalation
- RLS bypass (app role, no tenant set → no rows)
- Composite FK bypass
- Webhook replay and forgery
- Quota bypass under concurrency
- Money race (double payment / double refund)
- Inventory race (last unit, two orders)
- Refresh-token reuse
- File access across tenants
