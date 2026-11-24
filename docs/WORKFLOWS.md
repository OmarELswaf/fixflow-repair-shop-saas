# Workflows — FixFlow Phase 4

Customer, device and repair flows. All writes are tenant- and
branch-authorized, validated with zod (`.strict()` — unknown fields
are rejected), and audited. No fake data, no mock production data.

## Customers

- `POST /customers` (`customer:write`) — body `{ name 1..200,
phone? }`. Phone, when given, must match
  `/^[+0-9 ()-]{6,30}$/`. Creates the customer in the caller's
  tenant and writes `AuditLog customer.create`.
- `GET /customers` (`customer:read`) — query `search?` (matches
  name OR phone, case-insensitive substring), `cursor?`,
  `limit?` (1..100, default 20). Tenant-scoped cursor pagination
  (`createdAt DESC, id DESC`); response `{ items, nextCursor }`.
- `GET /customers/:id` (`customer:read`) — customer + devices +
  latest 10 repairs. A customer from another tenant is 404 (no
  tenant-existence leak).

## Devices (intake)

- `POST /customers/:id/devices` (`device:write`) — body
  `{ brand 1..100, model 1..100, serial? max 100 }`. The customer
  must exist in the caller's tenant (else 404). The device is
  created with the composite FK `(tenantId, customerId) →
customers(tenantId, id)`; writes `AuditLog device.create`.
- **No unlock passwords.** There is no password / PIN /
  unlock-code field anywhere in the device API. `.strict()` DTOs
  reject a `password` field with 400, and no such value is ever
  stored. The UI must not ask the customer for a device unlock
  password.

## Repairs

- `POST /repairs` (`repair:write`, branch-guarded) — body
  `{ customerId, deviceId, branchId, problemDescription 1..2000 }`.
  Validates: customer and device exist in the tenant (404),
  device belongs to the customer (422), branch is in the caller's
  scope (403). Creates the order (`status: received`, `version:
0`), a `RepairEvent` (`fromStatus: null → received`), and an
  `AuditLog repair.create` — all in one tenant-scoped transaction.
- `GET /repairs` (`repair:read`) — filters `status?`,
  `branchId?` (a branch outside scope → 403), cursor pagination.
- `GET /repairs/:id` (`repair:read`) — order + customer + device
  - branch + events (chronological) + assigned technician
    (`{ id, name, email }` or `null`). Cross-tenant → 404.
- `GET /repairs/:id/receipt` (`repair:read`) — `{ order, customer,
device, branch, tenant: { id, name }, events, issuedAt }` for
  the printable receipt UI.
- `POST /repairs/:id/assign` (`repair:assign`) — body
  `{ technicianUserId }`. The assignee must be a technician of
  this tenant scoped to the order's branch (else 422); the order's
  branch must be in the caller's scope (403). Sets
  `assignedTechnicianId` and writes `AuditLog repair.assign`.
  Assignment is not a status change: no `RepairEvent` is written.
- `POST /repairs/:id/transition` (`repair:transition`) — body
  `{ toStatus, expectedVersion, note? max 500 }`. See below.

## State machine

Single source of truth: `ALLOWED_TRANSITIONS` in
`src/repairs/repair-status.ts` (pure, unit-tested).

```
received → diagnosing, cancelled
diagnosing → awaiting_approval, awaiting_parts, in_repair, unrepairable, cancelled
awaiting_approval → in_repair, cancelled
awaiting_parts → in_repair, cancelled
in_repair → quality_check, unrepairable, cancelled
quality_check → ready, in_repair, unrepairable
ready → delivered
delivered, cancelled, unrepairable → (terminal)
```

An illegal transition is 422. `quality_check` is the gate before
`ready`: a repair cannot go straight from `in_repair` to `ready`,
and `ready` can only go to `delivered`. `unrepairable` is terminal
once set.

## Optimistic concurrency

Every order carries `version` (integer, starts at 0, +1 per
transition). A transition must send the `expectedVersion` the
caller saw. The update is conditional —
`updateMany WHERE id + tenantId + version = expectedVersion` —
so a concurrent transition wins and the loser gets 409
(`Stale version` / `modified concurrently`). The UI must reload
the order after a 409 and let the user retry with the fresh
version. Status, version bump, event and audit all happen in one
tenant-scoped transaction.

