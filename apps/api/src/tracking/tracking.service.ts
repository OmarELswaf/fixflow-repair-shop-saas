import { createHash, randomBytes } from 'node:crypto';
import { Injectable, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import type { Prisma } from '../generated/prisma/client';
import { canAccessBranch } from '../tenancy/permissions';
import type { TenantContext } from '../tenancy/tenant-context';

export const TRACKING_TOKEN_PATTERN = /^[A-Za-z0-9_-]{32}$/;
export const DEFAULT_TRACKING_DAYS = 30;

export function newTrackingToken(): string {
  return randomBytes(24).toString('base64url'); // 192 bits, 32 chars
}
export function hashTrackingToken(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

export interface PublicTracking {
  shop: { name: string };
  device: { brand: string; model: string };
  status: string;
  expectedReadyAt: Date | null;
  updatedAt: Date;
  timeline: { status: string; at: Date }[];
}

@Injectable()
export class TrackingService {
  constructor(private readonly prisma: PrismaService) {}

  /** Staff: create (and rotate) the tracking link for one repair. The raw token is returned once. */
  async createLink(ctx: TenantContext, orderId: string, days = DEFAULT_TRACKING_DAYS) {
    const token = newTrackingToken();
    const expiresAt = new Date(Date.now() + days * 86_400_000);
    await this.prisma.withTenant(ctx.tenantId, async (tx) => {
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
      await tx.repairTrackingLink.updateMany({
        where: { tenantId: ctx.tenantId, orderId, revokedAt: null },
        data: { revokedAt: new Date() },
      });
      const link = await tx.repairTrackingLink.create({
        data: {
          tenantId: ctx.tenantId,
          orderId,
          tokenHash: hashTrackingToken(token),
          expiresAt,
          createdById: ctx.userId,
        },
      });
      await tx.auditLog.create({
        data: {
          tenantId: ctx.tenantId,
          actorId: ctx.userId,
          action: 'repair.tracking_link.create',
          entity: 'repair_order',
          entityId: orderId,
          after: { linkId: link.id, expiresAt: expiresAt.toISOString() } as Prisma.InputJsonValue,
        },
      });
    });
    return { token, path: `/t/${token}`, expiresAt };
  }

  /** Staff: revoke every active link of a repair. */
  async revokeLinks(ctx: TenantContext, orderId: string) {
    return this.prisma.withTenant(ctx.tenantId, async (tx) => {
      const order = await tx.repairOrder.findFirst({
        where: { id: orderId, tenantId: ctx.tenantId },
        select: { branchId: true, assignedTechnicianId: true },
      });
      if (
        !order ||
        !canAccessBranch(ctx, order.branchId) ||
        (ctx.role === 'technician' && order.assignedTechnicianId !== ctx.userId)
      ) {
        throw new NotFoundException('Repair not found.');
      }
      const r = await tx.repairTrackingLink.updateMany({
        where: { tenantId: ctx.tenantId, orderId, revokedAt: null },
        data: { revokedAt: new Date() },
      });
      await tx.auditLog.create({
        data: {
          tenantId: ctx.tenantId,
          actorId: ctx.userId,
          action: 'repair.tracking_link.revoke',
          entity: 'repair_order',
          entityId: orderId,
          after: { revoked: r.count } as Prisma.InputJsonValue,
        },
      });
      return { revoked: r.count };
    });
  }

  /**
   * Public: resolve a token. Unknown, malformed, revoked and expired are
   * all the same 404. Returns a minimal projection built field by field:
   * no customer name or phone, no staff, no notes, no prices.
   */
  async lookup(token: string): Promise<PublicTracking> {
    if (!TRACKING_TOKEN_PATTERN.test(token)) throw new NotFoundException('Link not found.');
    const hash = hashTrackingToken(token);
    const link = await this.prisma.$transaction(async (tx: Prisma.TransactionClient) => {
      await tx.$queryRaw`SELECT set_config('app.track_hash', ${hash}, true)`;
      return tx.repairTrackingLink.findFirst({
        where: { tokenHash: hash, revokedAt: null, expiresAt: { gt: new Date() } },
        select: { tenantId: true, orderId: true },
      });
    });
    if (!link) throw new NotFoundException('Link not found.');
    const result = await this.prisma.withTenant(link.tenantId, async (tx) => {
      const order = await tx.repairOrder.findFirst({
        where: { id: link.orderId, tenantId: link.tenantId },
        select: {
          status: true,
          expectedReadyAt: true,
          updatedAt: true,
          device: { select: { brand: true, model: true } },
        },
      });
      if (!order) return null;
      const events = await tx.repairEvent.findMany({
        where: { tenantId: link.tenantId, orderId: link.orderId },
        orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
        select: { toStatus: true, createdAt: true },
        take: 100,
      });
      const tenant = await tx.tenant.findUnique({
        where: { id: link.tenantId },
        select: { name: true },
      });
      return { order, events, tenant };
    });
    if (!result) throw new NotFoundException('Link not found.');
    return {
      shop: { name: result.tenant?.name ?? '' },
      device: { brand: result.order.device.brand, model: result.order.device.model },
      status: result.order.status,
      expectedReadyAt: result.order.expectedReadyAt,
      updatedAt: result.order.updatedAt,
      timeline: result.events.map((e) => ({ status: e.toStatus, at: e.createdAt })),
    };
  }
}
