import Decimal from 'decimal.js';

/** Decimal-safe money helpers. Amounts are Decimal strings, never floats. */
export function add(a: string, b: string): string {
  return new Decimal(a).plus(new Decimal(b)).toString();
}
export function sub(a: string, b: string): string {
  return new Decimal(a).minus(new Decimal(b)).toString();
}
export function mul(a: string, b: string): string {
  return new Decimal(a).times(new Decimal(b)).toString();
}
export function formatMoney(amount: string, currency: string): string {
  return `${new Decimal(amount).toFixed(2)} ${currency}`;
}
