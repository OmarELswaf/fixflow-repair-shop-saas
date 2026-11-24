/**
 * PWA helpers — pure logic, unit-tested in pwa.test.ts.
 * The service worker (public/sw.js) is the hand-written copy of
 * shouldCache() and must stay in sync with it.
 */

/** True only for same-origin static shell/assets. False for /api, invoices, photos. */
export function shouldCache(url: string, origin: string): boolean {
  let parsed: URL;
  try {
    parsed = new URL(url, origin);
  } catch {
    return false;
  }
  if (parsed.origin !== origin) return false;
  const path = parsed.pathname;
  if (parsed.search || parsed.hash) return false;
  if (path === '/' || path === '/offline.html' || path === '/manifest.webmanifest') return true;
  if (/^\/assets\/[a-zA-Z0-9_/-]+\.(js|css|woff2?)$/.test(path)) return true;
  if (/^\/icons\/icon-(192|512)\.png$/.test(path) || path === '/icons/icon.svg') return true;
  return false;
}

export type UpdateState = 'none' | 'pending' | 'confirmed';

export function createUpdateFlow() {
  let state: UpdateState = 'none';
  return {
    getState: (): UpdateState => state,
    onUpdateFound: (): void => {
      state = 'pending';
    },
    /** Only called after the user confirms. Returns true if activation may proceed. */
    confirmUpdate: (): boolean => {
      if (state !== 'pending') return false;
      state = 'confirmed';
      return true;
    },
    dismiss: (): void => {
      state = 'none';
    },
  };
}

export const SW_CACHE_NAME = 'fixflow-shell-v1';
export const SW_VERSION = 'v1';
