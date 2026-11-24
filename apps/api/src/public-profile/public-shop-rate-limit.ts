import { Injectable, type NestMiddleware } from '@nestjs/common';
import {
  clientIp,
  createRateLimiter,
  PUBLIC_SHOP_MAX_PER_IP,
  PUBLIC_SHOP_WINDOW_MS,
  type RateLimitRequest,
  type RateLimitResponse,
} from '../auth/rate-limit';

/**
 * Per-IP rate limiting for the unauthenticated public shop page
 * (GET /api/public/shops/:slug). Reuses the existing
 * `createRateLimiter` helper — no new limiter was built, no new
 * dependency.
 *
 * Limit: PUBLIC_SHOP_MAX_PER_IP (100) requests per IP per
 * PUBLIC_SHOP_WINDOW_MS (60 s sliding window). Exceeding it returns
 * 429 with a `Retry-After` header and
 * `{ statusCode: 429, message: 'Too many requests.' }`, the same
 * shape as the auth limiter.
 *
 * Memory is BOUNDED: `createRateLimiter` keeps one timestamp array
 * per IP key, sweeps expired entries at most once per window, and
 * hard-caps the map at 10,000 keys — a new key past the cap is
 * denied (fail-closed) instead of growing the map. The bound is per
 * limiter instance; this middleware owns its own instance.
 *
 * MULTI-INSTANCE LIMIT: this is in-memory and per process. With
 * several API instances (or several workers) each instance enforces
 * its own 100/min budget, so the effective limit is
 * `100 × instances` — it is NOT a global limit. A multi-instance
 * deployment that needs a global limit must move this to a shared
 * store (e.g. Redis, a shared token bucket); that integration is
 * deliberately NOT built here. See docs/PUBLIC_PROFILE.md
 * ("Rate limiting").
 *
 * Scoped by `PublicProfileModule.configure()` to
 * `PublicShopController` only, so the owner settings endpoints in
 * the same module are NOT rate-limited by this middleware.
 */
@Injectable()
export class PublicShopRateLimitMiddleware implements NestMiddleware {
  private readonly perIp = createRateLimiter({
    windowMs: PUBLIC_SHOP_WINDOW_MS,
    max: PUBLIC_SHOP_MAX_PER_IP,
  });

  use(req: RateLimitRequest, res: RateLimitResponse, next: () => void): void {
    if (req.method !== 'GET') {
      next();
      return;
    }
    const result = this.perIp.allow(`public-shop:${clientIp(req)}`, Date.now());
    if (!result.allowed) {
      res.setHeader('Retry-After', String(result.retryAfterSeconds));
      res.status(429).json({ statusCode: 429, message: 'Too many requests.' });
      return;
    }
    next();
  }
}
