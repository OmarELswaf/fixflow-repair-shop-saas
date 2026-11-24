-- Phase 5 inventory: repair part lines and the stock idempotency ledger.
-- Apply as migration owner, not app role.
-- branch_stock already carries CHECK (qtyOnHand >= 0), CHECK
-- (reservedQty >= 0) (0001) and CHECK (reservedQty <= qtyOnHand)
-- (0003); they are NOT duplicated here.
CREATE TYPE "RepairPartStatus" AS ENUM ('reserved', 'consumed', 'released');
CREATE TABLE "repair_parts" (
  "id" TEXT PRIMARY KEY,
  "tenantId" TEXT NOT NULL,
  "orderId" TEXT NOT NULL,
  "partId" TEXT NOT NULL,
  "branchId" TEXT NOT NULL,
  "qty" INTEGER NOT NULL CHECK ("qty" > 0),
  "status" "RepairPartStatus" NOT NULL DEFAULT 'reserved',
  "createdAt" TIMESTAMPTZ NOT NULL DEFAULT now(),
  "updatedAt" TIMESTAMPTZ NOT NULL DEFAULT now(),
  FOREIGN KEY ("tenantId", "orderId") REFERENCES "repair_orders"("tenantId", "id"),
  FOREIGN KEY ("tenantId", "partId") REFERENCES "parts"("tenantId", "id"),
  FOREIGN KEY ("tenantId", "branchId") REFERENCES "branches"("tenantId", "id")
);
CREATE INDEX "repair_parts_order_idx" ON "repair_parts" ("tenantId", "orderId", "createdAt", "id");
-- At most one active (reserved) line per (tenant, order, part); a
-- released/consumed line never blocks a later reservation of the
-- same part on the same order.
CREATE UNIQUE INDEX "repair_parts_active_unique" ON "repair_parts" ("tenantId", "orderId", "partId") WHERE "status" = 'reserved';
CREATE TABLE "stock_idempotency" (
  "id" TEXT PRIMARY KEY,
  "tenantId" TEXT NOT NULL,
  "scope" TEXT NOT NULL,
  "key" TEXT NOT NULL,
  "entityId" TEXT NOT NULL,
  "responseJson" JSONB NOT NULL,
  "createdAt" TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE ("tenantId", "scope", "key")
);
ALTER TABLE "repair_parts" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "stock_idempotency" ENABLE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON "repair_parts" USING ("tenantId" = current_setting('app.tenant_id', true)) WITH CHECK ("tenantId" = current_setting('app.tenant_id', true));
CREATE POLICY tenant_isolation ON "stock_idempotency" USING ("tenantId" = current_setting('app.tenant_id', true)) WITH CHECK ("tenantId" = current_setting('app.tenant_id', true));
-- The ledger is append-only, like repair_events and audit_log (0006):
-- the API offers no update/delete, and the trigger is the backstop.
CREATE TRIGGER stock_movements_append_only BEFORE UPDATE OR DELETE ON stock_movements
  FOR EACH ROW EXECUTE FUNCTION fixflow_reject_history_mutation();
