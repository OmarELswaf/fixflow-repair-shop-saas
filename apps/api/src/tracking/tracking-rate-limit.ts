import { Injectable, type NestMiddleware } from '@nestjs/common';
import {
  clientIp,
  createRateLimiter,
  type RateLimitRequest,
  type RateLimitResponse,
} from '../auth/rate-limit';

/** Public tracking lookups: 60 per minute per IP (in-memory, per process). */
export const TRACKING_MAX_PER_IP = 60;
export const TRACKING_WINDOW_MS = 60 * 1000;

@Injectable()
export class TrackingRateLimitMiddleware implements NestMiddleware {
  private readonly perIp = createRateLimiter({
    windowMs: TRACKING_WINDOW_MS,
    max: TRACKING_MAX_PER_IP,
  });

  use(req: RateLimitRequest, res: RateLimitResponse, next: () => void): void {
    const result = this.perIp.allow(`track:${clientIp(req)}`, Date.now());
    if (!result.allowed) {
      res.setHeader('Retry-After', String(result.retryAfterSeconds));
      res.status(429).json({ statusCode: 429, message: 'Too many requests.' });
      return;
    }
    next();
  }
}