## History (immutable)

Every status change appends a `RepairEvent` (`fromStatus`,
`toStatus`, `actorId`, optional `note`, `createdAt`). Events are
never updated or deleted. Assignment and audit entries are
separate: assignment writes only an `AuditLog` entry.
`AuditLog` records `customer.create`, `device.create`,
`repair.create`, `repair.assign` and `repair.transition` with the
acting user and tenant.

## Inventory (Phase 5)

Parts are a tenant-wide catalog (`sku` unique per tenant, no
price — pricing is out of scope); stock lives per branch
(`branch_stock`: `qtyOnHand`, `reservedQty`, `available =
qtyOnHand − reservedQty`).

- **Adjust** (`POST /stock/adjust`, `inventory:write`): upserts the
  branch row (0/0) if missing, then moves `qtyOnHand` by a
  non-zero delta (|delta| ≤ 100000). Never below zero, never below
  what is already reserved — otherwise 422.
- **Reserve** (`POST /repairs/:id/parts`, `stock:reserve`): raises
  `reservedQty` only, on the order's branch. A second reserve of
  the same part on the same order merges into the one active line
  (qty adds up). Refused with 422 when the order is `delivered`,
  `cancelled` or `unrepairable`, or when the available stock does
  not cover the qty.
- **Release** (`.../parts/:lineId/release`, `stock:release`):
  lowers `reservedQty` only; the line becomes `released`.
- **Consume** (`.../parts/:lineId/consume`, `stock:consume`):
  lowers `qtyOnHand` and `reservedQty` once; the line becomes
  `consumed`. A technician may only consume on a repair assigned
  to them (otherwise 403).
- A line that is no longer `reserved` cannot be released or
  consumed again (409). Every operation writes one signed
  `stock_movements` row and one `AuditLog` entry
  (`repair-part.reserve/release/consume`, `stock.adjust`).
- **Auto-release**: transitioning a repair to `cancelled` or
  `unrepairable` releases every still-reserved line in the same
  transaction (stock back, ledger rows, lines `released`, one
  `repair.part-auto-release` audit entry). A failed transition
  rolls the release back too.
- **Idempotency**: every mutating call takes a required
  `idempotencyKey` (8–128 chars), scoped per
  (`tenant`, `scope`, `key`). A replay returns the stored
  response with no new writes; the same key with a different body
  is a 409. Retries are safe: re-sending a request whose first
  attempt already committed returns the original result.
- All reads are branch-scoped to the caller's `branchIds`, and
  cross-tenant part/order references are 404.

## Reports and team (Phase 6)

Read-only, branch-scoped, bounded. No report or team endpoint
writes anything.

- **Repairs summary** (`GET /reports/repairs/summary`,
  `report:read`): total count, counts by status, and aging
  buckets (`0-1d`, `2-7d`, `8-30d`, `30d+`, by repair age from
  `createdAt`, computed in SQL). Optional `status`, `branchId`,
  `from`, `to` filters (ISO dates). Branch outside the caller's
  scope is 403; the default scope is all of the caller's branches.
  Phase 7: the counts and buckets are read in one `REPEATABLE
READ` transaction and the response carries `snapshotAt` (see
  `docs/DATABASE.md` "Snapshot-consistent reports").
- **Stock reconciliation** (`GET /reports/stock`, `report:read`):
  one SQL query per page, LEFT JOIN + GROUP BY over
  `branch_stock` / `repair_parts`: per (branch, part) row —
  `qtyOnHand`, `reservedQty`, `available`, `reservedLinesTotal`
  (sum of still-`reserved` lines), `discrepancy =
reservedQty − reservedLinesTotal`, `reconciled =
discrepancy === 0`. Cursor is `branchId:partId`, limit 1..100
  (default 20).
- **Stock summary** (`GET /reports/stock/summary`, `report:read`):
  distinct parts with stock, total on hand / reserved /
  available, and `mismatchedRows` (stock rows whose `reservedQty`
  disagrees with their reserved lines).
