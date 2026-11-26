import { Injectable, type NestMiddleware } from '@nestjs/common';
import {
  clientIp,
  createRateLimiter,
  type RateLimitRequest,
  type RateLimitResponse,
} from '../auth/rate-limit';

/** Public estimate pages: 60 per minute per IP (in-memory, per process). */
@Injectable()
export class ApprovalsRateLimitMiddleware implements NestMiddleware {
  private readonly perIp = createRateLimiter({ windowMs: 60 * 1000, max: 60 });

  use(req: RateLimitRequest, res: RateLimitResponse, next: () => void): void {
    const result = this.perIp.allow(`approve:${clientIp(req)}`, Date.now());
    if (!result.allowed) {
      res.setHeader('Retry-After', String(result.retryAfterSeconds));
      res.status(429).json({ statusCode: 429, message: 'Too many requests.' });
      return;
    }
    next();
  }
}
