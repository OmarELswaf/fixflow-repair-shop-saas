import { consumeStock, MAX_QTY, releaseStock, reserveStock } from './inventory';

describe('inventory (corrected semantics)', () => {
  it('reservation increases reserved only, not on-hand', () => {
    const after = reserveStock({ qtyOnHand: 10, reservedQty: 0 }, 3);
    expect(after).toEqual({ qtyOnHand: 10, reservedQty: 3 });
  });
  it('consumption decrements on-hand AND reserved once', () => {
    const reserved = reserveStock({ qtyOnHand: 10, reservedQty: 0 }, 3);
    const consumed = consumeStock(reserved, 3);
    expect(consumed).toEqual({ qtyOnHand: 7, reservedQty: 0 });
  });
  it('release decreases reserved only', () => {
    const reserved = reserveStock({ qtyOnHand: 10, reservedQty: 0 }, 3);
    expect(releaseStock(reserved, 2)).toEqual({ qtyOnHand: 10, reservedQty: 1 });
  });
  it('refuses to consume more than reserved or on hand', () => {
    expect(() => consumeStock({ qtyOnHand: 10, reservedQty: 1 }, 2)).toThrow();
    expect(() => consumeStock({ qtyOnHand: 1, reservedQty: 5 }, 2)).toThrow();
  });
  it('refuses to reserve more than on hand (mirrors the DB CHECK)', () => {
    expect(() => reserveStock({ qtyOnHand: 10, reservedQty: 8 }, 3)).toThrow(
      'Cannot reserve more than on hand.',
    );
    expect(reserveStock({ qtyOnHand: 10, reservedQty: 8 }, 2)).toEqual({
      qtyOnHand: 10,
      reservedQty: 10,
    });
  });
  it('refuses quantities above the ceiling, allows exactly the ceiling', () => {
    expect(MAX_QTY).toBe(1000000000);
    expect(() => reserveStock({ qtyOnHand: MAX_QTY, reservedQty: 0 }, MAX_QTY + 1)).toThrow(
      'Quantity exceeds the maximum allowed quantity.',
    );
    expect(() => consumeStock({ qtyOnHand: MAX_QTY, reservedQty: MAX_QTY }, MAX_QTY + 1)).toThrow(
      'Quantity exceeds the maximum allowed quantity.',
    );
    expect(() => releaseStock({ qtyOnHand: MAX_QTY, reservedQty: MAX_QTY }, MAX_QTY + 1)).toThrow(
      'Quantity exceeds the maximum allowed quantity.',
    );
    expect(reserveStock({ qtyOnHand: MAX_QTY, reservedQty: 0 }, MAX_QTY)).toEqual({
      qtyOnHand: MAX_QTY,
      reservedQty: MAX_QTY,
    });
  });
});
