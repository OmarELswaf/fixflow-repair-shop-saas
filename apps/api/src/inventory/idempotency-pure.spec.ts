import { idempotencyResponse, matchesIdempotencyRequest } from './idempotency-pure';

describe('idempotency replay determinism', () => {
  const request = { orderId: 'o1', partId: 'p1', qty: 3 };
  const response = {
    id: 'line-1',
    orderId: 'o1',
    partId: 'p1',
    qty: 3,
    status: 'reserved',
  };
  const stored = { request, response };

  it('returns the stored response verbatim, twice, with no mutation', () => {
    const first = idempotencyResponse<typeof response>(stored);
    const second = idempotencyResponse<typeof response>(stored);
    expect(first).toBe(response);
    expect(second).toBe(response);
    expect(first).toEqual(second);
    expect(first).toEqual(response);
  });

  it('matches exactly the request the key was claimed for', () => {
    expect(matchesIdempotencyRequest(stored, { orderId: 'o1', partId: 'p1', qty: 3 })).toBe(true);
    expect(matchesIdempotencyRequest(stored, { orderId: 'o1', partId: 'p1', qty: 4 })).toBe(false);
    expect(matchesIdempotencyRequest(stored, { orderId: 'o1', partId: 'p1' })).toBe(false);
    expect(
      matchesIdempotencyRequest(stored, { orderId: 'o1', partId: 'p1', qty: 3, extra: 1 }),
    ).toBe(false);
  });

  it('rejects malformed stored values instead of replaying them', () => {
    expect(matchesIdempotencyRequest(null, request)).toBe(false);
    expect(matchesIdempotencyRequest({}, request)).toBe(false);
    expect(matchesIdempotencyRequest({ request: null }, request)).toBe(false);
    expect(idempotencyResponse(null)).toBeNull();
    expect(idempotencyResponse({})).toBeNull();
  });
});
