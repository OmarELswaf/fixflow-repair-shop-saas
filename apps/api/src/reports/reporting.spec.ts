import { AGING_BUCKETS, agingBucket, reconcileRow } from './reporting';

describe('agingBucket', () => {
  const now = new Date('2026-11-24T12:00:00.000Z');
  const hoursAgo = (h: number) => new Date(now.getTime() - h * 60 * 60 * 1000);

  it('buckets by age with exact day boundaries', () => {
    expect(agingBucket(hoursAgo(0), now)).toBe('0-1d');
    expect(agingBucket(hoursAgo(23), now)).toBe('0-1d');
    expect(agingBucket(hoursAgo(24), now)).toBe('2-7d');
    expect(agingBucket(hoursAgo(24 * 6 + 23), now)).toBe('2-7d');
    expect(agingBucket(hoursAgo(24 * 7), now)).toBe('8-30d');
    expect(agingBucket(hoursAgo(24 * 29), now)).toBe('8-30d');
    expect(agingBucket(hoursAgo(24 * 30), now)).toBe('30d+');
    expect(agingBucket(hoursAgo(24 * 365), now)).toBe('30d+');
  });

  it('exposes exactly the four documented buckets', () => {
    expect([...AGING_BUCKETS]).toEqual(['0-1d', '2-7d', '8-30d', '30d+']);
  });
});

describe('reconcileRow', () => {
  it('is reconciled when reserved matches the reserved lines', () => {
    expect(reconcileRow({ qtyOnHand: 10, reservedQty: 3, reservedLinesTotal: 3 })).toEqual({
      available: 7,
      discrepancy: 0,
      reconciled: true,
    });
  });

  it('reports a positive discrepancy when the counter runs ahead of the lines', () => {
    expect(reconcileRow({ qtyOnHand: 10, reservedQty: 5, reservedLinesTotal: 3 })).toEqual({
      available: 5,
      discrepancy: 2,
      reconciled: false,
    });
  });

  it('reports a negative discrepancy when lines exceed the counter', () => {
    expect(reconcileRow({ qtyOnHand: 10, reservedQty: 2, reservedLinesTotal: 3 })).toEqual({
      available: 8,
      discrepancy: -1,
      reconciled: false,
    });
  });

  it('handles an empty row as reconciled', () => {
    expect(reconcileRow({ qtyOnHand: 0, reservedQty: 0, reservedLinesTotal: 0 })).toEqual({
      available: 0,
      discrepancy: 0,
      reconciled: true,
    });
  });
});
