import { randomUUID } from 'node:crypto';
import { Injectable } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import type { Prisma } from '../generated/prisma/client';
import type {
  AuthDb,
  MembershipDetail,
  MembershipInfo,
  RefreshSessionRecord,
  RefreshSessionStore,
  RegisteredOwner,
  UserRecord,
} from './ports';

/**
 * Prisma implementations of the auth ports. This file imports the
 * generated Prisma client (type-only) and PrismaService, so unit tests
 * never import it — they use fakes of the ports instead.
 */

@Injectable()
export class PrismaAuthDb implements AuthDb {
  constructor(private readonly prisma: PrismaService) {}

  async findUserByEmail(email: string): Promise<UserRecord | null> {
    const user = await this.prisma.user.findUnique({ where: { email } });
    return user
      ? { id: user.id, email: user.email, name: user.name, passwordHash: user.passwordHash }
      : null;
  }

  async findUserById(userId: string): Promise<UserRecord | null> {
    const user = await this.prisma.user.findUnique({ where: { id: userId } });
    return user
      ? { id: user.id, email: user.email, name: user.name, passwordHash: user.passwordHash }
      : null;
  }

  async registerOwner(input: {
    email: string;
    passwordHash: string;
    name?: string;
    tenantName: string;
    branchName: string;
  }): Promise<RegisteredOwner> {
    // Generate the tenant id client-side so it can be set as the RLS
    // tenant context BEFORE inserting tenant-scoped rows (branches,
    // memberships, audit_log are RLS-enabled; the tenant row itself is
    // a platform table and is not RLS-enabled).
    const tenantId = randomUUID();
    const branchId = randomUUID();
    const userId = randomUUID();
    const result = await this.prisma.$transaction(async (tx: Prisma.TransactionClient) => {
      await tx.$queryRaw`SELECT set_config('app.tenant_id', ${tenantId}, true)`;
      const user = await tx.user.create({
        data: {
          id: userId,
          email: input.email,
          passwordHash: input.passwordHash,
          name: input.name ?? null,
        },
      });
      const tenant = await tx.tenant.create({ data: { id: tenantId, name: input.tenantName } });
      const branch = await tx.branch.create({
        data: { id: branchId, tenantId: tenant.id, name: input.branchName },
      });
      await tx.membership.create({
        data: { userId: user.id, tenantId: tenant.id, role: 'owner', branchIds: [branch.id] },
      });
      await tx.auditLog.create({
        data: {
          tenantId: tenant.id,
          actorId: user.id,
          action: 'auth.register',
          entity: 'tenant',
          entityId: tenant.id,
          after: { tenantName: input.tenantName, branchName: input.branchName },
        },
      });
      return { user, tenant, branch };
    });
    return {
      user: {
        id: result.user.id,
        email: result.user.email,
        name: result.user.name,
        passwordHash: result.user.passwordHash,
      },
      tenant: { id: result.tenant.id, name: result.tenant.name },
      branch: { id: result.branch.id, name: result.branch.name },
    };
  }

