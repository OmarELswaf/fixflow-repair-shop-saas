-- Estimate approval by customer link + shop policy. Additive only.
ALTER TABLE "repair_approvals" ADD COLUMN "tokenHash" TEXT;
ALTER TABLE "repair_approvals" ADD COLUMN "expiresAt" TIMESTAMPTZ;
ALTER TABLE "repair_approvals" ADD COLUMN "decidedAt" TIMESTAMPTZ;
ALTER TABLE "repair_approvals" ADD COLUMN "description" TEXT;
CREATE UNIQUE INDEX "repair_approvals_tokenHash_key" ON "repair_approvals" ("tokenHash");

ALTER TABLE "tenants" ADD COLUMN "requireEstimateApproval" BOOLEAN NOT NULL DEFAULT false;

-- Public customer access: only the row whose token hash equals the
-- transaction-local setting; the decision can only move pending -> decided.
CREATE POLICY approval_token_read ON "repair_approvals"
  FOR SELECT USING ("tokenHash" = NULLIF(current_setting('app.approval_hash', true), ''));
CREATE POLICY approval_token_decide ON "repair_approvals"
  FOR UPDATE
  USING ("tokenHash" = NULLIF(current_setting('app.approval_hash', true), '') AND "status" = 'pending')
  WITH CHECK ("tokenHash" = NULLIF(current_setting('app.approval_hash', true), ''));
