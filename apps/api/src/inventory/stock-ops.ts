import { ConflictException, UnprocessableEntityException } from '@nestjs/common';
import type { TenantContext } from '../tenancy/tenant-context';
import { consumeStock, releaseStock, reserveStock, MAX_QTY, type StockState } from './inventory';
import { idempotencyResponse, matchesIdempotencyRequest } from './idempotency-pure';

export { idempotencyResponse, matchesIdempotencyRequest } from './idempotency-pure';

/**
 * Stock operations on one tenant-scoped transaction. No Nest DI here:
 * every function takes the transaction and plain arguments, so the
 * service layer stays thin and these ops are unit-testable with a
 * fake transaction.
 *
 * Semantics (single source of truth is inventory.ts):
 * - reserve: reservedQty += qty ONLY, qtyOnHand unchanged.
 * - release: reservedQty -= qty ONLY.
 * - consume: qtyOnHand -= qty AND reservedQty -= qty, once.
 * - adjust: qtyOnHand += delta, reservedQty unchanged.
 * Every change is a conditional updateMany: the WHERE guards require
 * the post-change quantities to stay non-negative, and the database
 * CHECK (reservedQty <= qtyOnHand, migration 0003) is the backstop
 * against a concurrent reservation racing the pre-check.
 */

export interface StockRow {
  tenantId: string;
  branchId: string;
  partId: string;
  qtyOnHand: number;
  reservedQty: number;
}

export interface RepairPartRow {
  id: string;
  tenantId: string;
  orderId: string;
  partId: string;
  branchId: string;
  qty: number;
  status: string;
  createdAt: Date;
}

export interface IdempotencyRow {
  tenantId: string;
  scope: string;
  key: string;
  entityId: string;
  responseJson: unknown;
}

/** Actual generated delegate types, verified against the running Prisma client. */
export type StockTx = Pick<
  import('../generated/prisma/client').Prisma.TransactionClient,
  'branchStock' | 'stockMovement' | 'repairPart' | 'stockIdempotency'
>;

export interface StockDeltas {
  reservedDelta: number;
  onHandDelta: number;
}

/** Stock available for new reservations: on hand minus already reserved. */
export function availableQty(stock: StockState): number {
  return stock.qtyOnHand - stock.reservedQty;
}

/** Prisma unique-violation code, detected without importing the client. */
export function isUniqueViolation(error: unknown): boolean {
  return (
    typeof error === 'object' && error !== null && (error as { code?: unknown }).code === 'P2002'
  );
}

/** Prisma constraint-violation code (CHECK / FK), without the client. */
export function isCheckViolation(error: unknown): boolean {
  return (
    typeof error === 'object' && error !== null && (error as { code?: unknown }).code === 'P2004'
  );
}

const STOCK_SELECT = {
  tenantId: true,
  branchId: true,
  partId: true,
  qtyOnHand: true,
  reservedQty: true,
};

/**
 * Apply one stock change as a single conditional update. The pure
 * helpers validate the resulting state first (clean 422 for the
 * common case); the updateMany WHERE guards then enforce it against
 * the row as it stands at write time, so a concurrent change can
 * only lose by failing the guards, never by silent overwrite.
 */
export async function applyStockChange(
  tx: StockTx,
  tenantId: string,
  branchId: string,
  partId: string,
  deltas: StockDeltas,
): Promise<StockRow> {
  const row = await tx.branchStock.findFirst({
    where: { tenantId, branchId, partId },
    select: STOCK_SELECT,
  });
  if (!row) {
    throw new UnprocessableEntityException('Stock row not found at this branch.');
  }
  if (!(
    (deltas.reservedDelta > 0 && deltas.onHandDelta === 0) ||
    (deltas.reservedDelta < 0 && deltas.onHandDelta === 0) ||
    (deltas.reservedDelta < 0 &&
      deltas.onHandDelta < 0 &&
      deltas.reservedDelta === deltas.onHandDelta) ||
    deltas.reservedDelta === 0
  )) {
    throw new Error('Unsupported stock change.');
  }
  try {
    if (deltas.reservedDelta > 0) {
      reserveStock(row, deltas.reservedDelta);
    } else if (deltas.reservedDelta < 0 && deltas.onHandDelta === 0) {
      releaseStock(row, -deltas.reservedDelta);
    } else if (deltas.reservedDelta < 0) {
      consumeStock(row, -deltas.reservedDelta);
    } else if (
      row.qtyOnHand + deltas.onHandDelta > MAX_QTY ||
      row.qtyOnHand + deltas.onHandDelta < 0 ||
      row.qtyOnHand + deltas.onHandDelta < row.reservedQty
    ) {
      // Adjust: never below zero, never below what is already reserved.
      throw new Error('Insufficient stock on hand.');
    }
  } catch {
    throw new UnprocessableEntityException('Insufficient stock.');
  }
  let updated: { count: number };
  try {
    updated = await tx.branchStock.updateMany({
      where: {
        tenantId,
        branchId,
        partId,
        qtyOnHand: row.qtyOnHand,
        reservedQty: row.reservedQty,
      },
      data: {
        qtyOnHand: { increment: deltas.onHandDelta },
        reservedQty: { increment: deltas.reservedDelta },
      },
    });
  } catch (error) {
    // A concurrent reservation can pass the pre-check and then hit
    // the reservedQty <= qtyOnHand CHECK (migration 0003): that is
    // still insufficient stock, never a 500.
    if (isCheckViolation(error)) {
      throw new UnprocessableEntityException('Insufficient stock.');
    }
    throw error;
  }
  if (updated.count !== 1) {
    throw new UnprocessableEntityException('Insufficient stock.');
  }
  const fresh = await tx.branchStock.findFirst({
    where: { tenantId, branchId, partId },
    select: STOCK_SELECT,
  });
  if (!fresh) {
    throw new UnprocessableEntityException('Stock row not found at this branch.');
  }
  return fresh;
}

