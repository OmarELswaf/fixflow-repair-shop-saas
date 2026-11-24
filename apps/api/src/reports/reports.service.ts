import { BadRequestException, ForbiddenException, Injectable } from '@nestjs/common';
import { Prisma } from '../generated/prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { canAccessBranch } from '../tenancy/permissions';
import type { TenantContext } from '../tenancy/tenant-context';
import { AGING_BUCKETS, reconcileRow, type AgingBucket } from './reporting';

export interface RepairsSummary {
  total: number;
  byStatus: Array<{ status: string; count: number }>;
  aging: Array<{ bucket: AgingBucket; count: number }>;
  /**
   * ISO timestamp of the snapshot this response was read from
   * (PostgreSQL now() inside the transaction). Every number in
   * this response comes from that one snapshot.
   */
  snapshotAt: string;
}

export interface StockOverview {
  summary: StockSummary;
  items: StockReconciliationRow[];
  nextCursor: string | null;
  /** Same snapshot label as RepairsSummary.snapshotAt. */
  snapshotAt: string;
}

export interface StockReconciliationRow {
  partId: string;
  partSku: string;
  partName: string;
  branchId: string;
  branchName: string;
  qtyOnHand: number;
  reservedQty: number;
  available: number;
  reservedLinesTotal: number;
  discrepancy: number;
  reconciled: boolean;
}

export interface StockSummary {
  totalParts: number;
  totalOnHand: number;
  totalReserved: number;
  totalAvailable: number;
  mismatchedRows: number;
}

const EMPTY_SUMMARY: StockSummary = {
  totalParts: 0,
  totalOnHand: 0,
  totalReserved: 0,
  totalAvailable: 0,
  mismatchedRows: 0,
};

/**
 * Read-only operational reports. Every query is bounded: tenant +
 * branch scope is always applied, aggregates never fetch full rows,
 * and paged queries carry an explicit LIMIT. No writes happen here.
 * Raw SQL uses Prisma.sql with bound parameters only — values are
 * never interpolated into SQL text.
 */
@Injectable()
export class ReportsService {
  constructor(private readonly prisma: PrismaService) {}

  private scopedBranches(ctx: TenantContext, branchId?: string): string[] {
    if (branchId) {
      if (!canAccessBranch(ctx, branchId)) {
        throw new ForbiddenException('Branch is outside the user scope.');
      }
      return [branchId];
    }
    return [...ctx.branchIds];
  }

  async repairsSummary(
    ctx: TenantContext,
    input: { status?: string; branchId?: string; from?: string; to?: string },
  ): Promise<RepairsSummary> {
    const branchIds = this.scopedBranches(ctx, input.branchId);
    if (branchIds.length === 0) {
      // No rows can exist in an empty scope, so the counts are
      // definitionally 0 at any time; the label is just "now".
      return {
        total: 0,
        byStatus: [],
        aging: AGING_BUCKETS.map((bucket) => ({ bucket, count: 0 })),
        snapshotAt: new Date().toISOString(),
      };
    }
    const where: Prisma.RepairOrderWhereInput = {
      tenantId: ctx.tenantId,
      branchId: { in: branchIds },
      ...(input.status ? { status: input.status as Prisma.RepairOrderWhereInput['status'] } : {}),
      ...(input.from || input.to
        ? {
            createdAt: {
              ...(input.from ? { gte: new Date(input.from) } : {}),
              ...(input.to ? { lte: new Date(input.to) } : {}),
            },
          }
        : {}),
    };
    // One REPEATABLE READ transaction: total, byStatus and aging
    // are all read from the same snapshot, and now() inside it is
    // the snapshot label. Separate statements would let a
    // concurrent write land between the counts.
    const statusFilter = input.status ? Prisma.sql`AND "status" = ${input.status}` : Prisma.empty;
    const fromFilter = input.from
      ? Prisma.sql`AND "createdAt" >= ${new Date(input.from)}`
      : Prisma.empty;
    const toFilter = input.to ? Prisma.sql`AND "createdAt" <= ${new Date(input.to)}` : Prisma.empty;
    const snap = await this.prisma.withTenantSnapshot(ctx.tenantId, async (tx) => {
      const total = await tx.repairOrder.count({ where });
      const grouped = await tx.repairOrder.groupBy({
        by: ['status'],
        where,
        _count: { _all: true },
      });
      // Aging buckets are computed in SQL (CASE on now() - createdAt)
      // so the database never ships full rows for counting. The
      // boundaries mirror agingBucket() in reporting.ts exactly.
      const agingRows = await tx.$queryRaw<Array<{ bucket: string; count: bigint }>>(Prisma.sql`
        SELECT CASE
          WHEN "createdAt" > now() - interval '1 day' THEN '0-1d'
          WHEN "createdAt" > now() - interval '7 days' THEN '2-7d'
          WHEN "createdAt" > now() - interval '30 days' THEN '8-30d'
          ELSE '30d+' END AS bucket, COUNT(*) AS count
        FROM "repair_orders"
        WHERE "tenantId" = ${ctx.tenantId}
          AND "branchId" IN (${Prisma.join(branchIds)})
          ${statusFilter} ${fromFilter} ${toFilter}
        GROUP BY 1 ORDER BY 1`);
      const snapshotRows = await tx.$queryRaw<Array<{ now: Date }>>`SELECT now() AS "now"`;
      return { total, grouped, agingRows, snapshotAt: snapshotRows[0].now.toISOString() };
    });
    const agingByBucket = new Map(snap.agingRows.map((r) => [r.bucket, Number(r.count)]));
    return {
      total: snap.total,
      byStatus: snap.grouped
        .map((g) => ({ status: g.status, count: g._count._all }))
        .sort((a, b) => a.status.localeCompare(b.status)),
      aging: AGING_BUCKETS.map((bucket) => ({ bucket, count: agingByBucket.get(bucket) ?? 0 })),
      snapshotAt: snap.snapshotAt,
    };
  }

