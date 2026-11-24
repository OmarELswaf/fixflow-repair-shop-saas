import { Injectable } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import type { TenantContext } from '../tenancy/tenant-context';

export interface TeamMember {
  userId: string;
  name: string | null;
  email: string;
  role: string;
  branchIds: string[];
  branchNames: string[];
}

/**
 * Read-only team view for the owner (ADMIN permission). There is no
 * invitation, no role change and no branch creation here: staff
 * memberships are fixtures created by tests/seed, and changing them
 * needs an explicit product decision. Never returns password hashes.
 */
@Injectable()
export class AdminService {
  constructor(private readonly prisma: PrismaService) {}

  async getTeam(ctx: TenantContext): Promise<{
    branches: Array<{ id: string; name: string }>;
    members: TeamMember[];
  }> {
    const branches = await this.prisma.withTenant(ctx.tenantId, (tx) =>
      tx.branch.findMany({
        where: { tenantId: ctx.tenantId },
        select: { id: true, name: true },
        orderBy: { name: 'asc' },
      }),
    );
    const memberships = await this.prisma.withTenant(ctx.tenantId, (tx) =>
      tx.membership.findMany({
        where: { tenantId: ctx.tenantId },
        orderBy: [{ role: 'asc' }, { userId: 'asc' }],
      }),
    );
    const users =
      memberships.length > 0
        ? await this.prisma.withTenant(ctx.tenantId, (tx) =>
            tx.user.findMany({
              where: { id: { in: memberships.map((m) => m.userId) } },
              select: { id: true, name: true, email: true },
            }),
          )
        : [];
    const byId = new Map(users.map((u) => [u.id, u]));
    const branchNames = new Map(branches.map((b) => [b.id, b.name]));
    return {
      branches: branches.map((b) => ({ id: b.id, name: b.name })),
      members: memberships.map((m) => {
        const user = byId.get(m.userId);
        return {
          userId: m.userId,
          name: user?.name ?? null,
          email: user?.email ?? '',
          role: m.role,
          branchIds: m.branchIds,
          branchNames: m.branchIds.map((id) => branchNames.get(id) ?? id),
        };
      }),
    };
  }
}
