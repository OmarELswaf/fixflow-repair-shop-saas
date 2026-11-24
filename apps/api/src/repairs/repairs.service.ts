import {
  ConflictException,
  ForbiddenException,
  Injectable,
  NotFoundException,
  UnprocessableEntityException,
} from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import type { Prisma } from '../generated/prisma/client';
import { buildCursorPagination } from '../common/pagination';
import { canAccessBranch } from '../tenancy/permissions';
import type { TenantContext } from '../tenancy/tenant-context';
import { canTransition, type RepairStatusValue } from './repair-status';
import { canAssignTechnician } from './assignment';
import { releaseReservedParts } from '../inventory/stock-ops';

export class RepairNotFoundError extends Error {}

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

function event(
  tx: Prisma.TransactionClient,
  ctx: TenantContext,
  orderId: string,
  fromStatus: RepairStatusValue | null,
  toStatus: RepairStatusValue,
  note?: string,
): Promise<unknown> {
  return tx.repairEvent.create({
    data: {
      tenantId: ctx.tenantId,
      orderId,
      actorId: ctx.userId,
      fromStatus,
      toStatus,
      note: note ?? null,
    },
  });
}

/**
 * Repairs. Every write runs inside a tenant-scoped transaction (RLS),
 * writes an immutable RepairEvent where the status changes, and writes
 * an audit entry. Status changes use optimistic concurrency: the
 * caller supplies the version it saw, and the update is conditional
 * on (id, tenantId, version) — a lost update is a 409, never a
 * silent overwrite.
 */
@Injectable()
export class RepairsService {
  constructor(private readonly prisma: PrismaService) {}

  async createRepair(
    ctx: TenantContext,
    input: { customerId: string; deviceId: string; branchId: string; problemDescription: string },
  ) {
    return this.prisma.withTenant(ctx.tenantId, async (tx) => {
      const customer = await tx.customer.findFirst({
        where: { id: input.customerId, tenantId: ctx.tenantId },
        select: { id: true },
      });
      if (!customer) throw new NotFoundException('Customer not found.');
      const device = await tx.device.findFirst({
        where: { id: input.deviceId, tenantId: ctx.tenantId },
        select: { id: true, customerId: true },
      });
      if (!device) throw new NotFoundException('Device not found.');
      if (device.customerId !== input.customerId) {
        throw new UnprocessableEntityException('Device does not belong to this customer.');
      }
      if (!canAccessBranch(ctx, input.branchId)) {
        throw new ForbiddenException('Branch is outside the user scope.');
      }
      const order = await tx.repairOrder.create({
        data: {
          tenantId: ctx.tenantId,
          branchId: input.branchId,
          customerId: input.customerId,
          deviceId: input.deviceId,
          status: 'received',
          version: 0,
          problemDescription: input.problemDescription,
        },
      });
      await event(tx, ctx, order.id, null, 'received');
      await audit(tx, ctx, 'repair.create', 'repair_order', order.id, {
        branchId: input.branchId,
        customerId: input.customerId,
        deviceId: input.deviceId,
      });
      return order;
    });
  }

  async listRepairs(
    ctx: TenantContext,
    input: { status?: RepairStatusValue; branchId?: string; cursor?: string; limit?: number },
  ): Promise<{ items: unknown[]; nextCursor: string | null }> {
    if (input.branchId && !canAccessBranch(ctx, input.branchId)) {
      throw new ForbiddenException('Branch is outside the user scope.');
    }
    const page = buildCursorPagination({ cursor: input.cursor, limit: input.limit });
    const where: Prisma.RepairOrderWhereInput = {
      tenantId: ctx.tenantId,
      branchId: { in: ctx.branchIds },
      ...(ctx.role === 'technician' ? { assignedTechnicianId: ctx.userId } : {}),
    };
    if (input.status) where.status = input.status;
    if (input.branchId) where.branchId = input.branchId;
    const rows = await this.prisma.withTenant(ctx.tenantId, async (tx) =>
      tx.repairOrder.findMany({
        where,
        take: page.take,
        ...(page.cursor ? { cursor: page.cursor, skip: page.skip } : {}),
        orderBy: page.orderBy,
      }),
    );
    return { items: rows, nextCursor: rows.length === page.take ? rows[rows.length - 1].id : null };
  }

