import { Injectable, NotFoundException, ConflictException } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import type { Prisma } from '../generated/prisma/client';
import { canAccessBranch } from '../tenancy/permissions';
import type { TenantContext } from '../tenancy/tenant-context';
import {
  hashTrackingToken,
  newTrackingToken,
  TRACKING_TOKEN_PATTERN,
} from '../tracking/tracking.service';

export const ESTIMATE_DAYS = 7;

export interface PublicEstimate {
  shop: { name: string };
  device: { brand: string; model: string };
  description: string | null;
  amount: string;
  status: string;
  decidedAt: Date | null;
}

@Injectable()
export class ApprovalsService {
  constructor(private readonly prisma: PrismaService) {}

  private async loadOrder(tx: Prisma.TransactionClient, ctx: TenantContext, orderId: string) {
    const order = await tx.repairOrder.findFirst({
      where: { id: orderId, tenantId: ctx.tenantId },
      select: { id: true, branchId: true, assignedTechnicianId: true },
    });
    if (
      !order ||
      !canAccessBranch(ctx, order.branchId) ||
      (ctx.role === 'technician' && order.assignedTechnicianId !== ctx.userId)
    ) {
      throw new NotFoundException('Repair not found.');
    }
    return order;
  }

  /** Staff: create an estimate; older pending estimates are superseded. Token returned once. */
  async createEstimate(
    ctx: TenantContext,
    orderId: string,
    input: { amount: number; description?: string; days?: number },
  ) {
    const token = newTrackingToken();
    const expiresAt = new Date(Date.now() + (input.days ?? ESTIMATE_DAYS) * 86_400_000);
    const row = await this.prisma.withTenant(ctx.tenantId, async (tx) => {
      await this.loadOrder(tx, ctx, orderId);
      await tx.repairApproval.updateMany({
        where: { tenantId: ctx.tenantId, orderId, type: 'estimate', status: 'pending' },
        data: { status: 'superseded', tokenHash: null },
      });
      const created = await tx.repairApproval.create({
        data: {
          tenantId: ctx.tenantId,
          orderId,
          type: 'estimate',
          amount: input.amount.toFixed(2),
          description: input.description ?? null,
          tokenHash: hashTrackingToken(token),
          expiresAt,
        },
      });
      await tx.auditLog.create({
        data: {
          tenantId: ctx.tenantId,
          actorId: ctx.userId,
          action: 'repair.estimate.create',
          entity: 'repair_order',
          entityId: orderId,
          after: {
            approvalId: created.id,
            amount: input.amount.toFixed(2),
          } as Prisma.InputJsonValue,
        },
      });
      return created;
    });
    return { id: row.id, token, path: `/a/${token}`, expiresAt, amount: input.amount.toFixed(2) };
  }

  /** Staff: list estimates of a repair (never returns tokens). */
  async listEstimates(ctx: TenantContext, orderId: string) {
    return this.prisma.withTenant(ctx.tenantId, async (tx) => {
      await this.loadOrder(tx, ctx, orderId);
      const rows = await tx.repairApproval.findMany({
        where: { tenantId: ctx.tenantId, orderId, type: 'estimate' },
        orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
        take: 50,
        select: {
          id: true,
          amount: true,
          description: true,
          status: true,
          createdAt: true,
          decidedAt: true,
          expiresAt: true,
        },
      });
      return rows.map((r) => ({ ...r, amount: r.amount?.toString() ?? null }));
    });
  }

  async getPolicy(ctx: TenantContext) {
    const t = await this.prisma.tenant.findUnique({
      where: { id: ctx.tenantId },
      select: { requireEstimateApproval: true },
    });
    return { requireEstimateApproval: t?.requireEstimateApproval ?? false };
  }

  async setPolicy(ctx: TenantContext, requireEstimateApproval: boolean) {
    await this.prisma.withTenant(ctx.tenantId, async (tx) => {
      await tx.tenant.update({ where: { id: ctx.tenantId }, data: { requireEstimateApproval } });
      await tx.auditLog.create({
        data: {
          tenantId: ctx.tenantId,
          actorId: ctx.userId,
          action: 'tenant.approval_policy.set',
          entity: 'tenant',
          entityId: ctx.tenantId,
          after: { requireEstimateApproval } as Prisma.InputJsonValue,
        },
      });
    });
    return { requireEstimateApproval };
  }

  private async findByToken(token: string) {
    if (!TRACKING_TOKEN_PATTERN.test(token)) throw new NotFoundException('Link not found.');
    const hash = hashTrackingToken(token);
    const found = await this.prisma.$transaction(async (tx: Prisma.TransactionClient) => {
      await tx.$queryRaw`SELECT set_config('app.approval_hash', ${hash}, true)`;
      return tx.repairApproval.findFirst({
        where: { tokenHash: hash, expiresAt: { gt: new Date() } },
        select: {
          id: true,
          tenantId: true,
          orderId: true,
          amount: true,
          description: true,
          status: true,
          decidedAt: true,
        },
      });
    });
    if (!found || found.status === 'superseded') throw new NotFoundException('Link not found.');
    return { found, hash };
  }

  /** Public: show the estimate. Minimal fields only. */
  async viewByToken(token: string): Promise<PublicEstimate> {
    const { found } = await this.findByToken(token);
    const extra = await this.prisma.withTenant(found.tenantId, async (tx) => {
      const order = await tx.repairOrder.findFirst({
        where: { id: found.orderId, tenantId: found.tenantId },
        select: { device: { select: { brand: true, model: true } } },
      });
      const tenant = await tx.tenant.findUnique({
        where: { id: found.tenantId },
        select: { name: true },
      });
      return { order, tenant };
    });
    if (!extra.order) throw new NotFoundException('Link not found.');
    return {
      shop: { name: extra.tenant?.name ?? '' },
      device: { brand: extra.order.device.brand, model: extra.order.device.model },
      description: found.description,
      amount: found.amount?.toString() ?? '0',
      status: found.status,
      decidedAt: found.decidedAt,
    };
  }

  /** Public: customer decision. Single use: only pending can move, atomically. */
  async decide(token: string, decision: 'approve' | 'reject') {
    const { found, hash } = await this.findByToken(token);
    const status = decision === 'approve' ? 'approved' : 'rejected';
    const decidedAt = new Date();
    const count = await this.prisma.$transaction(async (tx: Prisma.TransactionClient) => {
      await tx.$queryRaw`SELECT set_config('app.approval_hash', ${hash}, true)`;
      const r = await tx.repairApproval.updateMany({
        where: { id: found.id, tokenHash: hash, status: 'pending', expiresAt: { gt: decidedAt } },
        data: { status, decidedAt },
      });
      return r.count;
    });
    if (count !== 1) throw new ConflictException('This estimate was already answered.');
    return { status, decidedAt };
  }

  /** Used by the repair workflow gate. */
  async hasApprovedEstimate(tx: Prisma.TransactionClient, tenantId: string, orderId: string) {
    const latest = await tx.repairApproval.findFirst({
      where: { tenantId, orderId, type: 'estimate', status: { not: 'superseded' } },
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      select: { status: true },
    });
    return latest?.status === 'approved';
  }
}