- **Stock overview** (`GET /reports/stock/overview`,
  `report:read`, Phase 7): the summary AND one page of
  reconciliation rows in one response, read from a single
  `REPEATABLE READ` snapshot (`snapshotAt` included). Same query
  params as `GET /reports/stock` (`branchId`, `partId`, `cursor`,
  limit 1..100). The separate `/reports/stock` and
  `/reports/stock/summary` endpoints stay for compatibility. Each
  page is its own snapshot — cross-page stability is not claimed.
- **Movements by operation key** (`GET /stock/movements?operationKey=<key>`,
  `inventory:read`, Phase 7): tenant-scoped exact match on the
  movement's operation key, in the existing movements page
  envelope with the same trace fields. Combines with the branch
  filter when both are present. The key is validated like an
  idempotency key (8–128 characters; anything else is 400). It
  exists for the frontend's durable-retry reconciliation: after a
  page reload, look up whether a pending operation already landed
  instead of retrying blindly. It reveals nothing new — the same
  ledger, the same permission.

### Durable pending operations (frontend, Phase 7–8)

When a stock write's response is lost (network error / page
reload mid-flight), the frontend keeps a durable pending record
so the outcome can be checked later instead of re-submitting
blindly. A pending record holds only `operationKey`, `kind`
(`adjust` | `reserve` | `release` | `consume`), `repairOrderId`
(or null), `createdAt`, and `userId`. It never holds a token, a
request body (no qty, part id, branch id, prices, customer data),
or any other business data. Records expire after 7 days. The
frontend never auto-re-submits: reconciliation only reads the
movements ledger (`GET /stock/movements?operationKey=<key>`). An
outcome that cannot be confirmed is shown as "could not be
confirmed" — never as failed.

Phase 8 storage layout (one localStorage key per pending op):

- `fixflow-pending-op:<userId>:<tenantId>:<operationKey>` — the
  record JSON. Per-op keys mean concurrent writes from different
  tabs cannot clobber each other (each op is its own key; removal
  is a single delete).
- `fixflow-stock-changed:<tenantId>` — `{at: <timestamp>}` only,
  written by a tab that completes a stock write so other tabs
  invalidate their stock/repair queries. It contains no business
  data.

Explicit limits (Phase 8 claims were removed by the Phase 8
review and the helpers deleted in Phase 9 — do not reintroduce
them): localStorage get/set is not an atomic lock, so there is
no cross-tab mutex. Concurrent tabs may read the same operation
outcome — that is safe, because reads never replay writes. There
is NO cross-tab mutex for two simultaneous fresh submissions and
NO exactly-once user-intent claim across tabs; two tabs can each
submit a fresh write with their own idempotency key. Server
idempotency remains per operation key: the same key is applied
once, and a second submission with the same key is a replay of
the first, not a second write. Leftover
`fixflow-pending-claim:*` keys from older builds are ignored by
the runtime and by storage-event handling.

Records are user-scoped: only the current user's records are
read, reconciled, shown, or deleted. Another user's records are
never touched by another user — they stay under that user's keys
until that user logs in again or they expire. Logout clears the
current user's records across all tenants; a tenant switch
clears the current tenant's records for the current user. The
server cannot distinguish which user recorded an operation key
(the movements lookup is tenant-scoped), so this scoping is a
client-side (localStorage) concern.

Legacy records from Phase 7: the old blob key
`fixflow-pending-ops:<tenantId>` (no user id) is left untouched
and never attributed to whichever account signs in next —
ownership cannot be inferred, so those records are excluded
from new-account reads. They need separate manual recovery if
an older build was actually used.

- **Team** (`GET /admin/team`, `admin` — owner only): the
  tenant's branches and members (`userId`, name, email, role,
  `branchIds` + `branchNames`). Read-only; no invitation, no role
  change, no branch creation, no password hashes in the response.
  The UI uses it to render scopes it already has — it grants
  nothing new.

## Roles in these flows

See `docs/TENANCY.md`. In short: receptionists create customers,
devices and repairs but cannot transition or assign; technicians
transition only their own assigned repairs; managers/owners assign
and transition any in-scope order; accountants cannot create
repairs at all. All of this is enforced server-side — the UI
hiding a button is never the authorization.
