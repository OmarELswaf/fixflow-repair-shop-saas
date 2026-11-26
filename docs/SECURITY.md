# Security — FixFlow Phase 2

This document describes what the code does today. Where a feature is
schema-only or not implemented, it says so plainly: nothing here may be
read as a claim about a feature that does not exist yet.

## Auth

- Short-lived JWT access tokens (900s default) + rotating refresh
  tokens. Refresh-token reuse revokes the session family (unit-tested
  in `refresh-sessions.spec.ts` and `auth.service.spec.ts`; the
  database-backed reuse path is covered by
  `scripts/test-auth-http.mjs`, which replays a rotated cookie,
  expects 401, and verifies family revocation — run in CI).
- Strong password hashing with Argon2id (memoryCost 19456, timeCost
  2, parallelism 1). Minimum password length 12. No password is
  stored in the repo; the seed hashes `DEMO_PASSWORD` from the
  environment at seed time.
- Production boot refuses placeholder secrets and requires JWT
  secrets with at least 32 bytes of entropy (43+ characters, 10+
  distinct; e.g. `openssl rand -hex 32`). Existing environment values
  are not changed by this; verify any already-deployed secret meets
  the floor before the next production boot.
- No bypass DB credentials in the app. The app connects as a
  non-owner role without `BYPASSRLS`, verified at startup
  (`PrismaService.onModuleInit` refuses to boot otherwise).
  Migrations run as a separate owner role via `migrate-and-start.sh`.
- No email verification exists in this phase — see `docs/AUTH.md`
  "Gaps". Do not present accounts as verified. Password reset exists
  (hashed single-use tokens, per-IP and per-email rate limits,
  sessions revoked after reset, uniform anti-enumeration response).

## Subscriptions, webhooks, entitlements, quotas — schema only

These are **not implemented**. The tables exist (`subscriptions`,
`webhook_events`, `plan_versions`, `entitlements`), but there are no
subscription endpoints, no webhook receiver, no state machine, and no
quota enforcement. The entitlement helpers in
`src/tenancy/entitlements.ts` have no callers and the tenant context
always carries an empty entitlement list. Any document or demo that
presents trials, plan limits, webhooks, or payment events as working
is wrong. When these are built, the intended invariants stay:

- Webhooks: verify signature and timestamp, store by provider
  `event_id` with a unique constraint, process idempotently.
- Entitlements versioned by plan version; quotas enforced atomically
  in the database, never check-then-act in application code alone.

## Audit

Append-only `AuditLog` for the mutations that exist today: repair
create/assign/transition, stock adjustments and part reserve/release/
consume, public-profile changes, tracking-link create/revoke, and
refresh-reuse detection. No update/delete path.

## Content Security Policy

The SPA document is served with `Content-Security-Policy-Report-Only`
(starting policy: `default-src 'self'`, `script-src 'self'`,
`style-src 'self' 'unsafe-inline'`, `img-src 'self' data:`,
`font-src 'self' data:`, `connect-src 'self'`, `object-src 'none'`,
`base-uri 'self'`, `form-action 'self'`, `frame-ancestors 'none'`).
Browsers report violations to `POST /api/csp-report` (log-only,
rate-limited per IP, body capped at 8 KB and truncated in logs).
Nothing is blocked in this mode. Promote to an enforcing
`Content-Security-Policy` only after the collected reports are clean
in real usage.

## Threat tests — wired and running

Every threat below ends in exactly one state: PASS (runs in CI),
PASS-WHEN-RUN (needs Docker + a local PostgreSQL 16 via
`npm run test:pg16`), or N/A (feature absent — stated why). The wired
suite is `npm run test:threats:http` (dummy data, embedded
PostgreSQL), plus the existing harnesses named below.

| Threat                                                | State         | Where                                                         |
| ----------------------------------------------------- | ------------- | ------------------------------------------------------------- |
| Cross-tenant IDOR (customer, repair, part, report)    | PASS          | `test-threats-http.mjs`                                       |
| Client tenant spoof (forged tenant header ignored)    | PASS          | `test-threats-http.mjs` (+ `tenant-context.spec.ts`)          |
| Branch escalation (read + write outside branch scope) | PASS          | `test-threats-http.mjs`                                       |
| RLS bypass (app role, no tenant set → no rows)        | PASS          | `test-threats-http.mjs`                                       |
| Composite FK bypass (cross-tenant repair_event)       | PASS          | `test-threats-http.mjs`                                       |
| Refresh-token reuse                                   | PASS          | `test-auth-http.mjs` (replay → 401, family revoked)           |
| Webhook replay and forgery                            | N/A           | no webhook endpoints exist (schema only)                      |
| Quota bypass under concurrency                        | N/A           | quotas not implemented (see above)                            |
| Money race (double payment / double refund)           | N/A           | no payments module exists                                     |
| Inventory race (last unit, two orders)                | PASS-WHEN-RUN | `test-contention.mjs` under `test:pg16` (needs Docker + PG16) |
| File access across tenants                            | N/A           | no file storage exists                                        |

No production claim may be made while any applicable row is not PASS
in a real run. The PG16-dependent row runs wherever Docker is
available; CI output prints SKIP with the reason when it is not.
