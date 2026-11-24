// NestJS 12 ships ESM that ts-jest/CJS cannot require; mock the one
// Nest decorator this module uses, as auth.service.spec.ts does.
jest.mock('@nestjs/common', () => ({
  Injectable: () => (target: unknown) => target,
}));

import {
  AuthRateLimitMiddleware,
  clientIp,
  createRateLimiter,
  normalizeRateLimitEmail,
  type RateLimitRequest,
  type RateLimitResponse,
} from './rate-limit';

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

describe('createRateLimiter', () => {
  it('allows up to max attempts inside the window', () => {
    const limiter = createRateLimiter({ windowMs: 60_000, max: 3 });
    expect(limiter.allow('k', 1000)).toEqual({ allowed: true, retryAfterSeconds: 0 });
    expect(limiter.allow('k', 2000)).toEqual({ allowed: true, retryAfterSeconds: 0 });
    expect(limiter.allow('k', 3000)).toEqual({ allowed: true, retryAfterSeconds: 0 });
    const denied = limiter.allow('k', 4000);
    expect(denied.allowed).toBe(false);
    expect(denied.retryAfterSeconds).toBe(57); // oldest (1000) + 60000 - 4000, in seconds
  });

  it('expires attempts after the window slides past', () => {
    const limiter = createRateLimiter({ windowMs: 60_000, max: 2 });
    limiter.allow('k', 0);
    limiter.allow('k', 1000);
    expect(limiter.allow('k', 2000).allowed).toBe(false);
    // At t=60001 the attempt at t=0 has fallen out of the window.
    expect(limiter.allow('k', 60_001)).toEqual({ allowed: true, retryAfterSeconds: 0 });
    // At t=61001 the attempt at t=1000 has also fallen out.
    expect(limiter.allow('k', 61_001)).toEqual({ allowed: true, retryAfterSeconds: 0 });
  });

  it('isolates keys from each other', () => {
    const limiter = createRateLimiter({ windowMs: 60_000, max: 1 });
    expect(limiter.allow('a', 1000).allowed).toBe(true);
    expect(limiter.allow('b', 1000).allowed).toBe(true);
    expect(limiter.allow('a', 2000).allowed).toBe(false);
    expect(limiter.allow('b', 2000).allowed).toBe(false);
  });

  it('retryAfter is at least 1 second and shrinks as the window slides', () => {
    const limiter = createRateLimiter({ windowMs: 1000, max: 1 });
    limiter.allow('k', 0);
    expect(limiter.allow('k', 500)).toEqual({ allowed: false, retryAfterSeconds: 1 });
    expect(limiter.allow('k', 999)).toEqual({ allowed: false, retryAfterSeconds: 1 });
  });
});

describe('normalizeRateLimitEmail / clientIp', () => {
  it('normalizes email case and whitespace; non-strings become empty', () => {
    expect(normalizeRateLimitEmail('  Owner@Example.TEST ')).toBe('owner@example.test');
    expect(normalizeRateLimitEmail(undefined)).toBe('');
    expect(normalizeRateLimitEmail(42)).toBe('');
  });

  it('prefers req.ip, falls back to the socket address', () => {
    expect(clientIp({ ip: '1.2.3.4', socket: { remoteAddress: '5.6.7.8' } })).toBe('1.2.3.4');
    expect(clientIp({ socket: { remoteAddress: '5.6.7.8' } })).toBe('5.6.7.8');
    expect(clientIp({})).toBe('unknown');
  });
});

describe('AuthRateLimitMiddleware', () => {
  it('returns 429 with Retry-After at the login per-account boundary', () => {
    const mw = new AuthRateLimitMiddleware();
    const req: RateLimitRequest = {
      method: 'POST',
      path: '/api/auth/login',
      body: { email: 'Owner@Example.TEST' },
      ip: '10.0.0.1',
    };
    let nextCalls = 0;
    const next = (): void => {
      nextCalls += 1;
    };
    for (let i = 0; i < 5; i++) {
      const { res } = mockResponse();
      mw.use(req, res, next);
    }
    expect(nextCalls).toBe(5);
    const { res, calls } = mockResponse();
    mw.use(req, res, next);
    expect(nextCalls).toBe(5);
    expect(calls.status).toEqual([429]);
    expect(calls.body).toEqual([{ statusCode: 429, message: 'Too many requests.' }]);
    expect(Number(calls.headers['Retry-After'])).toBeGreaterThan(0);
  });

  it('isolates the per-account login limit by normalized email', () => {
    const mw = new AuthRateLimitMiddleware();
    const next = (): void => undefined;
    let allowed = 0;
    for (let i = 0; i < 5; i++) {
      let called = false;
      mw.use(
        {
          method: 'POST',
          path: '/api/auth/login',
          body: { email: 'a@example.test' },
          ip: '10.0.0.2',
        },
        mockResponse().res,
        () => {
          called = true;
        },
      );
      if (called) allowed += 1;
    }
    expect(allowed).toBe(5);
    // A different email from the same IP still gets its own budget.
    const { res, calls } = mockResponse();
    let called = false;
    mw.use(
      {
        method: 'POST',
        path: '/api/auth/login',
        body: { email: 'b@example.test' },
        ip: '10.0.0.2',
      },
      res,
      () => {
        called = true;
      },
    );
    expect(called).toBe(true);
    expect(calls.status).toEqual([]);
  });

  it('limits register per IP and passes through other routes', () => {
    const mw = new AuthRateLimitMiddleware();
    let nextCalls = 0;
    const next = (): void => {
      nextCalls += 1;
    };
    const req: RateLimitRequest = { method: 'POST', path: '/api/auth/register', ip: '10.0.0.3' };
    for (let i = 0; i < 5; i++) mw.use(req, mockResponse().res, next);
    expect(nextCalls).toBe(5);
    const { res, calls } = mockResponse();
    mw.use(req, res, next);
    expect(nextCalls).toBe(5);
    expect(calls.status).toEqual([429]);
    // GET /auth/me and other routes are untouched.
    mw.use({ method: 'GET', path: '/api/auth/me', ip: '10.0.0.3' }, mockResponse().res, next);
    expect(nextCalls).toBe(6);
  });
});
