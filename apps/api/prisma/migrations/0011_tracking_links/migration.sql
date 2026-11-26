-- Customer repair tracking links + expected-ready date. Additive only.
ALTER TABLE "repair_orders" ADD COLUMN "expectedReadyAt" TIMESTAMP(3);

-- Only the sha256 hash of the link token is stored; the raw token is
-- shown once to staff when the link is created.
CREATE TABLE "repair_tracking_links" (
  "id" TEXT NOT NULL,
  "tenantId" TEXT NOT NULL,
  "orderId" TEXT NOT NULL,
  "tokenHash" TEXT NOT NULL,
  "expiresAt" TIMESTAMP(3) NOT NULL,
  "revokedAt" TIMESTAMP(3),
  "createdById" TEXT NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "repair_tracking_links_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "repair_tracking_links_order_fk" FOREIGN KEY ("tenantId", "orderId") REFERENCES "repair_orders"("tenantId", "id")
);
CREATE UNIQUE INDEX "repair_tracking_links_tokenHash_key" ON "repair_tracking_links" ("tokenHash");
CREATE INDEX "repair_tracking_links_tenantId_orderId_idx" ON "repair_tracking_links" ("tenantId", "orderId");

ALTER TABLE "repair_tracking_links" ENABLE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON "repair_tracking_links"
  USING ("tenantId" = current_setting('app.tenant_id', true))
  WITH CHECK ("tenantId" = current_setting('app.tenant_id', true));
-- Public lookup: SELECT only, and only the row whose hash equals the
-- transaction-local setting (set by the server from the presented token).
CREATE POLICY tracking_token_read ON "repair_tracking_links"
  FOR SELECT USING ("tokenHash" = NULLIF(current_setting('app.track_hash', true), ''));
