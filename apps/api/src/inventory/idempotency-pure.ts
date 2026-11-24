/**
 * Pure idempotency matching. Kept in a dependency-free module on
 * purpose: the replay-determinism tests must load under ts-jest in
 * environments where the Prisma client was never generated, and
 * stock-ops.ts imports generated delegate types. stock-ops.ts
 * re-exports these two functions so existing import sites are
 * unchanged.
 */

/** True when a stored idempotency row was claimed for exactly this request body. */
export function matchesIdempotencyRequest(
  stored: unknown,
  request: Record<string, unknown>,
): boolean {
  if (!stored || typeof stored !== 'object') return false;
  const prev = (stored as { request?: unknown }).request;
  if (!prev || typeof prev !== 'object') return false;
  const prevRec = prev as Record<string, unknown>;
  const keys = new Set([...Object.keys(prevRec), ...Object.keys(request)]);
  for (const key of keys) {
    if (prevRec[key] !== request[key]) return false;
  }
  return true;
}

/** The response stored alongside a claimed idempotency row, or null. */
export function idempotencyResponse<T>(stored: unknown): T | null {
  if (!stored || typeof stored !== 'object') return null;
  return (stored as { response?: T }).response ?? null;
}
