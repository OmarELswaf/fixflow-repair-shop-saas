/**
 * Refresh-token cookie helpers (pure). The browser token design is
 * documented in docs/AUTH.md "Browser token design":
 * - The refresh token is delivered as an HttpOnly cookie. Only non-browser
 *   requests without Origin, Referer or cookies also receive JSON refresh tokens.
 * - The web UI never reads or stores the JSON refresh token; it
 *   relies on the cookie plus an in-memory access token. No
 *   localStorage refresh token, ever.
 * - The access token stays in JSON only.
 */

export const REFRESH_COOKIE_NAME = 'ff_refresh';

/** Parse a Cookie header into name → value. Malformed pairs are skipped. */
export function parseCookies(header: string | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  if (!header) return out;
  for (const part of header.split(';')) {
    const idx = part.indexOf('=');
    if (idx <= 0) continue;
    const name = part.slice(0, idx).trim();
    const raw = part.slice(idx + 1).trim();
    if (!name) continue;
    try {
      out[name] = decodeURIComponent(raw);
    } catch {
      out[name] = raw;
    }
  }
  return out;
}

/**
 * Build a Set-Cookie value for the refresh token. SameSite=Lax,
 * Path=/api/auth (the cookie is only sent to auth endpoints),
 * Max-Age = refresh TTL in seconds. Secure only in production, so
 * plain-HTTP local development still works.
 */
export function refreshCookieHeader(token: string, maxAgeSeconds: number, secure: boolean): string {
  const parts = [
    `${REFRESH_COOKIE_NAME}=${token}`,
    'HttpOnly',
    'SameSite=Lax',
    'Path=/api/auth',
    `Max-Age=${maxAgeSeconds}`,
  ];
  if (secure) parts.push('Secure');
  return parts.join('; ');
}

/** Build a Set-Cookie value that clears the refresh cookie. */
export function clearRefreshCookieHeader(secure: boolean): string {
  const parts = [
    `${REFRESH_COOKIE_NAME}=`,
    'HttpOnly',
    'SameSite=Lax',
    'Path=/api/auth',
    'Max-Age=0',
  ];
  if (secure) parts.push('Secure');
  return parts.join('; ');
}