/** Trace columns for one ledger row. NULL means "not recorded" (all pre-0008 rows). */
export interface MovementTrace {
  repairOrderId?: string | null;
  repairPartId?: string | null;
  operationKey?: string | null;
  actorId?: string | null;
}

/** Append one ledger row. Stock movements are append-only: no update or delete API exists. */
export function recordMovement(
  tx: StockTx,
  tenantId: string,
  branchId: string,
  partId: string,
  qty: number,
  reason: 'reserve' | 'release' | 'consume' | 'adjust',
  trace: MovementTrace = {},
): Promise<unknown> {
  return tx.stockMovement.create({
    data: {
      tenantId,
      branchId,
      partId,
      qty,
      reason,
      repairOrderId: trace.repairOrderId ?? null,
      repairPartId: trace.repairPartId ?? null,
      operationKey: trace.operationKey ?? null,
      actorId: trace.actorId ?? null,
    },
  });
}

/**
 * Release every still-reserved part line of one order: stock back,
 * ledger row, line reserved -> released — all inside the caller's
 * transaction. Used by cancel / unrepairable auto-release.
 */
export async function releaseReservedParts(
  tx: StockTx,
  ctx: TenantContext,
  orderId: string,
): Promise<string[]> {
  const lines = await tx.repairPart.findMany({
    where: { tenantId: ctx.tenantId, orderId, status: 'reserved' },
    orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
  });
  const released: string[] = [];
  for (const line of lines) {
    await applyStockChange(tx, ctx.tenantId, line.branchId, line.partId, {
      reservedDelta: -line.qty,
      onHandDelta: 0,
    });
    await recordMovement(tx, ctx.tenantId, line.branchId, line.partId, -line.qty, 'release', {
      repairOrderId: orderId,
      repairPartId: line.id,
      // Deterministic: the same cancel/unrepairable transition for
      // the same line always traces to the same operation key.
      operationKey: `auto-release:${orderId}:${line.id}`,
      actorId: ctx.userId,
    });
    const updated = await tx.repairPart.updateMany({
      where: { id: line.id, tenantId: ctx.tenantId, status: 'reserved' },
      data: { status: 'released' },
    });
    if (updated.count !== 1) {
      throw new ConflictException('Repair part was modified concurrently; reload and retry.');
    }
    released.push(line.id);
  }
  return released;
}

/** Idempotency keys are 8..128 characters; the DTOs enforce this, this is the pure check. */
export function isValidIdempotencyKey(key: unknown): key is string {
  return typeof key === 'string' && key.length >= 8 && key.length <= 128;
}

/** Re-read a stored idempotency row, if this (tenant, scope, key) already ran. */
export function findIdempotency(
  tx: StockTx,
  tenantId: string,
  scope: string,
  key: string,
): Promise<IdempotencyRow | null> {
  return tx.stockIdempotency.findFirst({ where: { tenantId, scope, key } });
}

/** Claim a key last, after the work succeeded. Stored value is { request, response }. */
export function claimIdempotency(
  tx: StockTx,
  tenantId: string,
  scope: string,
  key: string,
  entityId: string,
  responseJson: unknown,
): Promise<IdempotencyRow> {
  return tx.stockIdempotency.create({
    data: {
      tenantId,
      scope,
      key,
      entityId,
      responseJson: responseJson as import('../generated/prisma/client').Prisma.InputJsonValue,
    },
  });
}
