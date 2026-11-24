import { Inject, Injectable, type NestMiddleware } from '@nestjs/common';
import { parseCookies, REFRESH_COOKIE_NAME } from './cookies';

/** DI token for the parsed WEB_ORIGINS allowlist. */
export const WEB_ORIGINS = Symbol('WEB_ORIGINS');

/** Parse a comma-separated WEB_ORIGINS env value into a list. */
export function parseWebOrigins(value: string | undefined): string[] {
  if (!value) return [];
  return value
    .split(',')
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
}

/** Origin of a header value (Origin or Referer); null when unparseable. */
export function originOf(value: string | undefined): string | null {
  if (!value) return null;
  try {
    return new URL(value).origin;
  } catch {
    return null;
  }
}

/**
 * Exact-match origin check. `origin` may be an Origin header value
 * or a Referer header value (a full URL with a path) — only its
 * origin part is compared against the allowlist. No wildcards,
 * no suffix matching, no scheme downgrade.
 */
export function isAllowedOrigin(
  origin: string | undefined,
  allowedOrigins: readonly string[],
): boolean {
  const candidate = originOf(origin);
  if (candidate === null) return false;
  return allowedOrigins.includes(candidate);
}

/** Minimal shape of the request/response the middleware touches. */
export interface OriginCheckRequest {
  method?: string;
  headers?: {
    cookie?: string;
    origin?: string | string[];
    referer?: string | string[];
  };
}

export interface OriginCheckResponse {
  status(code: number): OriginCheckResponse;
  json(body: unknown): void;
}

/**
 * CSRF/Origin middleware for cookie-authenticated auth mutations.
 * Applied to the auth routes in AuthModule.configure().
 *
 * Safe methods pass through because they do not mutate cookie state.
 * Any supplied hostile Origin is rejected, including login/register
 * without an existing cookie (login CSRF). Cookie mutations require
 * an allowed Origin or Referer. Non-browser requests without a cookie
 * or Origin can use the explicit JSON-token flow.
 */
@Injectable()
export class CookieOriginMiddleware implements NestMiddleware {
  constructor(@Inject(WEB_ORIGINS) private readonly allowedOrigins: readonly string[]) {}

  use(req: OriginCheckRequest, res: OriginCheckResponse, next: () => void): void {
    if (['GET', 'HEAD', 'OPTIONS'].includes(req.method ?? 'POST')) {
      next();
      return;
    }
    const cookies = parseCookies(req.headers?.cookie);
    const providedOrigin = req.headers?.origin;
    if (
      providedOrigin &&
      !isAllowedOrigin(
        Array.isArray(providedOrigin) ? providedOrigin[0] : providedOrigin,
        this.allowedOrigins,
      )
    ) {
      res.status(403).json({ statusCode: 403, message: 'Origin not allowed.' });
      return;
    }
    if (!cookies[REFRESH_COOKIE_NAME]) {
      next();
      return;
    }
    const raw = req.headers?.origin ?? req.headers?.referer;
    const origin = Array.isArray(raw) ? raw[0] : raw;
    if (!isAllowedOrigin(origin, this.allowedOrigins)) {
      res.status(403).json({ statusCode: 403, message: 'Origin not allowed.' });
      return;
    }
    next();
  }
}
