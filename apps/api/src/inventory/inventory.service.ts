import {
  BadRequestException,
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
import {
  applyStockChange,
  availableQty,
  claimIdempotency,
  findIdempotency,
  idempotencyResponse,
  isUniqueViolation,
  matchesIdempotencyRequest,
  recordMovement,
} from './stock-ops';

export interface PartResponse {
  id: string;
  sku: string;
  name: string;
  createdAt: Date;
}

export interface StockRowResponse {
  partId: string;
  partSku: string;
  partName: string;
  branchId: string;
  branchName: string;
  qtyOnHand: number;
  reservedQty: number;
  available: number;
}

export interface RepairPartResponse {
  id: string;
  orderId: string;
  partId: string;
  partSku: string;
  partName: string;
  qty: number;
  status: string;
  createdAt: Date;
}

/** Branch id -> name, scoped to this tenant. */
async function branchNames(
  tx: Prisma.TransactionClient,
  tenantId: string,
  branchIds: string[],
): Promise<Map<string, string>> {
  if (branchIds.length === 0) return new Map();
  const rows = await tx.branch.findMany({
    where: { tenantId, id: { in: [...new Set(branchIds)] } },
    select: { id: true, name: true },
  });
  return new Map(rows.map((b) => [b.id, b.name]));
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
 * Parts catalog, branch stock, and repair-part reservation.
 * Every write runs inside a tenant-scoped transaction (RLS) and writes
 * an audit entry. Stock changes are conditional (see stock-ops.ts):
 * a lost update is a 422/409, never a silent overwrite or negative
 * stock. Reserve/release/consume are idempotent per (tenant, scope,
 * key): a replay returns the stored response, and a key reused with
 * a different body is a 409. Parts carry no price: pricing is out of
 * scope for Phase 5.
 */
@Injectable()
export class InventoryService {
  constructor(private readonly prisma: PrismaService) {}

  async listParts(
    ctx: TenantContext,
    input: { search?: string; cursor?: string; limit?: number },
  ): Promise<{ items: PartResponse[]; nextCursor: string | null }> {
    const page = buildCursorPagination({ cursor: input.cursor, limit: input.limit });
    const where: Prisma.PartWhereInput = { tenantId: ctx.tenantId };
    if (input.search) {
      const q = input.search;
      where.OR = [
        { sku: { contains: q, mode: 'insensitive' } },
        { name: { contains: q, mode: 'insensitive' } },
      ];
    }
    const rows = await this.prisma.withTenant(ctx.tenantId, async (tx) =>
      tx.part.findMany({
        where,
        take: page.take,
        ...(page.cursor ? { cursor: page.cursor, skip: page.skip } : {}),
        orderBy: page.orderBy,
        select: { id: true, sku: true, name: true, createdAt: true },
      }),
    );
    return { items: rows, nextCursor: rows.length === page.take ? rows[rows.length - 1].id : null };
  }

  async createPart(
    ctx: TenantContext,
    input: { sku: string; name: string },
  ): Promise<PartResponse> {
    return this.prisma.withTenant(ctx.tenantId, async (tx) => {
      let part: PartResponse;
      try {
        part = await tx.part.create({
          data: { tenantId: ctx.tenantId, sku: input.sku, name: input.name },
          select: { id: true, sku: true, name: true, createdAt: true },
        });
      } catch (error) {
        if (isUniqueViolation(error)) {
          throw new ConflictException('A part with this SKU already exists.');
        }
        throw error;
      }
      await audit(tx, ctx, 'part.create', 'part', part.id, { sku: input.sku, name: input.name });
      return part;
    });
  }

  async getPart(ctx: TenantContext, id: string) {
    return this.prisma.withTenant(ctx.tenantId, async (tx) => {
      const part = await tx.part.findFirst({
        where: { id, tenantId: ctx.tenantId },
        select: { id: true, sku: true, name: true, createdAt: true },
      });
      // Cross-tenant lookups are 404 by design: no tenant existence leak.
      if (!part) throw new NotFoundException('Part not found.');
      const stocks = await tx.branchStock.findMany({
        where: { tenantId: ctx.tenantId, partId: id, branchId: { in: ctx.branchIds } },
        orderBy: [{ branchId: 'asc' }],
      });
      const names = await branchNames(
        tx,
        ctx.tenantId,
        stocks.map((s) => s.branchId),
      );
      return {
        ...part,
        stock: stocks.map((s) => ({
          branchId: s.branchId,
          branchName: names.get(s.branchId) ?? '',
          qtyOnHand: s.qtyOnHand,
          reservedQty: s.reservedQty,
          available: availableQty(s),
        })),
      };
    });
  }

  async listStock(
    ctx: TenantContext,
    input: { branchId?: string; partId?: string; cursor?: string; limit?: number },
  ): Promise<{
    items: StockRowResponse[];
    nextCursor: string | null;
  }> {
    if (input.branchId && !canAccessBranch(ctx, input.branchId)) {
      throw new ForbiddenException('Branch is outside the user scope.');
    }
    const take = Math.min(Math.max(input.limit ?? 20, 1), 100);
    let cursorFilter: Prisma.BranchStockWhereInput = {};
    if (input.cursor) {
      const [cursorBranch, cursorPart] = input.cursor.split(':');
      if (!cursorBranch || !cursorPart) {
        throw new BadRequestException('Invalid cursor.');
      }
      cursorFilter = {
        OR: [
          { branchId: { gt: cursorBranch } },
          { branchId: cursorBranch, partId: { gt: cursorPart } },
        ],
      };
    }
    const rows = await this.prisma.withTenant(ctx.tenantId, async (tx) =>
      tx.branchStock.findMany({
        where: {
          tenantId: ctx.tenantId,
          branchId: input.branchId ?? { in: ctx.branchIds },
          ...(input.partId ? { partId: input.partId } : {}),
          ...cursorFilter,
        },
        orderBy: [{ branchId: 'asc' }, { partId: 'asc' }],
        take: take + 1,
        include: {
          part: { select: { sku: true, name: true } },
          branch: { select: { name: true } },
        },
      }),
    );
    const page = rows.slice(0, take);
    return {
      items: page.map((r) => ({
        partId: r.partId,
        partSku: r.part.sku,
        partName: r.part.name,
        branchId: r.branchId,
        branchName: r.branch.name,
        qtyOnHand: r.qtyOnHand,
        reservedQty: r.reservedQty,
        available: availableQty(r),
      })),
      nextCursor:
        rows.length > take
          ? `${page[page.length - 1].branchId}:${page[page.length - 1].partId}`
          : null,
    };
  }

  async adjustStock(
    ctx: TenantContext,
    input: {
      branchId: string;
      partId: string;
      delta: number;
      reason?: string;
      idempotencyKey: string;
    },
  ): Promise<StockRowResponse> {
    const request = {
      branchId: input.branchId,
      partId: input.partId,
      delta: input.delta,
      reason: input.reason ?? null,
    };
    try {
      return await this.prisma.withTenant(ctx.tenantId, (tx) =>
        this.adjustStockTx(ctx, input, request, tx),
      );
    } catch (error) {
      if (isUniqueViolation(error)) {
        const replayed = await this.replayIdempotency<StockRowResponse>(
          ctx,
          'stock-adjust',
          input.idempotencyKey,
          request,
        );
        if (replayed) return replayed;
      }
      throw error;
    }
  }

  private async adjustStockTx(
    ctx: TenantContext,
    input: {
      branchId: string;
      partId: string;
      delta: number;
      reason?: string;
      idempotencyKey: string;
    },
    request: Record<string, unknown>,
    tx: Prisma.TransactionClient,
  ): Promise<StockRowResponse> {
    if (!canAccessBranch(ctx, input.branchId)) {
      throw new ForbiddenException('Branch is outside the user scope.');
    }
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${ctx.tenantId + ':stock-adjust:' + input.idempotencyKey}, 0))`;
    const stored = await findIdempotency(tx, ctx.tenantId, 'stock-adjust', input.idempotencyKey);
    if (stored) return this.replayStored<StockRowResponse>(stored, request);
    const part = await tx.part.findFirst({
      where: { id: input.partId, tenantId: ctx.tenantId },
      select: { id: true, sku: true, name: true },
    });
    if (!part) throw new NotFoundException('Part not found.');
    const names = await branchNames(tx, ctx.tenantId, [input.branchId]);
    await tx.branchStock.upsert({
      where: {
        tenantId_branchId_partId: {
          tenantId: ctx.tenantId,
          branchId: input.branchId,
          partId: input.partId,
        },
      },
      create: {
        tenantId: ctx.tenantId,
        branchId: input.branchId,
        partId: input.partId,
        qtyOnHand: 0,
        reservedQty: 0,
      },
      update: {},
    });
    const stock = await applyStockChange(tx, ctx.tenantId, input.branchId, input.partId, {
      reservedDelta: 0,
      onHandDelta: input.delta,
    });
    await recordMovement(tx, ctx.tenantId, input.branchId, input.partId, input.delta, 'adjust', {
      operationKey: input.idempotencyKey,
      actorId: ctx.userId,
    });
    const response: StockRowResponse = {
      partId: input.partId,
      partSku: part.sku,
      partName: part.name,
      branchId: input.branchId,
      branchName: names.get(input.branchId) ?? '',
      qtyOnHand: stock.qtyOnHand,
      reservedQty: stock.reservedQty,
      available: availableQty(stock),
    };
    await claimIdempotency(
      tx,
      ctx.tenantId,
      'stock-adjust',
      input.idempotencyKey,
      `${input.branchId}:${input.partId}`,
      {
        request,
        response,
      },
    );
    await audit(tx, ctx, 'stock.adjust', 'branch_stock', `${input.branchId}:${input.partId}`, {
      branchId: input.branchId,
      partId: input.partId,
      delta: input.delta,
      reason: input.reason ?? null,
    });
    return response;
  }

  async listMovements(
    ctx: TenantContext,
    input: {
      branchId?: string;
      partId?: string;
      operationKey?: string;
      cursor?: string;
      limit?: number;
    },
  ) {
    if (input.branchId && !canAccessBranch(ctx, input.branchId)) {
      throw new ForbiddenException('Branch is outside the user scope.');
    }
    const page = buildCursorPagination({ cursor: input.cursor, limit: input.limit });
    const rows = await this.prisma.withTenant(ctx.tenantId, async (tx) =>
      tx.stockMovement.findMany({
        where: {
          tenantId: ctx.tenantId,
          branchId: input.branchId ?? { in: ctx.branchIds },
          ...(input.partId ? { partId: input.partId } : {}),
          // Tenant-scoped exact match; combines with the branch
          // filter above when both are present.
          ...(input.operationKey ? { operationKey: input.operationKey } : {}),
        },
        take: page.take,
        ...(page.cursor ? { cursor: page.cursor, skip: page.skip } : {}),
        orderBy: page.orderBy,
      }),
    );
    // StockMovement carries no relation: resolve part names in one query.
    const partIds = [...new Set(rows.map((r) => r.partId))];
    const parts = partIds.length
      ? await this.prisma.withTenant(ctx.tenantId, (tx) =>
          tx.part.findMany({
            where: { tenantId: ctx.tenantId, id: { in: partIds } },
            select: { id: true, sku: true, name: true },
          }),
        )
      : [];
    const byId = new Map(parts.map((p) => [p.id, { sku: p.sku, name: p.name }]));
    const names = await this.prisma.withTenant(ctx.tenantId, (tx) =>
      branchNames(
        tx,
        ctx.tenantId,
        rows.map((r) => r.branchId),
      ),
    );
    // Actors are global users: resolve display names in one query.
    // A deleted actor leaves actorName null; the id is still shown.
    const actorIds = [...new Set(rows.map((r) => r.actorId).filter((a): a is string => !!a))];
    const actors = actorIds.length
      ? await this.prisma.withTenant(ctx.tenantId, (tx) =>
          tx.user.findMany({
            where: { id: { in: actorIds } },
            select: { id: true, name: true },
          }),
        )
      : [];
    const actorById = new Map(actors.map((u) => [u.id, u.name ?? null]));
    return {
      items: rows.map((r) => ({
        id: r.id,
        partId: r.partId,
        partSku: byId.get(r.partId)?.sku ?? '',
        partName: byId.get(r.partId)?.name ?? '',
        branchId: r.branchId,
        branchName: names.get(r.branchId) ?? '',
        qty: r.qty,
        reason: r.reason,
        repairOrderId: r.repairOrderId,
        repairPartId: r.repairPartId,
        operationKey: r.operationKey,
        actorId: r.actorId,
        actorName: r.actorId ? (actorById.get(r.actorId) ?? null) : null,
        createdAt: r.createdAt,
      })),
      nextCursor: rows.length === page.take ? rows[rows.length - 1].id : null,
    };
  }

  /**
   * Load an order with the same scoping as RepairsService.loadOrder:
   * cross-tenant and out-of-branch reads are 404, and (when
   * technicianRule is set) technicians only see their assigned work.
   * Duplicated here on purpose: importing RepairsService would be a
   * circular dependency between the two modules.
   */
  private async loadOrderTx(
    tx: Prisma.TransactionClient,
    ctx: TenantContext,
    id: string,
    technicianRule: boolean,
  ) {
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${ctx.tenantId + ':' + id}, 0))`;
    const order = await tx.repairOrder.findFirst({ where: { id, tenantId: ctx.tenantId } });
    if (!order) throw new NotFoundException('Repair not found.');
    if (
      !canAccessBranch(ctx, order.branchId) ||
      (technicianRule && ctx.role === 'technician' && order.assignedTechnicianId !== ctx.userId)
    ) {
      throw new NotFoundException('Repair not found.');
    }
    return order;
  }

  private replayStored<T>(stored: { responseJson: unknown }, request: Record<string, unknown>): T {
    if (!matchesIdempotencyRequest(stored.responseJson, request)) {
      throw new ConflictException('Idempotency key was already used with a different request.');
    }
    const response = idempotencyResponse<T>(stored.responseJson);
    if (!response) {
      throw new ConflictException('Idempotency key was already used with a different request.');
    }
    return response;
  }

  private async replayIdempotency<T>(
    ctx: TenantContext,
    scope: string,
    key: string,
    request: Record<string, unknown>,
  ): Promise<T | null> {
    if (typeof request.branchId === 'string' && !canAccessBranch(ctx, request.branchId)) {
      throw new ForbiddenException('Branch is outside the user scope.');
    }
    if (typeof request.orderId === 'string') {
      await this.prisma.withTenant(ctx.tenantId, (tx) =>
        this.loadOrderTx(tx, ctx, request.orderId as string, true),
      );
    }
    const stored = await this.prisma.withTenant(ctx.tenantId, (tx) =>
      findIdempotency(tx, ctx.tenantId, scope, key),
    );
    if (!stored) return null;
    return this.replayStored<T>(stored, request);
  }

  async listRepairParts(ctx: TenantContext, orderId: string): Promise<RepairPartResponse[]> {
    const order = await this.prisma.withTenant(ctx.tenantId, (tx) =>
      this.loadOrderTx(tx, ctx, orderId, true),
    );
    const lines = await this.prisma.withTenant(ctx.tenantId, (tx) =>
      tx.repairPart.findMany({
        where: { tenantId: ctx.tenantId, orderId: order.id },
        orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
        include: { part: { select: { sku: true, name: true } } },
      }),
    );
    return lines.map((l) => ({
      id: l.id,
      orderId: l.orderId,
      partId: l.partId,
      partSku: l.part.sku,
      partName: l.part.name,
      qty: l.qty,
      status: l.status,
      createdAt: l.createdAt,
    }));
  }

  async reservePart(
    ctx: TenantContext,
    orderId: string,
    input: { partId: string; qty: number; idempotencyKey: string },
  ): Promise<RepairPartResponse> {
    const request = { orderId, partId: input.partId, qty: input.qty };
    try {
      return await this.prisma.withTenant(ctx.tenantId, (tx) =>
        this.reservePartTx(ctx, orderId, input, request, tx),
      );
    } catch (error) {
      if (isUniqueViolation(error)) {
        const replayed = await this.replayIdempotency<RepairPartResponse>(
          ctx,
          'repair-part-reserve',
          input.idempotencyKey,
          request,
        );
        if (replayed) return replayed;
      }
      throw error;
    }
  }

  private async reservePartTx(
    ctx: TenantContext,
    orderId: string,
    input: { partId: string; qty: number; idempotencyKey: string },
    request: Record<string, unknown>,
    tx: Prisma.TransactionClient,
  ): Promise<RepairPartResponse> {
    const order = await this.loadOrderTx(tx, ctx, orderId, true);
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${ctx.tenantId + ':repair-part-reserve:' + input.idempotencyKey}, 0))`;
    const stored = await findIdempotency(
      tx,
      ctx.tenantId,
      'repair-part-reserve',
      input.idempotencyKey,
    );
    if (stored) return this.replayStored<RepairPartResponse>(stored, request);
    if (
      order.status === 'delivered' ||
      order.status === 'cancelled' ||
      order.status === 'unrepairable'
    ) {
      throw new UnprocessableEntityException(`Cannot reserve parts for a ${order.status} repair.`);
    }
    const part = await tx.part.findFirst({
      where: { id: input.partId, tenantId: ctx.tenantId },
      select: { id: true, sku: true, name: true },
    });
    if (!part) throw new NotFoundException('Part not found.');
    await applyStockChange(tx, ctx.tenantId, order.branchId, input.partId, {
      reservedDelta: input.qty,
      onHandDelta: 0,
    });
    // Merge into the active reserved line, or create it. A concurrent
    // reservation can win the partial unique index; merge once, then.
    // The line is created before the ledger row so the movement can
    // trace to it directly.
    const existing = await tx.repairPart.findFirst({
      where: {
        tenantId: ctx.tenantId,
        orderId: order.id,
        partId: input.partId,
        status: 'reserved',
      },
    });
    let line: { id: string; qty: number; status: string; createdAt: Date };
    if (existing) {
      const updated = await tx.repairPart.updateMany({
        where: { id: existing.id, tenantId: ctx.tenantId, status: 'reserved' },
        data: { qty: { increment: input.qty } },
      });
      if (updated.count !== 1) {
        throw new ConflictException('Repair part was modified concurrently; reload and retry.');
      }
      line = { ...existing, qty: existing.qty + input.qty };
    } else {
      line = await tx.repairPart.create({
        data: {
          tenantId: ctx.tenantId,
          orderId: order.id,
          partId: input.partId,
          branchId: order.branchId,
          qty: input.qty,
          status: 'reserved',
        },
      });
    }
    await recordMovement(tx, ctx.tenantId, order.branchId, input.partId, input.qty, 'reserve', {
      repairOrderId: order.id,
      repairPartId: line.id,
      operationKey: input.idempotencyKey,
      actorId: ctx.userId,
    });
    const response: RepairPartResponse = {
      id: line.id,
      orderId: order.id,
      partId: input.partId,
      partSku: part.sku,
      partName: part.name,
      qty: line.qty,
      status: line.status,
      createdAt: line.createdAt,
    };
    await claimIdempotency(tx, ctx.tenantId, 'repair-part-reserve', input.idempotencyKey, line.id, {
      request,
      response,
    });
    await audit(tx, ctx, 'repair-part.reserve', 'repair_part', line.id, {
      orderId: order.id,
      partId: input.partId,
      qty: input.qty,
      branchId: order.branchId,
    });
    return response;
  }

  async releasePart(
    ctx: TenantContext,
    orderId: string,
    lineId: string,
    input: { idempotencyKey: string },
  ): Promise<RepairPartResponse> {
    return this.processPartLine(ctx, orderId, lineId, input, 'release');
  }

  async consumePart(
    ctx: TenantContext,
    orderId: string,
    lineId: string,
    input: { idempotencyKey: string },
  ): Promise<RepairPartResponse> {
    return this.processPartLine(ctx, orderId, lineId, input, 'consume');
  }

  private async processPartLine(
    ctx: TenantContext,
    orderId: string,
    lineId: string,
    input: { idempotencyKey: string },
    kind: 'release' | 'consume',
  ): Promise<RepairPartResponse> {
    const scope = kind === 'release' ? 'repair-part-release' : 'repair-part-consume';
    const request = { orderId, lineId };
    try {
      return await this.prisma.withTenant(ctx.tenantId, (tx) =>
        this.processPartLineTx(ctx, orderId, lineId, input, request, kind, tx),
      );
    } catch (error) {
      if (isUniqueViolation(error)) {
        const replayed = await this.replayIdempotency<RepairPartResponse>(
          ctx,
          scope,
          input.idempotencyKey,
          request,
        );
        if (replayed) return replayed;
      }
      throw error;
    }
  }

  private async processPartLineTx(
    ctx: TenantContext,
    orderId: string,
    lineId: string,
    input: { idempotencyKey: string },
    request: Record<string, unknown>,
    kind: 'release' | 'consume',
    tx: Prisma.TransactionClient,
  ): Promise<RepairPartResponse> {
    const scope = kind === 'release' ? 'repair-part-release' : 'repair-part-consume';
    const order = await this.loadOrderTx(tx, ctx, orderId, true);
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${ctx.tenantId + ':' + scope + ':' + input.idempotencyKey}, 0))`;
    const stored = await findIdempotency(tx, ctx.tenantId, scope, input.idempotencyKey);
    if (stored) return this.replayStored<RepairPartResponse>(stored, request);
    if (kind === 'consume' && ['cancelled', 'unrepairable', 'delivered'].includes(order.status)) {
      throw new UnprocessableEntityException('Cannot consume parts on a terminal repair.');
    }
    const line = await tx.repairPart.findFirst({
      where: { id: lineId, orderId: order.id, tenantId: ctx.tenantId },
    });
    if (!line) throw new NotFoundException('Repair part not found.');
    if (line.status !== 'reserved') {
      throw new ConflictException('Repair part was already processed.');
    }
    const deltas =
      kind === 'release'
        ? { reservedDelta: -line.qty, onHandDelta: 0 }
        : { reservedDelta: -line.qty, onHandDelta: -line.qty };
    await applyStockChange(tx, ctx.tenantId, line.branchId, line.partId, deltas);
    await recordMovement(tx, ctx.tenantId, line.branchId, line.partId, -line.qty, kind, {
      repairOrderId: order.id,
      repairPartId: line.id,
      operationKey: input.idempotencyKey,
      actorId: ctx.userId,
    });
    const updated = await tx.repairPart.updateMany({
      where: { id: line.id, tenantId: ctx.tenantId, status: 'reserved' },
      data: { status: kind === 'release' ? 'released' : 'consumed' },
    });
    if (updated.count !== 1) {
      throw new ConflictException('Repair part was modified concurrently; reload and retry.');
    }
    const part = await tx.part.findFirst({
      where: { id: line.partId, tenantId: ctx.tenantId },
      select: { sku: true, name: true },
    });
    const response: RepairPartResponse = {
      id: line.id,
      orderId: order.id,
      partId: line.partId,
      partSku: part ? part.sku : '',
      partName: part ? part.name : '',
      qty: line.qty,
      status: kind === 'release' ? 'released' : 'consumed',
      createdAt: line.createdAt,
    };
    await claimIdempotency(tx, ctx.tenantId, scope, input.idempotencyKey, line.id, {
      request,
      response,
    });
    await audit(
      tx,
      ctx,
      kind === 'release' ? 'repair-part.release' : 'repair-part.consume',
      'repair_part',
      line.id,
      {
        orderId: order.id,
        partId: line.partId,
        qty: line.qty,
        branchId: line.branchId,
      },
    );
    return response;
  }
}
