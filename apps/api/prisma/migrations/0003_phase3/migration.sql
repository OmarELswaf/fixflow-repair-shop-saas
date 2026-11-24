-- FixFlow Phase 3 — 0003_phase3
-- Auth tables, tenant-aware FKs that 0001 missed, and the inventory CHECK.
-- Applied with `prisma migrate deploy` as the OWNER role (see
-- apps/api/scripts/migrate-and-start.sh). Never applied by the app role.

-- Users: name + email verification timestamp (verification DELIVERY is
-- not implemented in Phase 3; emailVerifiedAt stays NULL — see docs/AUTH.md).
ALTER TABLE "users" ADD COLUMN "name" TEXT;
ALTER TABLE "users" ADD COLUMN "emailVerifiedAt" TIMESTAMPTZ;

-- Refresh sessions (rotating refresh tokens; only sha256 hashes stored).
-- The (tenantId, userId) FK needs a matching unique on memberships,
-- added below, so a session can only exist for a real membership.
ALTER TABLE "memberships"
  ADD CONSTRAINT "memberships_tenantId_userId_key" UNIQUE ("tenantId", "userId");
CREATE TABLE "refresh_sessions" (
  "id" TEXT PRIMARY KEY,
  "userId" TEXT NOT NULL,
  "tenantId" TEXT NOT NULL,
  "tokenHash" TEXT NOT NULL UNIQUE,
  "familyId" TEXT NOT NULL,
  "expiresAt" TIMESTAMPTZ NOT NULL,
  "revokedAt" TIMESTAMPTZ,
  "replacedById" TEXT,
  "lastUsedAt" TIMESTAMPTZ,
  "createdAt" TIMESTAMPTZ NOT NULL DEFAULT now(),
  FOREIGN KEY ("userId") REFERENCES "users"("id"),
  FOREIGN KEY ("tenantId") REFERENCES "tenants"("id"),
  FOREIGN KEY ("tenantId", "userId") REFERENCES "memberships"("tenantId", "userId")
);
CREATE INDEX "refresh_sessions_user_family_idx" ON "refresh_sessions" ("userId", "familyId");
CREATE INDEX "refresh_sessions_tenant_user_idx" ON "refresh_sessions" ("tenantId", "userId");

-- Roles need a composite unique so role_permissions can reference
-- (tenantId, roleId) as a composite foreign key.
ALTER TABLE "roles" ADD CONSTRAINT "roles_tenantId_id_key" UNIQUE ("tenantId", "id");

-- role_permissions was created in 0001 without a tenant column.
-- Backfill tenantId from the role, then make it part of the key.
ALTER TABLE "role_permissions" ADD COLUMN "tenantId" TEXT;
UPDATE "role_permissions" rp
  SET "tenantId" = r."tenantId"
  FROM "roles" r
  WHERE r."id" = rp."roleId";
ALTER TABLE "role_permissions" ALTER COLUMN "tenantId" SET NOT NULL;
ALTER TABLE "role_permissions" DROP CONSTRAINT "role_permissions_pkey";
ALTER TABLE "role_permissions" ADD PRIMARY KEY ("tenantId", "roleId", "permissionId");
ALTER TABLE "role_permissions"
  ADD CONSTRAINT "role_permissions_tenant_role_fk"
  FOREIGN KEY ("tenantId", "roleId") REFERENCES "roles"("tenantId", "id");

-- reseller_tenants was created in 0001 without a tenant FK.
ALTER TABLE "reseller_tenants"
  ADD CONSTRAINT "reseller_tenants_tenant_fk"
  FOREIGN KEY ("tenantId") REFERENCES "tenants"("id");

-- purchase_orders was created in 0001 without a branch FK.
ALTER TABLE "purchase_orders"
  ADD CONSTRAINT "purchase_orders_tenant_branch_fk"
  FOREIGN KEY ("tenantId", "branchId") REFERENCES "branches"("tenantId", "id");

-- purchase_order_lines was created in 0001 without a part FK.
ALTER TABLE "purchase_order_lines"
  ADD CONSTRAINT "purchase_order_lines_tenant_part_fk"
  FOREIGN KEY ("tenantId", "partId") REFERENCES "parts"("tenantId", "id");

-- webhook_events was created in 0001 without a tenant FK.
ALTER TABLE "webhook_events"
  ADD CONSTRAINT "webhook_events_tenant_fk"
  FOREIGN KEY ("tenantId") REFERENCES "tenants"("id");

-- Inventory: reserved quantity can never exceed quantity on hand.
-- reserveStock() in src/inventory/inventory.ts enforces the same rule
-- in application code; the CHECK is the database backstop.
ALTER TABLE "branch_stock"
  ADD CONSTRAINT "branch_stock_reserved_le_onhand"
  CHECK ("reservedQty" <= "qtyOnHand");

-- RLS for the tables 0002 did not cover. role_permissions and
-- reseller_tenants are tenant-scoped; refresh_sessions is tenant-scoped
-- (a session belongs to one tenant). users stays global (no RLS):
-- login looks a user up by email before any tenant is known, and the
-- app role is a trusted server role, not a tenant user.
ALTER TABLE "role_permissions" ENABLE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON "role_permissions"
  USING ("tenantId" = current_setting('app.tenant_id', true))
  WITH CHECK ("tenantId" = current_setting('app.tenant_id', true));
ALTER TABLE "reseller_tenants" ENABLE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON "reseller_tenants"
  USING ("tenantId" = current_setting('app.tenant_id', true))
  WITH CHECK ("tenantId" = current_setting('app.tenant_id', true));
ALTER TABLE "refresh_sessions" ENABLE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON "refresh_sessions"
  USING ("tenantId" = current_setting('app.tenant_id', true))
  WITH CHECK ("tenantId" = current_setting('app.tenant_id', true));

-- Bootstrap SELECT policies (login / refresh only). These two lookups
-- happen BEFORE any tenant is known, so the tenant policy would deny
-- them entirely:
--   * memberships: login lists a user's memberships by userId.
--   * refresh_sessions: refresh looks a session up by its token hash
--     (a 256-bit secret — the lookup key IS the credential).
-- The exception is narrow: it permits SELECT only while NO tenant
-- context is set (current_setting(..., true) = ''), and server code
-- always filters by userId / tokenHash. It does not permit INSERT,
-- UPDATE or DELETE, and it does not apply once a tenant is set.
-- See docs/AUTH.md "Bootstrap reads".
CREATE POLICY memberships_bootstrap_select ON "memberships"
  FOR SELECT USING (current_setting('app.tenant_id', true) = '');
CREATE POLICY refresh_sessions_bootstrap_select ON "refresh_sessions"
  FOR SELECT USING (current_setting('app.tenant_id', true) = '');
