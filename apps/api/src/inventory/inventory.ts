export interface StockState {
  qtyOnHand: number;
  reservedQty: number;
}

/**
 * Quantity ceiling. int4 tops out at 2147483647; 1,000,000,000
 * leaves headroom for one max-size increment without overflowing.
 * The same bound is a database CHECK (migration 0008); this is the
 * pure pre-check, enforced before the write.
 */
export const MAX_QTY = 1000000000;

function checkCeiling(qty: number): void {
  if (!Number.isInteger(qty) || qty > MAX_QTY) {
    throw new Error('Quantity exceeds the maximum allowed quantity.');
  }
}

/**
 * Corrected inventory semantics:
 * - reserve: reservedQty += qty ONLY, qtyOnHand unchanged.
 * - consume: qtyOnHand -= qty AND reservedQty -= qty, once, in one transaction.
 * - release: reservedQty -= qty ONLY.
 */
export function reserveStock(stock: StockState, qty: number): StockState {
  if (qty <= 0) throw new Error('Quantity must be positive.');
  checkCeiling(qty);
  // Mirrors the DB CHECK (reservedQty <= qtyOnHand, migration 0003):
  // reserving more than is on hand must fail before it reaches the DB.
  if (stock.reservedQty + qty > stock.qtyOnHand) {
    throw new Error('Cannot reserve more than on hand.');
  }
  return { qtyOnHand: stock.qtyOnHand, reservedQty: stock.reservedQty + qty };
}

export function consumeStock(stock: StockState, qty: number): StockState {
  if (qty <= 0) throw new Error('Quantity must be positive.');
  checkCeiling(qty);
  if (qty > stock.reservedQty) throw new Error('Cannot consume more than reserved.');
  if (qty > stock.qtyOnHand) throw new Error('Insufficient stock on hand.');
  return { qtyOnHand: stock.qtyOnHand - qty, reservedQty: stock.reservedQty - qty };
}

export function releaseStock(stock: StockState, qty: number): StockState {
  if (qty <= 0) throw new Error('Quantity must be positive.');
  checkCeiling(qty);
  if (qty > stock.reservedQty) throw new Error('Cannot release more than reserved.');
  return { qtyOnHand: stock.qtyOnHand, reservedQty: stock.reservedQty - qty };
}