  async stockReconciliation(
    ctx: TenantContext,
    input: { partId?: string; branchId?: string; cursor?: string; limit?: number },
  ): Promise<{ items: StockReconciliationRow[]; nextCursor: string | null }> {
    const branchIds = this.scopedBranches(ctx, input.branchId);
    if (branchIds.length === 0) return { items: [], nextCursor: null };
    const take = Math.min(Math.max(input.limit ?? 20, 1), 100);
    let cursorFilter = Prisma.empty;
    if (input.cursor) {
      const segments = input.cursor.split(':');
      const [cursorBranch, cursorPart] = segments;
      if (segments.length !== 2 || !cursorBranch || !cursorPart) {
        throw new BadRequestException('Invalid cursor.');
      }
      cursorFilter = Prisma.sql`AND (bs."branchId" > ${cursorBranch} OR (bs."branchId" = ${cursorBranch} AND bs."partId" > ${cursorPart}))`;
    }
    const partFilter = input.partId ? Prisma.sql`AND bs."partId" = ${input.partId}` : Prisma.empty;
    interface RawRow {
      branchId: string;
      partId: string;
      partSku: string;
      partName: string;
      branchName: string;
      qtyOnHand: number;
      reservedQty: number;
      reservedLinesTotal: number;
    }
    const rows = await this.prisma.withTenant(ctx.tenantId, (tx) =>
      tx.$queryRaw<RawRow[]>(Prisma.sql`
        SELECT bs."branchId", bs."partId", p.sku AS "partSku", p.name AS "partName",
               b.name AS "branchName", bs."qtyOnHand", bs."reservedQty",
               COALESCE(SUM(rp.qty), 0)::float8 AS "reservedLinesTotal"
        FROM branch_stock bs
        JOIN parts p ON p."tenantId" = bs."tenantId" AND p.id = bs."partId"
        JOIN branches b ON b."tenantId" = bs."tenantId" AND b.id = bs."branchId"
        LEFT JOIN repair_parts rp
          ON rp."tenantId" = bs."tenantId" AND rp."branchId" = bs."branchId"
          AND rp."partId" = bs."partId" AND rp.status = 'reserved'
        WHERE bs."tenantId" = ${ctx.tenantId}
          AND bs."branchId" IN (${Prisma.join(branchIds)})
          ${partFilter}
          ${cursorFilter}
        GROUP BY bs."branchId", bs."partId", p.sku, p.name, b.name, bs."qtyOnHand", bs."reservedQty"
        ORDER BY bs."branchId" ASC, bs."partId" ASC
        LIMIT ${take + 1}`),
    );
    const page = rows.slice(0, take);
    return {
      items: page.map((r) => {
        const rec = reconcileRow({
          qtyOnHand: r.qtyOnHand,
          reservedQty: r.reservedQty,
          reservedLinesTotal: r.reservedLinesTotal,
        });
        return {
          partId: r.partId,
          partSku: r.partSku,
          partName: r.partName,
          branchId: r.branchId,
          branchName: r.branchName,
          qtyOnHand: r.qtyOnHand,
          reservedQty: r.reservedQty,
          available: rec.available,
          reservedLinesTotal: r.reservedLinesTotal,
          discrepancy: rec.discrepancy,
          reconciled: rec.reconciled,
        };
      }),
      nextCursor:
        rows.length > take
          ? `${page[page.length - 1].branchId}:${page[page.length - 1].partId}`
          : null,
    };
  }

