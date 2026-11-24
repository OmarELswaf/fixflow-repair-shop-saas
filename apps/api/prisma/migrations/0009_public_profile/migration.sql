-- Phase 10: per-tenant public profile (landing page).
-- Apply as migration owner, not app role.
--
-- The profile is OWNER-CONFIGURED ONLY. Nothing is copied from private
-- operational data and nothing is backfilled: no profile row exists
-- until the owner creates one via PUT /api/tenants/me/public-profile.
-- All content columns are nullable; only tenantId, slug and published
-- are always set. services/contact/hours are JSONB validated by the
-- API (zod) on write and re-validated on the public read path; the
-- database stores them as-is.
--
-- RLS: tenant_isolation covers every owner operation (the settings
-- endpoints run inside withTenant). public_published_read is a narrow
-- SELECT-only policy so the unauthenticated public endpoint can read
-- published profiles WITHOUT a tenant context. Unpublished rows are
-- invisible without a tenant context (default-deny): neither policy
-- passes for them. Published rows of other tenants are visible to an
-- owner query only through the published policy, and the settings
-- endpoints always filter by their own tenantId in server code, so
-- they can never read or write another tenant's profile.
-- Slug uniqueness is enforced by the database unique index: RLS can
-- hide another tenant's unpublished slug from the service, so the
-- service must NOT rely on a pre-check — a duplicate slug surfaces
-- as a unique violation (P2002) mapped to 409.
CREATE TABLE "tenant_public_profiles" (
  "tenantId" TEXT NOT NULL,
  "slug" TEXT NOT NULL,
  "published" BOOLEAN NOT NULL DEFAULT FALSE,
  "displayName" TEXT,
  "description" TEXT,
  "logoUrl" TEXT,
  "theme" TEXT NOT NULL DEFAULT 'green',
  "services" JSONB,
  "contact" JSONB,
  "hours" JSONB,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "tenant_public_profiles_pkey" PRIMARY KEY ("tenantId"),
  CONSTRAINT "tenant_public_profiles_tenant_fk" FOREIGN KEY ("tenantId") REFERENCES "tenants"("id"),
  CONSTRAINT "tenant_public_profiles_slug_unique" UNIQUE ("slug"),
  CONSTRAINT "tenant_public_profiles_theme_check" CHECK ("theme" IN ('green', 'gold', 'teal', 'slate'))
);

ALTER TABLE "tenant_public_profiles" ENABLE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON "tenant_public_profiles"
  USING ("tenantId" = current_setting('app.tenant_id', true))
  WITH CHECK ("tenantId" = current_setting('app.tenant_id', true));
CREATE POLICY public_published_read ON "tenant_public_profiles"
  FOR SELECT USING ("published" = true);
