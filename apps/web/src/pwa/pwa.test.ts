import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { createUpdateFlow, shouldCache, SW_CACHE_NAME } from './pwa';

const ORIGIN = 'https://example.test';

describe('manifest', () => {
  it('is valid JSON with required fields', () => {
    const raw = fs.readFileSync(
      path.resolve(__dirname, '../../public/manifest.webmanifest'),
      'utf-8',
    );
    const manifest = JSON.parse(raw) as Record<string, unknown>;
    expect(manifest.name).toBe('FixFlow');
    expect(manifest.short_name).toBe('FixFlow');
    expect(manifest.lang).toBe('ar');
    expect(manifest.dir).toBe('rtl');
    expect(manifest.start_url).toBe('/');
    expect(manifest.scope).toBe('/');
    expect(manifest.display).toBe('standalone');
    expect(manifest.theme_color).toBe('#0f3d2e');
    expect(manifest.background_color).toBe('#f7f3e8');
    const icons = manifest.icons as Array<Record<string, unknown>>;
    expect(icons.some((i) => i.sizes === '192x192')).toBe(true);
    expect(icons.some((i) => i.sizes === '512x512')).toBe(true);
    expect(SW_CACHE_NAME).toBe('fixflow-shell-v1');
  });
});

describe('shouldCache', () => {
  it('caches same-origin static shell and assets', () => {
    expect(shouldCache('https://example.test/', ORIGIN)).toBe(true);
    expect(shouldCache('https://example.test/assets/app-abc123.js', ORIGIN)).toBe(true);
    expect(shouldCache('https://example.test/assets/style-abc123.css', ORIGIN)).toBe(true);
    expect(shouldCache('https://example.test/assets/font-abc123.woff2', ORIGIN)).toBe(true);
    expect(shouldCache('https://example.test/icons/icon-192.png', ORIGIN)).toBe(true);
    expect(shouldCache('https://example.test/icons/icon-512.png', ORIGIN)).toBe(true);
    expect(shouldCache('https://example.test/icons/icon.svg', ORIGIN)).toBe(true);
    expect(shouldCache('https://example.test/offline.html', ORIGIN)).toBe(true);
    expect(shouldCache('https://example.test/manifest.webmanifest', ORIGIN)).toBe(true);
  });
  it('never caches /api, invoices, or photos', () => {
    expect(shouldCache('https://example.test/api/health', ORIGIN)).toBe(false);
    expect(shouldCache('https://example.test/api/invoices/123', ORIGIN)).toBe(false);
    expect(shouldCache('https://example.test/photos/customer-1.jpg', ORIGIN)).toBe(false);
    expect(shouldCache('https://example.test/customer-photos/a.png', ORIGIN)).toBe(false);
    expect(shouldCache('https://example.test/invoices/123.pdf', ORIGIN)).toBe(false);
    expect(shouldCache('https://example.test/uploads/receipt.png', ORIGIN)).toBe(false);
    expect(shouldCache('https://other.test/assets/app.js', ORIGIN)).toBe(false);
  });
  it('never caches arbitrary images, even under /assets/ or /icons/', () => {
    expect(shouldCache('https://example.test/assets/logo.png', ORIGIN)).toBe(false);
    expect(shouldCache('https://example.test/assets/photo.webp', ORIGIN)).toBe(false);
    expect(shouldCache('https://example.test/assets/image.svg', ORIGIN)).toBe(false);
    expect(shouldCache('https://example.test/icons/other.png', ORIGIN)).toBe(false);
    expect(shouldCache('https://example.test/banner.jpg', ORIGIN)).toBe(false);
    expect(shouldCache('https://example.test/app.js', ORIGIN)).toBe(false);
    expect(shouldCache('https://example.test/style.css', ORIGIN)).toBe(false);
  });
});

describe('update flow', () => {
  it('does not activate until the user confirms', () => {
    const flow = createUpdateFlow();
    expect(flow.confirmUpdate()).toBe(false);
    flow.onUpdateFound();
    expect(flow.getState()).toBe('pending');
    expect(flow.confirmUpdate()).toBe(true);
    expect(flow.getState()).toBe('confirmed');
  });
});