  private async loadOrder(ctx: TenantContext, id: string) {
    const order = await this.prisma.withTenant(ctx.tenantId, async (tx) =>
      tx.repairOrder.findFirst({ where: { id, tenantId: ctx.tenantId } }),
    );
    // Cross-tenant lookups are 404 by design: no tenant existence leak.
    if (!order) throw new NotFoundException('Repair not found.');
    if (
      !canAccessBranch(ctx, order.branchId) ||
      (ctx.role === 'technician' && order.assignedTechnicianId !== ctx.userId)
    ) {
      throw new NotFoundException('Repair not found.');
    }
    return order;
  }

  async getRepair(ctx: TenantContext, id: string) {
    const order = await this.loadOrder(ctx, id);
    // Sequential awaits: queries inside one interactive transaction share
    // a single connection and must not run concurrently.
    const detail = await this.prisma.withTenant(ctx.tenantId, async (tx) => {
      const customer = await tx.customer.findFirst({
        where: { id: order.customerId, tenantId: ctx.tenantId },
        select: { id: true, name: true, phone: true },
      });
      const device = await tx.device.findFirst({
        where: { id: order.deviceId, tenantId: ctx.tenantId },
        select: { id: true, brand: true, model: true, serial: true, customerId: true },
      });
      const branch = await tx.branch.findFirst({
        where: { id: order.branchId, tenantId: ctx.tenantId },
        select: { id: true, name: true },
      });
      const events = await tx.repairEvent.findMany({
        where: { orderId: order.id, tenantId: ctx.tenantId },
        orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
      });
      const technician = order.assignedTechnicianId
        ? await tx.user.findUnique({
            where: { id: order.assignedTechnicianId },
            select: { id: true, name: true, email: true },
          })
        : null;
      return { customer, device, branch, events, technician };
    });
    const { customer, device, branch, events, technician } = detail;
    return { ...order, customer, device, branch, events, assignedTechnician: technician ?? null };
  }

  /**
   * Technicians scoped to one branch of this tenant — the assignment
   * picker. Only roles with repair:assign reach here (guard); the
   * branch must be in the caller's scope.
   */
  async listTechnicians(ctx: TenantContext, branchId: string) {
    if (!canAccessBranch(ctx, branchId)) {
      throw new ForbiddenException('Branch is outside the user scope.');
    }
    const memberships = await this.prisma.withTenant(ctx.tenantId, async (tx) =>
      tx.membership.findMany({ where: { tenantId: ctx.tenantId, role: 'technician' } }),
    );
    const scoped = memberships.filter((m) => m.branchIds.includes(branchId));
    if (scoped.length === 0) return [];
    return this.prisma.withTenant(ctx.tenantId, async (tx) =>
      tx.user.findMany({
        where: { id: { in: scoped.map((m) => m.userId) } },
        select: { id: true, name: true, email: true },
        orderBy: { email: 'asc' },
      }),
    );
  }

