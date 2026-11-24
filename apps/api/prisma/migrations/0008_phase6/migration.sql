-- Phase 6: stock movement traceability and quantity ceilings.
-- Apply as migration owner, not app role.
-- Trace columns are NULL for pre-0008 movements: no backfill is
-- attempted, because the repair/line/operation references did not
-- exist when those rows were written. RLS is already enabled on
-- stock_movements (0007 created the table; see 0002 for the
-- tenant_isolation policy), so no new policy is needed here.
ALTER TABLE "stock_movements"
  ADD COLUMN "repairOrderId" TEXT,
  ADD COLUMN "repairPartId" TEXT,
  ADD COLUMN "operationKey" TEXT,
  ADD COLUMN "actorId" TEXT;

-- The (tenantId, repairPartId) FK needs a matching unique key on
-- repair_parts: unlike repair_orders and parts, it never had
-- @@unique([tenantId, id]) (migration 0007). Add it here.
ALTER TABLE "repair_parts"
  ADD CONSTRAINT "repair_parts_tenant_id_unique" UNIQUE ("tenantId", "id");

ALTER TABLE "stock_movements"
  ADD CONSTRAINT "stock_movements_order_fk"
    FOREIGN KEY ("tenantId", "repairOrderId") REFERENCES "repair_orders"("tenantId", "id"),
  ADD CONSTRAINT "stock_movements_line_fk"
    FOREIGN KEY ("tenantId", "repairPartId") REFERENCES "repair_parts"("tenantId", "id"),
  ADD CONSTRAINT "stock_movements_actor_fk"
    FOREIGN KEY ("actorId") REFERENCES "users"("id");

CREATE INDEX "stock_movements_order_idx" ON "stock_movements" ("tenantId", "repairOrderId", "createdAt" DESC, "id" DESC);
CREATE INDEX "stock_movements_operation_idx" ON "stock_movements" ("tenantId", "operationKey", "createdAt" DESC, "id" DESC);
CREATE INDEX "stock_movements_actor_idx" ON "stock_movements" ("tenantId", "actorId", "createdAt" DESC, "id" DESC);

-- Quantity ceilings. int4 tops out at 2147483647; the 1,000,000,000
-- ceiling leaves headroom for one max-size increment without
-- overflowing, and the pure helpers (inventory.ts) enforce the same
-- bound before the write. Named so a violation names the rule.
ALTER TABLE "branch_stock"
  ADD CONSTRAINT "branch_stock_qty_ceiling" CHECK ("qtyOnHand" <= 1000000000),
  ADD CONSTRAINT "branch_stock_reserved_ceiling" CHECK ("reservedQty" <= 1000000000);
ALTER TABLE "repair_parts"
  ADD CONSTRAINT "repair_parts_qty_ceiling" CHECK ("qty" <= 1000000000);
ALTER TABLE "stock_movements"
  ADD CONSTRAINT "stock_movements_qty_ceiling" CHECK ("qty" >= -1000000000 AND "qty" <= 1000000000);
