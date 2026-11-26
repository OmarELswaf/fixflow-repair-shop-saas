/* global console, process, URL, fetch, setTimeout */
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';
import assert from 'node:assert/strict';
import { setupHttpTestDb } from './http-test-db.mjs';
process.chdir(fileURLToPath(new URL('../', import.meta.url)));

// Public landing page at /welcome served by the real built server.
// Run: npm run test:welcome:http (needs the web app built into apps/web/dist)
const db = await setupHttpTestDb({ port: 15439 });
const port = 3911;
const child = spawn('node', ['apps/api/dist/main.js'], {
  env: {
    ...process.env,
    NODE_ENV: 'test',
    PORT: String(port),
    JWT_ACCESS_SECRET: 'test-only-access-secret-not-for-production-use',
    JWT_REFRESH_SECRET: 'test-only-refresh-secret-not-for-production-use',
    WEB_DIST_DIR: resolve('apps/web/dist'),
  },
  stdio: ['ignore', 'ignore', 'inherit'],
});
try {
  const base = `http://127.0.0.1:${port}`;
  for (let i = 0; i < 60; i++) {
    try {
      if ((await fetch(`${base}/api/health`)).ok) break;
    } catch {
      /* not up yet */
    }
    await new Promise((r) => setTimeout(r, 500));
  }
  for (const p of ['/welcome', '/welcome/']) {
    const r = await fetch(base + p);
    const html = await r.text();
    assert.equal(r.status, 200, p);
    assert.match(html, /FixFlow/);
    assert.ok(html.includes('/welcome/v/marketing.mp4'));
    assert.ok(!html.includes('نسخة تجريبية'), 'no demo-version wording');
    assert.equal(r.headers.get('x-content-type-options'), 'nosniff');
  }
  console.log('PASS /welcome and /welcome/ serve the landing page');
  for (const [p, type] of [
    ['/welcome/fonts/ibm-plex-sans-arabic-arabic-400-normal.woff2', 'font/woff2'],
    ['/welcome/p/marketing.jpg', 'image/jpeg'],
    ['/welcome/v/guide-4.mp4', 'video/mp4'],
  ]) {
    const r = await fetch(base + p);
    assert.equal(r.status, 200, p);
    assert.ok((r.headers.get('content-type') || '').includes(type), p);
  }
  const range = await fetch(`${base}/welcome/v/marketing.mp4`, {
    headers: { Range: 'bytes=0-99' },
  });
  assert.equal(range.status, 206);
  console.log('PASS assets served with correct types; video supports range requests');
  const spa = await (await fetch(`${base}/login`)).text();
  assert.ok(!spa.includes('/welcome/v/'), 'existing SPA routes unchanged');
  assert.equal((await fetch(`${base}/api/health`)).status, 200);
  assert.equal((await fetch(`${base}/api/welcome`)).status, 404);
  console.log('PASS existing app routes and API unchanged');
} catch (e) {
  console.error('Welcome harness failed:', e);
  process.exitCode = 1;
} finally {
  child.kill();
  await db.stop();
}