  async listMemberships(userId: string): Promise<MembershipInfo[]> {
    // Transaction-local authenticated user context limits bootstrap reads.
    // Migration 0004 replaces the broad no-tenant bootstrap policy.
    const rows = await this.prisma.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT set_config('app.auth_user_id', ${userId}, true)`;
      return tx.membership.findMany({ where: { userId } });
    });
    return rows.map((m) => ({ tenantId: m.tenantId, branchIds: m.branchIds, role: m.role }));
  }

  async listMembershipDetails(userId: string): Promise<MembershipDetail[]> {
    const memberships = await this.listMemberships(userId);
    if (memberships.length === 0) return [];
    const tenantIds = [...new Set(memberships.map((m) => m.tenantId))];
    // Tenants are a platform table (no RLS): names are safe to read here.
    const tenants = await this.prisma.tenant.findMany({
      where: { id: { in: tenantIds } },
      select: { id: true, name: true },
    });
    const branchesByTenant = new Map<string, Array<{ id: string; name: string }>>();
    for (const tenantId of tenantIds) {
      const branches = await this.prisma.withTenant(tenantId, async (tx) =>
        tx.branch.findMany({ select: { id: true, name: true } }),
      );
      branchesByTenant.set(tenantId, branches);
    }
    return memberships.map((m) => ({
      ...m,
      tenantName: tenants.find((t) => t.id === m.tenantId)?.name ?? null,
      branches: (branchesByTenant.get(m.tenantId) ?? []).filter((b) => m.branchIds.includes(b.id)),
    }));
  }

  async createAuditLog(input: {
    tenantId: string;
    actorId: string;
    action: string;
    entity: string;
    entityId: string;
    after?: unknown;
  }): Promise<void> {
    await this.prisma.withTenant(input.tenantId, async (tx: Prisma.TransactionClient) => {
      await tx.auditLog.create({
        data: {
          tenantId: input.tenantId,
          actorId: input.actorId,
          action: input.action,
          entity: input.entity,
          entityId: input.entityId,
          after: input.after === undefined ? undefined : (input.after as Prisma.InputJsonValue),
        },
      });
    });
  }
}

@Injectable()
export class PrismaRefreshSessionStore implements RefreshSessionStore {
  constructor(private readonly prisma: PrismaService) {}

  async rotateAtomic(
    session: RefreshSessionRecord,
    tokenHash: string,
    now: Date,
    expiresAt: Date,
  ): Promise<{ status: 'ok'; session: RefreshSessionRecord } | { status: 'reuse' | 'invalid' }> {
    return this.prisma.withTenant(session.tenantId, async (tx) => {
      // Serialize every refresh in the family, not just one token.
      await tx.$queryRaw`SELECT pg_advisory_xact_lock(hashtextextended(${session.familyId}, 0))::text`;
      const current = await tx.refreshSession.findUnique({ where: { id: session.id } });
      if (!current || current.expiresAt <= now) return { status: 'invalid' as const };
      if (current.revokedAt || current.replacedById) {
        await tx.refreshSession.updateMany({
          where: { userId: current.userId, familyId: current.familyId, revokedAt: null },
          data: { revokedAt: now },
        });
        return { status: 'reuse' as const };
      }
      const created = await tx.refreshSession.create({
        data: {
          userId: current.userId,
          tenantId: current.tenantId,
          familyId: current.familyId,
          tokenHash,
          expiresAt,
        },
      });
      await tx.refreshSession.update({
        where: { id: current.id },
        data: { revokedAt: now, replacedById: created.id, lastUsedAt: now },
      });
      return { status: 'ok' as const, session: toRecord(created) };
    });
  }

  async create(input: {
    userId: string;
    tenantId: string;
    tokenHash: string;
    familyId: string;
    expiresAt: Date;
  }): Promise<RefreshSessionRecord> {
    const row = await this.prisma.withTenant(input.tenantId, async (tx: Prisma.TransactionClient) =>
      tx.refreshSession.create({ data: input }),
    );
    return toRecord(row);
  }

  async findByTokenHash(tokenHash: string): Promise<RefreshSessionRecord | null> {
    // Only this exact token hash is visible during the bootstrap read.
    const row = await this.prisma.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT set_config('app.refresh_hash', ${tokenHash}, true)`;
      return tx.refreshSession.findUnique({ where: { tokenHash } });
    });
    return row ? toRecord(row) : null;
  }

  async revoke(id: string, replacedById: string | null = null): Promise<void> {
    const session = await this.prisma.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT set_config('app.refresh_id', ${id}, true)`;
      return tx.refreshSession.findUnique({ where: { id } });
    });
    if (!session) return;
    await this.prisma.withTenant(session.tenantId, async (tx: Prisma.TransactionClient) => {
      await tx.refreshSession.update({
        where: { id },
        data: { revokedAt: new Date(), replacedById, lastUsedAt: new Date() },
      });
    });
  }

  async revokeFamily(userId: string, familyId: string): Promise<void> {
    const rows = await this.sessionsForUser(userId);
    const tenantIds = [...new Set(rows.map((r) => r.tenantId))];
    for (const tenantId of tenantIds) {
      await this.prisma.withTenant(tenantId, async (tx: Prisma.TransactionClient) => {
        await tx.$queryRaw`SELECT pg_advisory_xact_lock(hashtextextended(${familyId}, 0))::text`;
        await tx.refreshSession.updateMany({
          where: { userId, familyId, revokedAt: null },
          data: { revokedAt: new Date() },
        });
      });
    }
  }

  private async sessionsForUser(userId: string) {
    return this.prisma.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT set_config('app.auth_user_id', ${userId}, true)`;
      return tx.refreshSession.findMany({ where: { userId } });
    });
  }

  async revokeAllForUser(userId: string): Promise<void> {
    const rows = await this.sessionsForUser(userId);
    for (const familyId of [...new Set(rows.map((r) => r.familyId))]) {
      await this.revokeFamily(userId, familyId);
    }
  }
}

function toRecord(row: {
  id: string;
  userId: string;
  tenantId: string;
  tokenHash: string;
  familyId: string;
  expiresAt: Date;
  revokedAt: Date | null;
  replacedById: string | null;
  lastUsedAt: Date | null;
}): RefreshSessionRecord {
  return {
    id: row.id,
    userId: row.userId,
    tenantId: row.tenantId,
    tokenHash: row.tokenHash,
    familyId: row.familyId,
    expiresAt: row.expiresAt,
    revokedAt: row.revokedAt,
    replacedById: row.replacedById,
    lastUsedAt: row.lastUsedAt,
  };
}
