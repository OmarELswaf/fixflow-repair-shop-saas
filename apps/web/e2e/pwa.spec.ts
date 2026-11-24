import { test, expect } from '@playwright/test';

// Playwright e2e — REQUIRES a real browser and a production build.
// Do not run this against the Vite dev server and do not claim it passed
// until it has actually run. Playwright itself is not in the pinned
// Phase 2 dependency list; the parent must add a pinned version
// before running this file, or run it as a documented manual check.
test.describe('PWA', () => {
  test('manifest is reachable', async ({ request }) => {
    const res = await request.get('/manifest.webmanifest');
    expect(res.ok()).toBeTruthy();
    const manifest = await res.json();
    expect(manifest.name).toBe('FixFlow');
    expect(manifest.lang).toBe('ar');
  });

  test('service worker registers and app loads offline shell', async ({ page }) => {
    await page.goto('/');
    const registered = await page.evaluate(async () => {
      if (!('serviceWorker' in navigator)) return false;
      const reg = await navigator.serviceWorker.getRegistration();
      return Boolean(reg);
    });
    expect(registered).toBe(true);
    // Offline shell: go offline and reload a navigation request.
    await page.context().setOffline(true);
    await page.goto('/offline.html');
    await expect(page.locator('body')).toContainText('FixFlow');
  });

  test('no /api response is served from cache', async ({ page }) => {
    await page.goto('/');
    const res = await page.evaluate(async () => {
      const r = await fetch('/api/health');
      return { fromCache: r.headers.get('x-fixflow-cache') ?? null, ok: r.ok };
    });
    expect(res.ok).toBe(true);
    expect(res.fromCache).toBeNull();
  });
});