  /**
   * Combined stock overview: the summary AND one page of
   * reconciliation rows from ONE REPEATABLE READ transaction, so
   * the summary totals and the rows in the same response can never
   * disagree because of a concurrent write. The two raw queries
   * below are deliberately the same SQL as stockReconciliation /
   * stockSummary (qualified cursor fields, float8 sums, no int4
   * casts); those endpoints are left untouched so their reviewed
   * behaviour cannot drift. Cross-page stability is NOT claimed:
   * each page is its own snapshot — see docs/DATABASE.md.
   */
  async stockOverview(
    ctx: TenantContext,
    input: { partId?: string; branchId?: string; cursor?: string; limit?: number },
  ): Promise<StockOverview> {
    const branchIds = this.scopedBranches(ctx, input.branchId);
    if (branchIds.length === 0) {
      return {
        summary: { ...EMPTY_SUMMARY },
        items: [],
        nextCursor: null,
        snapshotAt: new Date().toISOString(),
      };
    }
    const take = Math.min(Math.max(input.limit ?? 20, 1), 100);
    let cursorFilter = Prisma.empty;
    if (input.cursor) {
      const segments = input.cursor.split(':');
      const [cursorBranch, cursorPart] = segments;
      if (segments.length !== 2 || !cursorBranch || !cursorPart) {
        throw new BadRequestException('Invalid cursor.');
      }
      cursorFilter = Prisma.sql`AND (bs."branchId" > ${cursorBranch} OR (bs."branchId" = ${cursorBranch} AND bs."partId" > ${cursorPart}))`;
    }
    const partFilter = input.partId ? Prisma.sql`AND bs."partId" = ${input.partId}` : Prisma.empty;
    interface RawRow {
      branchId: string;
      partId: string;
      partSku: string;
      partName: string;
      branchName: string;
      qtyOnHand: number;
      reservedQty: number;
      reservedLinesTotal: number;
    }
    const snap = await this.prisma.withTenantSnapshot(ctx.tenantId, async (tx) => {
      const summaryRows = await tx.$queryRaw<StockSummary[]>(Prisma.sql`
        SELECT COUNT(DISTINCT bs."partId")::int AS "totalParts",
               COALESCE(SUM(bs."qtyOnHand"), 0)::float8 AS "totalOnHand",
               COALESCE(SUM(bs."reservedQty"), 0)::float8 AS "totalReserved",
               COALESCE(SUM(bs."qtyOnHand" - bs."reservedQty"), 0)::float8 AS "totalAvailable",
               COUNT(*) FILTER (WHERE bs."reservedQty" <> COALESCE(rs."reservedTotal", 0))::int AS "mismatchedRows"
        FROM branch_stock bs
        LEFT JOIN (
          SELECT "tenantId", "branchId", "partId", SUM(qty)::float8 AS "reservedTotal"
          FROM repair_parts WHERE status = 'reserved' GROUP BY 1, 2, 3
        ) rs ON rs."tenantId" = bs."tenantId" AND rs."branchId" = bs."branchId" AND rs."partId" = bs."partId"
        WHERE bs."tenantId" = ${ctx.tenantId}
          AND bs."branchId" IN (${Prisma.join(branchIds)})
          ${partFilter}`);
      const rows = await tx.$queryRaw<RawRow[]>(Prisma.sql`
        SELECT bs."branchId", bs."partId", p.sku AS "partSku", p.name AS "partName",
               b.name AS "branchName", bs."qtyOnHand", bs."reservedQty",
               COALESCE(SUM(rp.qty), 0)::float8 AS "reservedLinesTotal"
        FROM branch_stock bs
        JOIN parts p ON p."tenantId" = bs."tenantId" AND p.id = bs."partId"
        JOIN branches b ON b."tenantId" = bs."tenantId" AND b.id = bs."branchId"
        LEFT JOIN repair_parts rp
          ON rp."tenantId" = bs."tenantId" AND rp."branchId" = bs."branchId"
          AND rp."partId" = bs."partId" AND rp.status = 'reserved'
        WHERE bs."tenantId" = ${ctx.tenantId}
          AND bs."branchId" IN (${Prisma.join(branchIds)})
          ${partFilter}
          ${cursorFilter}
        GROUP BY bs."branchId", bs."partId", p.sku, p.name, b.name, bs."qtyOnHand", bs."reservedQty"
        ORDER BY bs."branchId" ASC, bs."partId" ASC
        LIMIT ${take + 1}`);
      const snapshotRows = await tx.$queryRaw<Array<{ now: Date }>>`SELECT now() AS "now"`;
      return {
        summary: summaryRows[0] ?? { ...EMPTY_SUMMARY },
        rows,
        snapshotAt: snapshotRows[0].now.toISOString(),
      };
    });
    const page = snap.rows.slice(0, take);
    return {
      summary: snap.summary,
      items: page.map((r) => {
        const rec = reconcileRow({
          qtyOnHand: r.qtyOnHand,
          reservedQty: r.reservedQty,
          reservedLinesTotal: r.reservedLinesTotal,
        });
        return {
          partId: r.partId,
          partSku: r.partSku,
          partName: r.partName,
          branchId: r.branchId,
          branchName: r.branchName,
          qtyOnHand: r.qtyOnHand,
          reservedQty: r.reservedQty,
          available: rec.available,
          reservedLinesTotal: r.reservedLinesTotal,
          discrepancy: rec.discrepancy,
          reconciled: rec.reconciled,
        };
      }),
      nextCursor:
        snap.rows.length > take
          ? `${page[page.length - 1].branchId}:${page[page.length - 1].partId}`
          : null,
      snapshotAt: snap.snapshotAt,
    };
  }

