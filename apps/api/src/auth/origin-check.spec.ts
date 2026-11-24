// NestJS 12 ships ESM that ts-jest/CJS cannot require; mock the Nest
// decorators this module uses, as auth.service.spec.ts does.
jest.mock('@nestjs/common', () => ({
  Injectable: () => (target: unknown) => target,
  Inject: () => () => undefined,
}));

import {
  CookieOriginMiddleware,
  isAllowedOrigin,
  originOf,
  parseWebOrigins,
  type OriginCheckRequest,
  type OriginCheckResponse,
} from './origin-check';

describe('parseWebOrigins', () => {
  it('splits on commas, trims, drops empties', () => {
    expect(parseWebOrigins('http://localhost:5173, https://app.example.com ,')).toEqual([
      'http://localhost:5173',
      'https://app.example.com',
    ]);
    expect(parseWebOrigins(undefined)).toEqual([]);
    expect(parseWebOrigins('')).toEqual([]);
  });
});

describe('originOf / isAllowedOrigin', () => {
  const allowed = ['http://localhost:5173', 'https://app.example.com'];

  it('accepts an exact Origin match', () => {
    expect(isAllowedOrigin('http://localhost:5173', allowed)).toBe(true);
    expect(isAllowedOrigin('https://app.example.com', allowed)).toBe(true);
  });

  it('accepts a Referer by its origin part', () => {
    expect(isAllowedOrigin('http://localhost:5173/login?next=/', allowed)).toBe(true);
    expect(isAllowedOrigin('https://app.example.com/some/path', allowed)).toBe(true);
  });

  it('rejects other origins, suffix tricks, and missing values', () => {
    expect(isAllowedOrigin('http://localhost:5173.evil.com', allowed)).toBe(false);
    expect(isAllowedOrigin('http://evil-localhost:5173', allowed)).toBe(false);
    expect(isAllowedOrigin('https://localhost:5173', allowed)).toBe(false); // scheme matters
    expect(isAllowedOrigin('http://localhost:5174', allowed)).toBe(false);
    expect(isAllowedOrigin(undefined, allowed)).toBe(false);
    expect(isAllowedOrigin('', allowed)).toBe(false);
    expect(isAllowedOrigin('not a url', allowed)).toBe(false);
  });

  it('originOf returns null for unparseable values', () => {
    expect(originOf(undefined)).toBeNull();
    expect(originOf('garbage')).toBeNull();
    expect(originOf('https://app.example.com/x')).toBe('https://app.example.com');
  });
});

function mockResponse(): {
  res: OriginCheckResponse;
  calls: { status: number[]; body: unknown[] };
} {
  const calls = { status: [] as number[], body: [] as unknown[] };
  const res = {
    status(code: number): OriginCheckResponse {
      calls.status.push(code);
      return res;
    },
    json(body: unknown): void {
      calls.body.push(body);
    },
  };
  return { res, calls };
}

describe('CookieOriginMiddleware', () => {
  const allowed = ['http://localhost:5173'];

  it('passes non-browser requests without a refresh cookie', () => {
    const mw = new CookieOriginMiddleware(allowed);
    let nextCalls = 0;
    mw.use({ headers: {} }, mockResponse().res, () => {
      nextCalls += 1;
    });
    expect(nextCalls).toBe(1);
  });

  it('allows safe GET with a cookie but no Origin', () => {
    let passed = false;
    new CookieOriginMiddleware(allowed).use(
      { method: 'GET', headers: { cookie: 'ff_refresh=abc' } },
      mockResponse().res,
      () => {
        passed = true;
      },
    );
    expect(passed).toBe(true);
  });
  it('rejects hostile login Origin even without a cookie', () => {
    const { res, calls } = mockResponse();
    new CookieOriginMiddleware(allowed).use(
      { method: 'POST', headers: { origin: 'https://hostile.example' } },
      res,
      () => {
        throw new Error('Must reject');
      },
    );
    expect(calls.status).toEqual([403]);
  });

  it('passes a cookie request with an allowed Origin', () => {
    const mw = new CookieOriginMiddleware(allowed);
    let nextCalls = 0;
    const req: OriginCheckRequest = {
      headers: { cookie: 'ff_refresh=abc; other=1', origin: 'http://localhost:5173' },
    };
    mw.use(req, mockResponse().res, () => {
      nextCalls += 1;
    });
    expect(nextCalls).toBe(1);
  });

  it('passes a cookie request with an allowed Referer when Origin is absent', () => {
    const mw = new CookieOriginMiddleware(allowed);
    let nextCalls = 0;
    const req: OriginCheckRequest = {
      headers: { cookie: 'ff_refresh=abc', referer: 'http://localhost:5173/auth/login' },
    };
    mw.use(req, mockResponse().res, () => {
      nextCalls += 1;
    });
    expect(nextCalls).toBe(1);
  });

  it('rejects a cookie request without Origin or Referer', () => {
    const mw = new CookieOriginMiddleware(allowed);
    let nextCalls = 0;
    const { res, calls } = mockResponse();
    mw.use({ headers: { cookie: 'ff_refresh=abc' } }, res, () => {
      nextCalls += 1;
    });
    expect(nextCalls).toBe(0);
    expect(calls.status).toEqual([403]);
    expect(calls.body).toEqual([{ statusCode: 403, message: 'Origin not allowed.' }]);
  });

  it('rejects a cookie request from a disallowed origin', () => {
    const mw = new CookieOriginMiddleware(allowed);
    let nextCalls = 0;
    const { res, calls } = mockResponse();
    mw.use(
      { headers: { cookie: 'ff_refresh=abc', origin: 'https://evil.example.com' } },
      res,
      () => {
        nextCalls += 1;
      },
    );
    expect(nextCalls).toBe(0);
    expect(calls.status).toEqual([403]);
  });
});
