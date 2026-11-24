# Tenancy — FixFlow Phase 2

## TenantContext

`TenantContext` is built server-side from the authenticated session
only. Fields: `userId`, `tenantId`, `branchIds`, `role`, `permissions`,
`entitlements` (with plan version).

`resolveTenantContext(user, memberships)` is a pure function. It
resolves memberships from the database and IGNORES any
client-supplied `tenant_id` — there is no parameter for it, and the
unit test proves a spoofed client value is ignored.

## Rules

- No service reads `tenant_id` from a header, query, or body.
- Every service receives `TenantContext` as an argument.
- Branch authorization is separate from tenant authorization:
  `canAccessBranch(ctx, branchId)` checks `ctx.branchIds`.
  A tenant member without a branch in scope cannot read or write
  that branch's data.
- Permissions: `hasPermission(ctx, perm)` checks `ctx.permissions`.
  Permission constants live in `src/tenancy/permissions.ts`.

## Roles (Phase 4)

`ROLE_PERMISSIONS` in `src/tenancy/permissions.ts` is the live
least-privilege map (owner gets everything; admin everything
except `admin`). New in Phase 4:

- **receptionist** — `customer:read/write`, `device:read/write`,
  `repair:read/write`. Creates customers, devices and repairs,
  but has no `repair:transition` or `repair:assign`, so it cannot
  move a repair through the workflow or assign work.
- **accountant** — `report:read`, `payment:create/refund`,
  `repair:read`, `customer:read`. Reads reports and takes
  payments; cannot create or move repairs.
- **technician** — `repair:read/write/transition`, `stock:consume`,
  `inventory:read`, `customer:read`, `device:read`. May only
  transition repairs assigned to them (see below) and consume
  parts on them; cannot assign, approve, reserve or release.
- **manager** — repair read/write/assign/transition/approve,
  customer/device read/write, inventory read/write,
  `stock:reserve/release/consume`, payment create, report read.
  No payment refunds, no `admin`.
- **cashier** — `repair:read`, `payment:create/refund` only.

## Stock permissions (Phase 5)

- `stock:reserve`, `stock:release`, `stock:consume` — new in
  Phase 5. Owner gets all three (owner gets everything); admin
  and manager get all three; **technician gets `stock:consume`
  only** (plus the `inventory:read` it already had) and no
  `stock:reserve`/`stock:release`/`inventory:write`.
- Receptionist and accountant can read inventory
  (`inventory:read`) but hold no stock permissions and no
  `inventory:write`: they cannot adjust stock or reserve, release
  or consume parts.
- Cashier holds no inventory or stock permission at all.
- **Technician consume rule**: a technician may consume parts
  only on a repair assigned to them. The denial is an explicit
  403 (not the 404 that unassigned reads return), so the caller
  learns it is about assignment, not existence. See
  `docs/WORKFLOWS.md` "Inventory (Phase 5)".

## Reports and team (Phase 6)

- `report:read` — owner, admin, manager, accountant. Guards
  `GET /reports/repairs/summary`, `GET /reports/stock` and
  `GET /reports/stock/summary`. Technician, receptionist and
  cashier get 403. Reports are branch-scoped to the caller's
  `branchIds`; a `branchId` outside scope is 403.
- `admin` — owner only. Guards `GET /admin/team`. Admin,
  manager and every other role get 403: the team view is a
  read-only owner view, not a permission escalation. No role in
  the system can grant itself `admin` through the API.

## Scoped tokens and tenant switching (Phase 8)

- A scoped access token is bound to one (user, tenant): the JWT
  carries `tenantId`, and `JwtAuthGuard` re-resolves the user's
  memberships from the database on every request, rejecting a token
  whose tenant is not a membership (401). The tenant in a token
  never changes after it is issued.
- **Switching tenants** (`POST /auth/select-tenant`) issues a new
  scoped access token and a new refresh family for the selected
  tenant. The previous token keeps its original tenant: after a
  switch to tenant B, the old tenant-A token still reads tenant A
  (and gets 403 on tenant-B branch resources). Scoped tokens do
  not silently follow the switch.
