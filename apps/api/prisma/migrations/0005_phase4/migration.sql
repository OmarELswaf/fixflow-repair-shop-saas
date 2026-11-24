-- FixFlow Phase 4 — 0005_phase4
-- New membership roles (receptionist, accountant), new repair statuses
-- (quality_check, unrepairable), repair assignment + optimistic
-- concurrency version + problem description, event notes, and a
-- tenant/status index for repair lists. Applied with
-- `prisma migrate deploy` as the OWNER role. Never applied by the app role.

ALTER TYPE "MembershipRole" ADD VALUE IF NOT EXISTS 'receptionist';
ALTER TYPE "MembershipRole" ADD VALUE IF NOT EXISTS 'accountant';
ALTER TYPE "RepairStatus" ADD VALUE IF NOT EXISTS 'quality_check';
ALTER TYPE "RepairStatus" ADD VALUE IF NOT EXISTS 'unrepairable';

ALTER TABLE "repair_orders" ADD COLUMN "assignedTechnicianId" TEXT REFERENCES "users"("id");
ALTER TABLE "repair_orders" ADD COLUMN "version" INTEGER NOT NULL DEFAULT 0;
ALTER TABLE "repair_orders" ADD COLUMN "problemDescription" TEXT;
ALTER TABLE "repair_events" ADD COLUMN "note" TEXT;

CREATE INDEX "repair_orders_tenant_status_created_idx"
  ON "repair_orders" ("tenantId", "status", "createdAt" DESC, "id" DESC);