  async stockSummary(ctx: TenantContext, input: { branchId?: string }): Promise<StockSummary> {
    const branchIds = this.scopedBranches(ctx, input.branchId);
    if (branchIds.length === 0) return { ...EMPTY_SUMMARY };
    const rows = await this.prisma.withTenant(ctx.tenantId, (tx) =>
      tx.$queryRaw<StockSummary[]>(Prisma.sql`
        SELECT COUNT(DISTINCT bs."partId")::int AS "totalParts",
               COALESCE(SUM(bs."qtyOnHand"), 0)::float8 AS "totalOnHand",
               COALESCE(SUM(bs."reservedQty"), 0)::float8 AS "totalReserved",
               COALESCE(SUM(bs."qtyOnHand" - bs."reservedQty"), 0)::float8 AS "totalAvailable",
               COUNT(*) FILTER (WHERE bs."reservedQty" <> COALESCE(rs."reservedTotal", 0))::int AS "mismatchedRows"
        FROM branch_stock bs
        LEFT JOIN (
          SELECT "tenantId", "branchId", "partId", SUM(qty)::float8 AS "reservedTotal"
          FROM repair_parts WHERE status = 'reserved' GROUP BY 1, 2, 3
        ) rs ON rs."tenantId" = bs."tenantId" AND rs."branchId" = bs."branchId" AND rs."partId" = bs."partId"
        WHERE bs."tenantId" = ${ctx.tenantId}
          AND bs."branchId" IN (${Prisma.join(branchIds)})`),
    );
    return (
      rows[0] ?? {
        totalParts: 0,
        totalOnHand: 0,
        totalReserved: 0,
        totalAvailable: 0,
        mismatchedRows: 0,
      }
    );
  }
}