- **Unscoped tokens:** a user with several memberships logs in to
  an unscoped token (`requiresTenantSelection: true`, no refresh
  token). `/me` returns both memberships and `tenantContext:
null`. Tenant resources reject it with 401 (`TenantGuard`: "No
  tenant selected for this request.").
- **Logout:** `POST /auth/logout` revokes one refresh family only;
  other families (other tenants, other devices) keep working.
  Access tokens are stateless JWTs and stay valid until their
  short expiry — logout does not (and cannot) revoke them.
  `POST /auth/logout-all` revokes every family for the user.
- **Non-members:** a user cannot select a tenant they are not a
  member of (403 on select-tenant), cannot read another tenant's
  resources (cross-tenant detail reads are 404, so existence is
  not leaked), and cannot write to a branch outside their scope
  (403).
- **Pending operations: server lookup is tenant-scoped; the
  client store is user+tenant scoped.** The `operationKey`
  movement lookup is tenant-scoped server-side: the same key
  value in two tenants returns only that tenant's movement. But
  the server cannot tell which _user_ recorded a pending key —
  the key carries no user identity, and the lookup answers for
  the caller's tenant, not for a specific user. Which user a
  pending operation belongs to is a client-side concern (the
  browser's per-operation localStorage keys include the user id,
  cleared on logout and tenant switch; see `docs/WORKFLOWS.md`).
  Do not claim server-side user scoping that does not exist. And
  there is no cross-tab mutex for pending operations: concurrent
  tabs may read the same outcome (safe — reads never replay
  writes), and two simultaneous fresh submissions are not
  serialized across tabs.
- Covered by `scripts/test-auth-http.mjs` (tenant switching,
  cross-account denial, logout families) and
  `scripts/test-reports-http.mjs` (operationKey isolation).

## Technician assignment

Assignment is branch-scoped and role-checked, not just a user id
on a row:

- `POST /repairs/:id/assign` requires `repair:assign`.
- The assignee must hold a membership in the order's tenant with
  role `technician` whose `branchIds` include the order's branch
  (pure helper `canAssignTechnician` in
  `src/repairs/assignment.ts`, unit-tested). Otherwise 422.
- Assignment writes an `AuditLog` entry (`repair.assign`) and no
  status event: assignment is not a status change.
- Transitions: a technician may only transition a repair whose
  `assignedTechnicianId` is their own user id; managers, admins
  and owners may transition any in-scope branch order. The order's
  branch must always be in the caller's branch scope (403
  otherwise). See `docs/WORKFLOWS.md`.

## RLS

See `docs/DATABASE.md`. Transaction-local:
`SELECT set_config('app.tenant_id', $1, true)` with a bound
parameter, on the same connection as the transaction, via
`PrismaService.withTenant(tenantId, fn)`. Never interpolate the
tenant id into SQL text.

## Public profile — the one exception (Phase 10)

`GET /api/public/shops/:slug` has NO tenant context on purpose: the
public landing page must be readable without knowing the tenant
first. The exception is safe only because of the layers in
`docs/PUBLIC_PROFILE.md`: `tenant_public_profiles` is RLS-enabled
with `tenant_isolation` (owner operations, inside `withTenant`) plus
a narrow `public_published_read` policy (`FOR SELECT USING
(published = true)`), so without a tenant context only published
rows are visible and unpublished rows are default-deny; the service
projects exactly eight public fields and never queries a private
table from that endpoint. No other endpoint is exempt from the
tenant-context rule — if a new public read is ever needed, it must
go through the same review: RLS policy + explicit projection +
no private-table access.

## Object storage, jobs, cache

- Storage prefixes (`tenant_id/...`) are NOT access controls.
  Access is enforced by signed, short-lived URLs and a server-side
  tenant check before issuing them.
- BullMQ job payloads carry `tenant_id`; workers re-resolve the
  tenant before acting.
- Redis keys are namespaced `tenant:{id}:...`.
