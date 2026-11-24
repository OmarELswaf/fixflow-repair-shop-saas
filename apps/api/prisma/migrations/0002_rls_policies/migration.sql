-- FixFlow Phase 2 — 0002_rls_policies
-- Enable RLS on all tenant tables and add tenant-isolation policies.
-- A missing policy on an RLS-enabled table is default-deny, not a leak.
-- Disabled RLS or a BYPASSRLS / owner role can leak. The app role must
-- be a non-owner role without BYPASSRLS (see docs/db/app-role.sql).
-- The tenant is set per transaction via a parameterized
-- SELECT set_config('app.tenant_id', $1, true) on the same connection.
-- Tenants, users, plans and plan_versions are platform tables and are
-- intentionally not RLS-enabled here; access to them is via server code.

DO $$
DECLARE t text;
BEGIN
  FOR t IN SELECT unnest(ARRAY[
    'branches','memberships','roles','customers','devices','repair_orders',
    'repair_events','repair_approvals','parts','branch_stock',
    'stock_movements','suppliers','purchase_orders','purchase_order_lines',
    'invoices','payments','refunds','ledger_entries','subscriptions',
    'webhook_events','tenant_branding','audit_log'
  ]) LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
  END LOOP;
END $$;

-- Tenant-scoped tables with a tenantId column.
DO $$
DECLARE t text;
BEGIN
  FOR t IN SELECT unnest(ARRAY[
    'branches','memberships','roles','customers','devices','repair_orders',
    'repair_events','repair_approvals','parts','suppliers',
    'purchase_orders','invoices','payments','refunds','ledger_entries',
    'subscriptions','webhook_events','tenant_branding','audit_log'
  ]) LOOP
    EXECUTE format('CREATE POLICY tenant_isolation ON %I USING ("tenantId" = current_setting(''app.tenant_id'', true)) WITH CHECK ("tenantId" = current_setting(''app.tenant_id'', true))', t);
  END LOOP;
END $$;

-- Tables whose tenant column is named tenantId but with a composite key.
CREATE POLICY tenant_isolation ON "branch_stock" USING ("tenantId" = current_setting('app.tenant_id', true)) WITH CHECK ("tenantId" = current_setting('app.tenant_id', true));
CREATE POLICY tenant_isolation ON "stock_movements" USING ("tenantId" = current_setting('app.tenant_id', true)) WITH CHECK ("tenantId" = current_setting('app.tenant_id', true));
CREATE POLICY tenant_isolation ON "purchase_order_lines" USING ("tenantId" = current_setting('app.tenant_id', true)) WITH CHECK ("tenantId" = current_setting('app.tenant_id', true));
-- Entitlements are plan-version scoped; they carry no tenantId. No tenant
-- policy is created for them here — access is via the subscription's
-- plan version, enforced in server code. This is intentional and documented.