  async assignTechnician(ctx: TenantContext, id: string, technicianUserId: string) {
    const order = await this.loadOrder(ctx, id);
    if (!canAccessBranch(ctx, order.branchId)) {
      throw new ForbiddenException('Branch is outside the user scope.');
    }
    const memberships = await this.prisma.withTenant(ctx.tenantId, async (tx) =>
      tx.membership.findMany({ where: { userId: technicianUserId, tenantId: ctx.tenantId } }),
    );
    if (!canAssignTechnician(memberships, ctx.tenantId, order.branchId)) {
      throw new UnprocessableEntityException(
        'Assignee must be a technician of this tenant scoped to the order branch.',
      );
    }
    return this.prisma.withTenant(ctx.tenantId, async (tx) => {
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${ctx.tenantId + ':' + order.id}, 0))`;
      const updated = await tx.repairOrder.update({
        where: { id: order.id, tenantId: ctx.tenantId },
        data: { assignedTechnicianId: technicianUserId, version: { increment: 1 } },
      });
      await audit(tx, ctx, 'repair.assign', 'repair_order', order.id, {
        assignedTechnicianId: technicianUserId,
        branchId: order.branchId,
      });
      return updated;
    });
  }

  async transitionRepair(
    ctx: TenantContext,
    id: string,
    input: { toStatus: RepairStatusValue; expectedVersion: number; note?: string },
  ) {
    const order = await this.loadOrder(ctx, id);
    if (!canAccessBranch(ctx, order.branchId)) {
      throw new ForbiddenException('Branch is outside the user scope.');
    }
    // Technicians may only move work assigned to them; managers, admins
    // and owners may move any in-scope order. Other roles never reach
    // here: they lack the repair:transition permission (guard).
    if (ctx.role === 'technician' && order.assignedTechnicianId !== ctx.userId) {
      throw new ForbiddenException('Technicians may only transition their own assigned repairs.');
    }
    if (input.expectedVersion !== order.version) {
      throw new ConflictException(
        `Stale version: expected ${input.expectedVersion}, current is ${order.version}.`,
      );
    }
    if (!canTransition(order.status as RepairStatusValue, input.toStatus)) {
      throw new UnprocessableEntityException(
        `Cannot transition from ${order.status} to ${input.toStatus}.`,
      );
    }
    return this.prisma.withTenant(ctx.tenantId, async (tx) => {
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${ctx.tenantId + ':' + order.id}, 0))`;
      // Conditional update: exactly one row only if the version still
      // matches. A concurrent transition wins; the loser gets a 409.
      const updated = await tx.repairOrder.updateMany({
        where: {
          id: order.id,
          tenantId: ctx.tenantId,
          version: input.expectedVersion,
          ...(ctx.role === 'technician' ? { assignedTechnicianId: ctx.userId } : {}),
        },
        data: { status: input.toStatus, version: { increment: 1 } },
      });
      if (updated.count !== 1) {
        throw new ConflictException('Repair was modified concurrently; reload and retry.');
      }
      await event(tx, ctx, order.id, order.status as RepairStatusValue, input.toStatus, input.note);
      await audit(tx, ctx, 'repair.transition', 'repair_order', order.id, {
        fromStatus: order.status,
        toStatus: input.toStatus,
        version: input.expectedVersion + 1,
      });
      // Cancelling or marking unrepairable frees every still-reserved
      // part in the SAME transaction: stock back, ledger row, lines
      // released. A transition that fails rolls the release back too.
      if (input.toStatus === 'cancelled' || input.toStatus === 'unrepairable') {
        const released = await releaseReservedParts(tx, ctx, order.id);
        await audit(tx, ctx, 'repair.part-auto-release', 'repair_order', order.id, {
          toStatus: input.toStatus,
          releasedLineIds: released,
        });
      }
      const fresh = await tx.repairOrder.findUnique({ where: { id: order.id } });
      if (!fresh) throw new NotFoundException('Repair not found.');
      return fresh;
    });
  }

  async getReceipt(ctx: TenantContext, id: string) {
    const detail = await this.getRepair(ctx, id);
    const tenant = await this.prisma.withTenant(ctx.tenantId, async (tx) =>
      tx.tenant.findUnique({ where: { id: ctx.tenantId }, select: { id: true, name: true } }),
    );
    return {
      order: {
        id: detail.id,
        status: detail.status,
        version: detail.version,
        problemDescription: detail.problemDescription,
        createdAt: detail.createdAt,
        assignedTechnician: detail.assignedTechnician,
      },
      customer: detail.customer,
      device: detail.device,
      branch: detail.branch,
      tenant: tenant ? { id: tenant.id, name: tenant.name } : { id: ctx.tenantId, name: '' },
      events: detail.events,
      issuedAt: new Date().toISOString(),
    };
  }
}
