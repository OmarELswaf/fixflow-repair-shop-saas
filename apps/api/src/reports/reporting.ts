/**
 * Pure reporting math. No Nest, no Prisma imports: the unit specs
 * must load under ts-jest in environments where the Prisma client
 * was never generated. The SQL in reports.service.ts mirrors these
 * exact boundaries — if a boundary changes here, change it there.
 */

export const AGING_BUCKETS = ['0-1d', '2-7d', '8-30d', '30d+'] as const;
export type AgingBucket = (typeof AGING_BUCKETS)[number];

const DAY_MS = 24 * 60 * 60 * 1000;

/** Which age bucket a repair created at `createdAt` falls in at `now`. */
export function agingBucket(createdAt: Date, now: Date): AgingBucket {
  const ageMs = now.getTime() - createdAt.getTime();
  if (ageMs < DAY_MS) return '0-1d';
  if (ageMs < 7 * DAY_MS) return '2-7d';
  if (ageMs < 30 * DAY_MS) return '8-30d';
  return '30d+';
}

export interface ReconciliationInput {
  qtyOnHand: number;
  reservedQty: number;
  reservedLinesTotal: number;
}

export interface Reconciliation {
  available: number;
  discrepancy: number;
  reconciled: boolean;
}

/**
 * Reconciliation math for one (branch, part) stock row:
 * `available` is on hand minus reserved; `discrepancy` is the
 * reserved counter minus the sum of still-reserved lines. A row is
 * reconciled only when the two agree exactly.
 */
export function reconcileRow(input: ReconciliationInput): Reconciliation {
  const available = input.qtyOnHand - input.reservedQty;
  const discrepancy = input.reservedQty - input.reservedLinesTotal;
  return { available, discrepancy, reconciled: discrepancy === 0 };
}
