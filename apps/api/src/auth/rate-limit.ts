import { Injectable, type NestMiddleware } from '@nestjs/common';

/**
 * Hand-written sliding-window rate limiter. No new dependency.
 *
 * In-memory only, per process: it is NOT distributed. With several
 * API instances (or several workers) each instance enforces its own
 * budget, so the effective limit is `max × instances`. That is
 * acceptable for a single-instance deployment and for the test
 * harness; a multi-instance deployment must move this to Redis
 * (e.g. a shared token bucket) before relying on the limits.
 */

export interface RateLimiterOptions {
  /** Window length in milliseconds. */
  windowMs: number;
  /** Maximum allowed attempts inside one window. */
  max: number;
}

export interface RateLimitResult {
  allowed: boolean;
  /** Seconds to wait before retrying; 0 when allowed. */
  retryAfterSeconds: number;
}

export interface RateLimiter {
  allow(key: string, now: number): RateLimitResult;
}

/**
 * Pure sliding-window limiter. `now` is milliseconds (Date.now()).
 * Attempts older than `windowMs` fall out of the window; the
 * retry-after is computed from the oldest attempt still in the
 * window, so a client is told exactly when the next attempt is due.
 */
export function createRateLimiter({ windowMs, max }: RateLimiterOptions): RateLimiter {
  const hits = new Map<string, number[]>();
  let lastSweep = 0;
  return {
    allow(key: string, now: number): RateLimitResult {
      if (now - lastSweep >= windowMs) {
        for (const [entry, values] of hits) {
          if (!values.length || values[values.length - 1] <= now - windowMs) hits.delete(entry);
        }
        lastSweep = now;
      }
      if (!hits.has(key) && hits.size >= 10000)
        return { allowed: false, retryAfterSeconds: Math.ceil(windowMs / 1000) };
      let timestamps = hits.get(key);
      if (!timestamps) {
        timestamps = [];
        hits.set(key, timestamps);
      }
      const cutoff = now - windowMs;
      while (timestamps.length > 0 && timestamps[0] <= cutoff) timestamps.shift();
      if (timestamps.length >= max) {
        const retryAfterSeconds = Math.max(1, Math.ceil((timestamps[0] + windowMs - now) / 1000));
        return { allowed: false, retryAfterSeconds };
      }
      timestamps.push(now);
      return { allowed: true, retryAfterSeconds: 0 };
    },
  };
}

export const LOGIN_WINDOW_MS = 15 * 60 * 1000;
export const LOGIN_MAX_PER_ACCOUNT = 5;
export const LOGIN_MAX_PER_IP = 20;
export const REGISTER_WINDOW_MS = 60 * 60 * 1000;
export const REGISTER_MAX_PER_IP = 5;
export const REFRESH_WINDOW_MS = 60 * 1000;
export const REFRESH_MAX_PER_IP = 30;

/**
 * Public shop page (GET /api/public/shops/:slug). Unauthenticated
 * and read-heavy, so the budget is generous: a human visitor loads
 * the page once, and even repeated refreshes stay far below this.
 * 100/min per IP still bounds scraping (6,000/hour per IP) and is
 * in line with the other per-IP limits above (refresh is 30/min).
 * Enforced by PublicShopRateLimitMiddleware, which reuses
 * createRateLimiter — see apps/api/src/public-profile/
 * public-shop-rate-limit.ts and docs/PUBLIC_PROFILE.md
 * ("Rate limiting") for the memory bound and multi-instance limit.
 */
export const PUBLIC_SHOP_WINDOW_MS = 60 * 1000;
export const PUBLIC_SHOP_MAX_PER_IP = 100;

/** Minimal shape of the request/response the middleware touches. */
export interface RateLimitRequest {
  method?: string;
  path?: string;
  url?: string;
  body?: { email?: unknown } | null;
  ip?: string;
  socket?: { remoteAddress?: string };
}

export interface RateLimitResponse {
  setHeader(name: string, value: string): void;
  status(code: number): RateLimitResponse;
  json(body: unknown): void;
}

export function normalizeRateLimitEmail(email: unknown): string {
  return typeof email === 'string' ? email.trim().toLowerCase() : '';
}

export function clientIp(req: RateLimitRequest): string {
  return req.ip ?? req.socket?.remoteAddress ?? 'unknown';
}

/**
 * Auth rate-limit middleware. Applied to the auth routes in
 * AuthModule.configure(). Limits (see docs/AUTH.md "Rate limits"):
 * - POST /auth/login: 5 / 15 min per (IP + normalized email) AND
 *   20 / 15 min per IP.
 * - POST /auth/register: 5 / hour per IP.
 * - POST /auth/refresh: 30 / min per IP.
 * Other auth routes pass through untouched. Exceeding a limit
 * returns 429 with a Retry-After header and
 * `{ statusCode: 429, message: 'Too many requests.' }`.
 */
@Injectable()
export class AuthRateLimitMiddleware implements NestMiddleware {
  private readonly loginPerAccount = createRateLimiter({
    windowMs: LOGIN_WINDOW_MS,
    max: LOGIN_MAX_PER_ACCOUNT,
  });
  private readonly loginPerIp = createRateLimiter({
    windowMs: LOGIN_WINDOW_MS,
    max: LOGIN_MAX_PER_IP,
  });
  private readonly registerPerIp = createRateLimiter({
    windowMs: REGISTER_WINDOW_MS,
    max: REGISTER_MAX_PER_IP,
  });
  private readonly refreshPerIp = createRateLimiter({
    windowMs: REFRESH_WINDOW_MS,
    max: REFRESH_MAX_PER_IP,
  });

  use(req: RateLimitRequest, res: RateLimitResponse, next: () => void): void {
    if (req.method !== 'POST') {
      next();
      return;
    }
    const path = req.path ?? req.url ?? '';
    const ip = clientIp(req);
    let result: RateLimitResult | null = null;
    if (path.endsWith('/auth/login')) {
      const email = normalizeRateLimitEmail(req.body?.email);
      result = this.loginPerAccount.allow(`login:${ip}:${email}`, Date.now());
      if (!result.allowed) {
        this.deny(res, result.retryAfterSeconds);
        return;
      }
      result = this.loginPerIp.allow(`login-ip:${ip}`, Date.now());
    } else if (path.endsWith('/auth/register')) {
      result = this.registerPerIp.allow(`register:${ip}`, Date.now());
    } else if (path.endsWith('/auth/refresh')) {
      result = this.refreshPerIp.allow(`refresh:${ip}`, Date.now());
    } else {
      next();
      return;
    }
    if (!result.allowed) {
      this.deny(res, result.retryAfterSeconds);
      return;
    }
    next();
  }

  private deny(res: RateLimitResponse, retryAfterSeconds: number): void {
    res.setHeader('Retry-After', String(retryAfterSeconds));
    res.status(429).json({ statusCode: 429, message: 'Too many requests.' });
  }
}
