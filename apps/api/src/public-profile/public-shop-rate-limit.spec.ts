// NestJS 12 ships ESM that ts-jest/CJS cannot require; mock the one
// Nest decorator this module uses, as auth.service.spec.ts does.
jest.mock('@nestjs/common', () => ({
  Injectable: () => (target: unknown) => target,
}));

import {
  createRateLimiter,
  PUBLIC_SHOP_MAX_PER_IP,
  PUBLIC_SHOP_WINDOW_MS,
  type RateLimitRequest,
  type RateLimitResponse,
} from '../auth/rate-limit';
import { PublicShopRateLimitMiddleware } from './public-shop-rate-limit';

function mockResponse(): {
  res: RateLimitResponse;
  calls: { status: number[]; body: unknown[]; headers: Record<string, string> };
} {
  const calls = {
    status: [] as number[],
    body: [] as unknown[],
    headers: {} as Record<string, string>,
  };
  const res = {
    setHeader(name: string, value: string): void {
      calls.headers[name] = value;
    },
    status(code: number): RateLimitResponse {
      calls.status.push(code);
      return res;
    },
    json(body: unknown): void {
      calls.body.push(body);
    },
  };
  return { res, calls };
}

function getRequest(ip: string, method = 'GET'): RateLimitRequest {
  return { method, path: '/api/public/shops/shop-a-repair', ip };
}

describe('PublicShopRateLimitMiddleware', () => {
  it(`allows ${PUBLIC_SHOP_MAX_PER_IP} GETs per IP, then 429 with Retry-After`, () => {
    const mw = new PublicShopRateLimitMiddleware();
    let nextCalls = 0;
    const next = (): void => {
      nextCalls += 1;
    };
    for (let i = 0; i < PUBLIC_SHOP_MAX_PER_IP; i++) {
      mw.use(getRequest('10.0.0.1'), mockResponse().res, next);
    }
    expect(nextCalls).toBe(PUBLIC_SHOP_MAX_PER_IP);
    const { res, calls } = mockResponse();
    mw.use(getRequest('10.0.0.1'), res, next);
    expect(nextCalls).toBe(PUBLIC_SHOP_MAX_PER_IP);
    expect(calls.status).toEqual([429]);
    expect(calls.body).toEqual([{ statusCode: 429, message: 'Too many requests.' }]);
    const retryAfter = Number(calls.headers['Retry-After']);
    expect(Number.isInteger(retryAfter)).toBe(true);
    expect(retryAfter).toBeGreaterThanOrEqual(1);
    expect(retryAfter).toBeLessThanOrEqual(PUBLIC_SHOP_WINDOW_MS / 1000);
  });

  it('isolates the budget per IP', () => {
    const mw = new PublicShopRateLimitMiddleware();
    let nextCalls = 0;
    const next = (): void => {
      nextCalls += 1;
    };
    for (let i = 0; i < PUBLIC_SHOP_MAX_PER_IP; i++) {
      mw.use(getRequest('10.0.0.2'), mockResponse().res, next);
    }
    expect(nextCalls).toBe(PUBLIC_SHOP_MAX_PER_IP);
    const { res, calls } = mockResponse();
    mw.use(getRequest('10.0.0.2'), res, next);
    expect(calls.status).toEqual([429]);
    // A different IP still gets its own full budget.
    const other = mockResponse();
    mw.use(getRequest('10.0.0.3'), other.res, next);
    expect(nextCalls).toBe(PUBLIC_SHOP_MAX_PER_IP + 1);
    expect(other.calls.status).toEqual([]);
  });

  it('passes non-GET requests through untouched', () => {
    const mw = new PublicShopRateLimitMiddleware();
    let nextCalls = 0;
    const next = (): void => {
      nextCalls += 1;
    };
    for (let i = 0; i < PUBLIC_SHOP_MAX_PER_IP + 1; i++) {
      mw.use(getRequest('10.0.0.4', 'POST'), mockResponse().res, next);
    }
    expect(nextCalls).toBe(PUBLIC_SHOP_MAX_PER_IP + 1);
  });

  it('window slides: attempts expire after the configured window', () => {
    const limiter = createRateLimiter({
      windowMs: PUBLIC_SHOP_WINDOW_MS,
      max: PUBLIC_SHOP_MAX_PER_IP,
    });
    for (let i = 0; i < PUBLIC_SHOP_MAX_PER_IP; i++) {
      expect(limiter.allow('public-shop:10.0.0.5', i).allowed).toBe(true);
    }
    expect(limiter.allow('public-shop:10.0.0.5', PUBLIC_SHOP_MAX_PER_IP).allowed).toBe(false);
    // One window after the first attempt it has fallen out: allowed again.
    expect(limiter.allow('public-shop:10.0.0.5', PUBLIC_SHOP_WINDOW_MS + 1).allowed).toBe(true);
  });

  it('fails closed instead of growing memory without bound (10,000-key cap)', () => {
    const limiter = createRateLimiter({ windowMs: PUBLIC_SHOP_WINDOW_MS, max: 1 });
    for (let i = 0; i < 10_000; i++) {
      expect(limiter.allow(`key-${i}`, 1000).allowed).toBe(true);
    }
    // The 10,001st distinct key is denied, not stored.
    const denied = limiter.allow('key-10000', 1000);
    expect(denied.allowed).toBe(false);
    expect(denied.retryAfterSeconds).toBe(PUBLIC_SHOP_WINDOW_MS / 1000);
    // Keys already in the map are unaffected by the cap.
    expect(limiter.allow('key-0', 1001).allowed).toBe(false); // max 1, already used
  });
});
