import { ConflictException, Injectable, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { Prisma } from '../generated/prisma/client';
import type { TenantContext } from '../tenancy/tenant-context';
import {
  PublicProfileContactSchema,
  PublicProfileHoursSchema,
  PublicProfileServicesSchema,
  type UpsertPublicProfileInput,
} from './dto';

/** Prisma unique-violation code (P2002), without importing the client. */
function isUniqueViolation(error: unknown): boolean {
  return (
    typeof error === 'object' && error !== null && (error as { code?: unknown }).code === 'P2002'
  );
}

function audit(
  tx: Prisma.TransactionClient,
  ctx: TenantContext,
  action: string,
  entity: string,
  entityId: string,
  after: Record<string, unknown>,
): Promise<unknown> {
  return tx.auditLog.create({
    data: {
      tenantId: ctx.tenantId,
      actorId: ctx.userId,
      action,
      entity,
      entityId,
      after: after as Prisma.InputJsonValue,
    },
  });
}

/**
 * The eight fields the public endpoint may ever return. Nothing else
 * — no tenantId, no timestamps, no private data — leaves the server
 * through the public projection. The shape is built field by field;
 * the row is never spread.
 */
export interface PublicShopResponse {
  slug: string;
  displayName: string | null;
  description: string | null;
  logoUrl: string | null;
  theme: string;
  services: unknown;
  contact: unknown;
  hours: unknown;
}

export interface PublicProfileSettingsResponse extends PublicShopResponse {
  published: boolean;
  updatedAt: Date;
}

/**
 * Stored JSON columns are validated on write, but the public read
 * path re-validates them anyway: if a row was ever written outside
 * the API (a bad manual edit, a future bug), malformed content is
 * dropped to null instead of being served to strangers.
 */
function safeJson<T>(
  schema: { safeParse: (v: unknown) => { success: boolean; data?: T } },
  value: unknown,
): T | null {
  if (value === null || value === undefined) return null;
  const parsed = schema.safeParse(value);
  return parsed.success ? (parsed.data as T) : null;
}

function toPublic(row: {
  slug: string;
  displayName: string | null;
  description: string | null;
  logoUrl: string | null;
  theme: string;
  services: unknown;
  contact: unknown;
  hours: unknown;
}): PublicShopResponse {
  return {
    slug: row.slug,
    displayName: row.displayName,
    description: row.description,
    logoUrl: row.logoUrl,
    theme: row.theme,
    services: safeJson(PublicProfileServicesSchema, row.services),
    contact: safeJson(PublicProfileContactSchema, row.contact),
    hours: safeJson(PublicProfileHoursSchema, row.hours),
  };
}

/**
 * Per-tenant public profile (landing page).
 *
 * - Owner settings run inside withTenant: the settings endpoints can
 *   only ever read or write the caller's own tenant. Slug uniqueness
 *   is enforced by the database unique index, not by a service
 *   pre-check: RLS can hide another tenant's unpublished slug, so a
 *   duplicate surfaces as P2002 and is mapped to 409.
 * - The public read runs WITHOUT a tenant context and relies on the
 *   `public_published_read` RLS policy (published rows only) plus the
 *   explicit projection below. It never returns private data: the
 *   projection is an allow-list, and this service never queries
 *   customers, repairs, staff or inventory for the public endpoint.
 */
@Injectable()
export class PublicProfileService {
  constructor(private readonly prisma: PrismaService) {}

  async getOwnProfile(ctx: TenantContext): Promise<PublicProfileSettingsResponse> {
    const row = await this.prisma.withTenant(ctx.tenantId, (tx) =>
      tx.tenantPublicProfile.findUnique({ where: { tenantId: ctx.tenantId } }),
    );
    if (!row) throw new NotFoundException('No public profile has been set up for this shop.');
    return { ...toPublic(row), published: row.published, updatedAt: row.updatedAt };
  }

  async upsertOwnProfile(
    ctx: TenantContext,
    input: UpsertPublicProfileInput,
  ): Promise<PublicProfileSettingsResponse> {
    // PUT is a full replace: omitted optional fields are cleared.
    const data = {
      slug: input.slug,
      published: input.published ?? false,
      displayName: input.displayName ?? null,
      description: input.description ?? null,
      logoUrl: input.logoUrl ?? null,
      theme: input.theme ?? 'green',
      services: (input.services ?? Prisma.DbNull) as Prisma.InputJsonValue,
      contact: (input.contact ?? Prisma.DbNull) as Prisma.InputJsonValue,
      hours: (input.hours ?? Prisma.DbNull) as Prisma.InputJsonValue,
    };
    const row = await this.prisma.withTenant(ctx.tenantId, async (tx) => {
      let saved;
      try {
        saved = await tx.tenantPublicProfile.upsert({
          where: { tenantId: ctx.tenantId },
          create: { tenantId: ctx.tenantId, ...data },
          update: data,
        });
      } catch (error) {
        if (isUniqueViolation(error)) {
          throw new ConflictException('This public address is already taken.');
        }
        throw error;
      }
      await audit(tx, ctx, 'public-profile.upsert', 'tenant_public_profile', ctx.tenantId, {
        slug: data.slug,
        published: data.published,
      });
      return saved;
    });
    return { ...toPublic(row), published: row.published, updatedAt: row.updatedAt };
  }

  async getPublicShop(slug: string): Promise<PublicShopResponse> {
    // No tenant context on purpose: the public endpoint must read a
    // published profile without knowing the tenant first. The RLS
    // public_published_read policy is what makes this safe — without
    // it, no row is visible at all.
    const row = await this.prisma.tenantPublicProfile.findFirst({
      where: { slug, published: true },
      select: {
        slug: true,
        displayName: true,
        description: true,
        logoUrl: true,
        theme: true,
        services: true,
        contact: true,
        hours: true,
      },
    });
    if (!row) throw new NotFoundException('Shop page not found.');
    return toPublic(row);
  }
}
