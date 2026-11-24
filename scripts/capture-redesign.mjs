/* global process, console, document, innerWidth, localStorage, sessionStorage, navigator, URL, fetch, performance, window */
// Local-only real browser integration review. No production accounts or services.
//
// MATCHED BEFORE/AFTER SCREENSHOTS (Phase 10 redesign):
// The "MATCHED BEFORE/AFTER screenshots" section near the end of this file
// captures the same fixture-driven shots on every run — dashboard, repairs
// list, repair detail and reports at 390px, dashboard and repair detail at
// 320px, dashboard and reports at desktop 1280px, plus the mobile drawer
// when the build has one — into /downloads/fixflow-matched-<page>-<width>-<tag>.png.
// To compare: run on the Phase 9 build with SHOT_TAG=before, then on the
// redesigned build with SHOT_TAG=after (the default), and compare the
// matched pairs (same fixture, same viewports, same waits). Report
// timestamps ("as of", repair dates) differ between runs by design —
// compare layout, hierarchy, navigation and density, not pixels.
// The drawer shot is skipped on builds without the new mobile menu button;
// every other matched shot exists on both builds.
const shotTag = process.env.SHOT_TAG || 'after';
import { PGlite } from '@electric-sql/pglite';
import { PGLiteSocketServer } from '@electric-sql/pglite-socket';
import { readFileSync, readdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { createRequire } from 'node:module';
import { preview } from 'vite';
import { chromium } from 'playwright';
const require = createRequire(import.meta.url);
process.env.DATABASE_URL =
  'postgresql://fixflow_test_app@127.0.0.1:15435/postgres?connection_limit=1';
process.env.JWT_ACCESS_SECRET = 'test-only-secret-not-for-production';
process.env.JWT_REFRESH_SECRET = 'test-only-refresh-not-for-production';
process.env.NODE_ENV = 'test';
process.env.DB_POOL_MAX = '1';
process.env.WEB_ORIGINS = 'http://localhost:5173';
let app, socket, web, browser;
const db = new PGlite();

try {
  for (const d of readdirSync('apps/api/prisma/migrations')
    .filter((d) => /^\d/.test(d))
    .sort())
    await db.exec(readFileSync(resolve('apps/api/prisma/migrations', d, 'migration.sql'), 'utf8'));
  await db.exec(
    'CREATE ROLE fixflow_test_app LOGIN NOSUPERUSER NOBYPASSRLS; GRANT USAGE ON SCHEMA public TO fixflow_test_app; GRANT SELECT,INSERT,UPDATE,DELETE ON ALL TABLES IN SCHEMA public TO fixflow_test_app; SET ROLE fixflow_test_app;',
  );
  socket = new PGLiteSocketServer({ db, port: 15435, host: '127.0.0.1' });
  await socket.start();
  const { Test } = require('@nestjs/testing');
  const { AuthModule } = require('../apps/api/dist/auth/auth.module');
  const { CustomersModule } = require('../apps/api/dist/customers/customers.module');
  const { RepairsModule } = require('../apps/api/dist/repairs/repairs.module');
  const { InventoryModule } = require('../apps/api/dist/inventory/inventory.module');
  const { ReportsModule } = require('../apps/api/dist/reports/reports.module');
  const { AdminModule } = require('../apps/api/dist/admin/admin.module');
  const { HealthController } = require('../apps/api/dist/health/health.controller');
  const { PublicProfileModule } = require('../apps/api/dist/public-profile/public-profile.module');
  const mod = await Test.createTestingModule({
    controllers: [HealthController],
    providers: [
      {
        provide: 'REDIS_CONNECTION',
        useValue: {
          ping: async () => {
            throw new Error('Redis not available in visual fixture');
          },
        },
      },
    ],
    imports: [
      AuthModule,
      CustomersModule,
      RepairsModule,
      InventoryModule,
      ReportsModule,
      AdminModule,
      PublicProfileModule,
    ],
  }).compile();
  app = mod.createNestApplication();
  app.setGlobalPrefix('api');
  await app.listen(3000);
  web = await preview({
    configFile: resolve('apps/web/vite.config.ts'),
    root: resolve('apps/web'),
    preview: { port: 5173, strictPort: true, proxy: { '/api': 'http://localhost:3000' } },
  });

  browser = await chromium.launch({
    executablePath: '/usr/bin/google-chrome',
    args: ['--no-sandbox'],
  });
  const context = await browser.newContext({ viewport: { width: 1365, height: 950 } });
  const page = await context.newPage();
  const errors = [];
  const failures = [];
  page.on('response', async (r) => {
    if (r.url().includes('/api/auth/') && r.status() >= 400)
      console.log('AUTH FAIL', r.status(), r.url(), await r.text());
    if (r.url().includes('/api/') && r.status() >= 500) failures.push(r.status() + ' ' + r.url());
  });
  page.on('pageerror', (e) => errors.push(e.message));

  // --- Network profiling: actual JS requests + transferred bytes ---
  // A fresh page loads the app shell; capture every script response
  // and the resource-timing entries, then print the table. This is
  // the network view of the initial JS (scripts/measure-initial-js.mjs
  // is the file-size view of the same assets).
  const perfPage = await browser.newPage({ viewport: { width: 1365, height: 950 } });
  const jsResponses = [];
  perfPage.on('response', (r) => {
    if (r.request().resourceType() === 'script') jsResponses.push(`${r.status()} ${r.url()}`);
  });
  await perfPage.goto('http://localhost:5173/', { waitUntil: 'domcontentloaded' });
  await perfPage.waitForLoadState('load');
  const perfEntries = await perfPage.evaluate(() =>
    performance
      .getEntriesByType('resource')
      .filter((e) => e.initiatorType === 'script' || /\.js($|\?)/.test(e.name))
      .map((e) => ({
        name: new URL(e.name).pathname,
        transferSize: e.transferSize,
        encodedBodySize: e.encodedBodySize,
        decodedBodySize: e.decodedBodySize,
      })),
  );
  console.log('Initial JS network table (fresh page load):');
  for (const e of perfEntries)
    console.log(
      `  ${e.name} transfer=${e.transferSize} encoded=${e.encodedBodySize} decoded=${e.decodedBodySize}`,
    );
  console.log(
    `  TOTAL transfer=${perfEntries.reduce((s, e) => s + e.transferSize, 0)} decoded=${perfEntries.reduce((s, e) => s + e.decodedBodySize, 0)}`,
  );
  console.log('Script responses:');
  for (const line of jsResponses) console.log(`  ${line}`);
  await perfPage.close();

  await page.goto('http://localhost:5173/register');
  await page.getByLabel('اسمك', { exact: true }).fill('مالك تجريبي');
  await page.getByLabel(/البريد الإلكتروني/).fill('ui-review@example.test');
  await page.getByLabel(/كلمة المرور/).fill('local-review-only-pass');
  await page.getByLabel(/اسم الورشة/).fill('ورشة الاختبار');
  await page.getByLabel(/اسم الفرع/).fill('الفرع الرئيسي');
  await page.getByRole('button', { name: 'إنشاء الحساب والبدء' }).click();
  await page.waitForURL('http://localhost:5173/');
  await page.getByRole('link', { name: 'العملاء', exact: true }).click();
  await page.getByLabel(/اسم العميل/).fill('عميل اختبار');
  await page.getByLabel('الهاتف (اختياري)', { exact: true }).fill('+201001234567');
  await page.getByRole('button', { name: 'إنشاء العميل', exact: true }).click();
  await page.getByRole('link', { name: 'عميل اختبار', exact: true }).click();
  await page.getByRole('heading', { name: 'عميل اختبار' }).waitFor();
  await page.getByLabel(/الماركة/).fill('Samsung');
  await page.getByLabel(/الموديل/).fill('A54');
  await page.getByRole('button', { name: 'إضافة الجهاز', exact: true }).click();
  await page.getByText('Samsung A54', { exact: true }).waitFor();
  await page.getByRole('link', { name: 'قطع الغيار', exact: true }).click();
  await page.getByLabel(/رمز القطعة/).fill('SCREEN-A54');
  await page.getByLabel(/اسم القطعة/).fill('شاشة سامسونج');
  await page.getByRole('button', { name: 'إنشاء القطعة', exact: true }).click();
  await page.getByText('تم إنشاء القطعة.', { exact: true }).waitFor();
  await page.getByRole('link', { name: 'المخزون', exact: true }).click();
  await page.getByRole('combobox', { name: 'الفرع', exact: true }).last().click();
  await page.getByRole('option', { name: 'الفرع الرئيسي', exact: true }).click();
  await page.getByRole('combobox', { name: 'اختر القطعة', exact: true }).fill('SCREEN');
  await page.getByRole('option', { name: /SCREEN-A54/ }).click();
  await page.getByLabel(/التغيير/).fill('10');
  const adjustRequest = page.waitForRequest(
    (r) => r.url().endsWith('/api/stock/adjust') && r.method() === 'POST',
  );
  await page.getByRole('button', { name: 'تعديل', exact: true }).click();
  const adjustReq = await adjustRequest;
  const adjustKey = adjustReq.postDataJSON().idempotencyKey;
  if (typeof adjustKey !== 'string' || !adjustKey)
    throw new Error('Adjust idempotency key missing');
  await page.getByRole('alert').filter({ hasText: 'تم تعديل المخزون.' }).waitFor();
  await page.getByRole('link', { name: 'الإصلاحات', exact: true }).click();
  await page.getByLabel('ابحث عن عميل بالاسم أو الهاتف…', { exact: true }).fill('عميل');
  await page.getByRole('option', { name: /عميل اختبار/ }).click();
  await page.getByRole('combobox', { name: 'الجهاز', exact: true }).click();
  await page.getByRole('option', { name: 'Samsung A54' }).click();
  await page.getByRole('combobox', { name: 'الفرع', exact: true }).last().click();
  await page.getByRole('option', { name: 'الفرع الرئيسي', exact: true }).click();
  await page.getByLabel(/وصف المشكلة/).fill('الشاشة لا تعمل');
  const created = page.waitForResponse(
    (r) => r.url().endsWith('/api/repairs') && r.request().method() === 'POST',
  );
  await page.getByRole('button', { name: 'إنشاء طلب الإصلاح', exact: true }).click();
  const result = await (await created).json();
  if (!result.id) throw new Error('Repair creation failed');
  await page.getByRole('link', { name: result.id, exact: true }).click();
  await page.getByRole('heading', { name: 'تفاصيل الإصلاح', exact: true, level: 1 }).waitFor();
  await page.getByRole('button', { name: 'قيد التشخيص', exact: true }).click();
  await page.getByText('قيد التشخيص', { exact: true }).first().waitFor();
  await page.getByText(/تاريخ الإصدار/).waitFor();
  await page.getByRole('button', { name: 'بانتظار الموافقة', exact: true }).waitFor();
  await page.getByRole('combobox', { name: 'اختر القطعة', exact: true }).fill('SCREEN');
  await page.getByRole('option', { name: /SCREEN-A54/ }).click();
  await page.getByLabel(/الكمية/).fill('2');
  await page.getByRole('button', { name: 'حجز', exact: true }).click();
  await page.getByRole('button', { name: 'استهلاك', exact: true }).waitFor();
  await page.getByRole('button', { name: 'استهلاك', exact: true }).click();
  await page.getByText('تم استهلاك القطعة.', { exact: true }).waitFor();
  await page.getByText(/مستهلكة/).waitFor();
  const reservedCheck = page.waitForResponse(
    (r) => r.url().includes('/api/stock?') && r.status() === 200,
  );
  await page.getByRole('combobox', { name: 'اختر القطعة', exact: true }).fill('SCREEN');
  await page.getByRole('option', { name: /SCREEN-A54/ }).click();
  await page.getByLabel(/الكمية/).fill('1');
  await page.getByRole('button', { name: 'حجز', exact: true }).click();
  await reservedCheck;
  await page.getByRole('button', { name: 'تحرير', exact: true }).click();
  await page.getByText('تم تحرير القطعة.', { exact: true }).waitFor();
  await page.getByText(/مُحررة/).waitFor();
  // The repair page's own action buttons must be identical on desktop and
  // mobile. Scoped to <main>: the shell chrome legitimately differs by
  // width (bottom navigation on a phone, sidebar on desktop).
  const desktopButtons = await page
    .locator('main')
    .last()
    .getByRole('button')
    .filter({ visible: true })
    .allTextContents();
  if ((await page.locator('time').count()) < 3) throw new Error('Dates missing');
  if ((await page.locator('time').allTextContents()).some((t) => /T\d{2}:/.test(t)))
    throw new Error('Raw date displayed');
  await page.evaluate(() => window.scrollTo(0, 0));
  await page.screenshot({ path: '/downloads/fixflow-phase8-desktop.png', fullPage: true });
  await page.setViewportSize({ width: 390, height: 844 });
  await page.evaluate(() => window.scrollTo(0, 0));
  await page.screenshot({ path: '/downloads/fixflow-phase8-mobile.png', fullPage: true });
  const mobileButtons = await page
    .locator('main')
    .last()
    .getByRole('button')
    .filter({ visible: true })
    .allTextContents();
  if (JSON.stringify(desktopButtons) !== JSON.stringify(mobileButtons))
    throw new Error(
      'Responsive status button mismatch ' + JSON.stringify({ desktopButtons, mobileButtons }),
    );
  if (await page.evaluate(() => document.documentElement.scrollWidth > innerWidth))
    throw new Error('Mobile horizontal overflow');
  await page.reload();
  await page.getByRole('heading', { name: 'تفاصيل الإصلاح', exact: true, level: 1 }).waitFor();
  const caches = await page.evaluate(async () => ({
    local: Object.keys(localStorage),
    session: Object.keys(sessionStorage),
    jsCookie: document.cookie,
  }));
  if (caches.local.some((k) => /token/i.test(k)) || /ff_refresh/.test(caches.jsCookie))
    throw new Error('Browser secret exposed');
  await page.evaluate(async () => {
    await navigator.serviceWorker.ready;
  });
  const cachedUrls = await page.evaluate(async () => {
    const all = [];
    for (const key of await caches.keys()) {
      for (const req of await (await caches.open(key)).keys()) all.push(req.url);
    }
    return all;
  });
  if (cachedUrls.some((url) => new URL(url).pathname.startsWith('/api')))
    throw new Error('Private API cached');
  const manifest = await (
    await page.request.get('http://localhost:5173/manifest.webmanifest')
  ).json();
  if (manifest.name !== 'FixFlow' || manifest.lang !== 'ar') throw new Error('Manifest invalid');
  await page.context().setOffline(true);
  await page.goto('http://localhost:5173/offline.html');
  await page
    .getByText(/FixFlow/)
    .first()
    .waitFor();
  await page.context().setOffline(false);
  await page.goto('http://localhost:5173/repairs/' + result.id);
  await page.getByRole('heading', { name: 'تفاصيل الإصلاح', exact: true, level: 1 }).waitFor();
  console.log(
    'PASS production PWA: manifest, active service worker, offline fallback, no API responses cached',
  );
  await page.setViewportSize({ width: 1365, height: 950 });
  await page.goto('http://localhost:5173/reports');
  await page.getByRole('heading', { level: 1 }).waitFor();
  await page.getByText('SCREEN-A54', { exact: true }).filter({ visible: true }).waitFor();
  await page.evaluate(() => window.scrollTo(0, 0));
  await page.screenshot({ path: '/downloads/fixflow-phase8-reports-desktop.png', fullPage: true });
  await page.setViewportSize({ width: 390, height: 844 });
  await page.evaluate(() => window.scrollTo(0, 0));
  await page.screenshot({ path: '/downloads/fixflow-phase8-reports-mobile.png', fullPage: true });
  if (await page.evaluate(() => document.documentElement.scrollWidth > innerWidth))
    throw new Error('Reports mobile overflow');
  await page.goto('http://localhost:5173/team');
  await page
    .getByText('ui-review@example.test', { exact: true })
    .filter({ visible: true })
    .waitFor();
  await page.evaluate(() => window.scrollTo(0, 0));
  await page.screenshot({ path: '/downloads/fixflow-phase8-team-mobile.png', fullPage: true });
  if (await page.evaluate(() => document.documentElement.scrollWidth > innerWidth))
    throw new Error('Team mobile overflow');
  console.log('PASS real reports and team pages with live API, desktop/mobile');

  if (!process.env.SKIP_MATCHED_SHOTS) {
    // --- MATCHED BEFORE/AFTER screenshots (Phase 10 redesign) ---
    // Same fixture, same viewports, same waits on every run, so the
    // reviewer can compare the Phase 9 build (SHOT_TAG=before) with the
    // redesigned build (SHOT_TAG=after, the default) pair by pair. The
    // fixture is the one built above: one shop, one customer/device/part,
    // one repair with a consumed and a released part line, stock adjusted
    // to 10 then -2 consumed. Timestamps on the page ("as of", repair
    // dates) differ between runs — compare layout, hierarchy, navigation
    // and density, not pixels. The drawer shot only exists on builds
    // with the new mobile navigation; the other shots exist on both.
    async function matchedShot(name, url, width, height, waitFor) {
      await page.setViewportSize({ width, height });
      await page.goto(url);
      await waitFor();
      await page.waitForTimeout(300);
      if (await page.evaluate(() => document.documentElement.scrollWidth > innerWidth))
        throw new Error(
          `Matched shot overflow at ${width}px: ${name} ` +
            JSON.stringify(
              await page.evaluate(() =>
                [...document.querySelectorAll('body *')]
                  .filter(
                    (e) =>
                      e.getBoundingClientRect().right > innerWidth + 1 ||
                      e.getBoundingClientRect().left < -1,
                  )
                  .slice(-20)
                  .map((e) => ({
                    tag: e.tagName,
                    text: e.innerText?.slice(0, 70),
                    w: e.getBoundingClientRect().width,
                    left: e.getBoundingClientRect().left,
                  })),
              ),
            ),
        );
      await page.evaluate(() => window.scrollTo(0, 0));
      await page.screenshot({
        path: `/downloads/fixflow-matched-${name}-${width}-${shotTag}.png`,
        fullPage: true,
      });
    }
    await matchedShot('dashboard', 'http://localhost:5173/', 390, 844, () =>
      page.getByRole('heading', { level: 1 }).waitFor(),
    );
    await matchedShot('repairs', 'http://localhost:5173/repairs', 390, 844, () =>
      page.getByText(result.id, { exact: true }).first().waitFor(),
    );
    await matchedShot('repair-detail', `http://localhost:5173/repairs/${result.id}`, 390, 844, () =>
      page.getByRole('heading', { name: 'تفاصيل الإصلاح', exact: true, level: 1 }).waitFor(),
    );
    await matchedShot('reports', 'http://localhost:5173/reports', 390, 844, () =>
      page.getByText('SCREEN-A54', { exact: true }).filter({ visible: true }).waitFor(),
    );
    await matchedShot('dashboard', 'http://localhost:5173/', 320, 700, () =>
      page.getByRole('heading', { level: 1 }).waitFor(),
    );
    await matchedShot('repair-detail', `http://localhost:5173/repairs/${result.id}`, 320, 700, () =>
      page.getByRole('heading', { name: 'تفاصيل الإصلاح', exact: true, level: 1 }).waitFor(),
    );
    await matchedShot('dashboard', 'http://localhost:5173/', 1280, 950, () =>
      page.getByRole('heading', { level: 1 }).waitFor(),
    );
    await matchedShot('reports', 'http://localhost:5173/reports', 1280, 950, () =>
      page.getByText('SCREEN-A54', { exact: true }).filter({ visible: true }).waitFor(),
    );
    // Drawer (new mobile navigation only): open the menu on a phone and
    // capture it; skip silently on builds without the menu button.
    await page.setViewportSize({ width: 390, height: 844 });
    await page.goto('http://localhost:5173/');
    await page.getByRole('heading', { level: 1 }).waitFor();
    const menuButton = page.getByRole('button', { name: 'القائمة', exact: true });
    if ((await menuButton.count()) > 0) {
      await menuButton.click();
      await page.getByRole('link', { name: 'التقارير', exact: true }).waitFor();
      await page.evaluate(() => window.scrollTo(0, 0));
      await page.screenshot({ path: `/downloads/fixflow-matched-drawer-390-${shotTag}.png` });
      await page.keyboard.press('Escape');
    } else {
      console.log('Matched shots: no menu button on this build, drawer shot skipped');
    }
    await page.setViewportSize({ width: 1365, height: 950 });
    console.log(
      'PASS matched BEFORE/AFTER screenshots written to /downloads/fixflow-matched-*-' +
        shotTag +
        '.png',
    );
  }

  // Local-only public-profile fixture. No real shop details or publication.
  const publicResult = await page.evaluate(async () => {
    const token = (
      await (await fetch('/api/auth/refresh', { method: 'POST', credentials: 'include' })).json()
    ).accessToken;
    return await (
      await fetch('/api/tenants/me/public-profile', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + token },
        body: JSON.stringify({
          slug: 'review-workshop',
          displayName: 'ورشة تجريبية',
          description: 'صفحة محل تجريبية لاختبار التصميم فقط.',
          services: [{ name: 'صيانة الهواتف', description: 'خدمة تجريبية.' }],
          contact: { phone: '+201001234567' },
          hours: { sat: { open: '09:00', close: '18:00' }, fri: null },
          published: true,
        }),
      })
    ).json();
  });
  if (!publicResult.published) throw new Error('Public fixture save failed');
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto('http://localhost:5173/settings/public-profile');
  await page.locator('input').filter({ visible: true }).first().waitFor();
  await page.screenshot({ path: '/downloads/fixflow-public-settings-mobile.png', fullPage: true });
  const anon = await browser.newContext({ viewport: { width: 390, height: 844 } });
  const publicPage = await anon.newPage();
  await publicPage.goto('http://localhost:5173/s/review-workshop');
  await publicPage.getByRole('heading', { name: 'ورشة تجريبية', level: 1 }).waitFor();
  if (await publicPage.locator('main nav').count()) throw new Error('Private nav on public page');
  if (await publicPage.evaluate(() => document.documentElement.scrollWidth > innerWidth))
    throw new Error('Public overflow');
  await publicPage.waitForTimeout(600);
  await publicPage.screenshot({
    path: '/downloads/fixflow-public-shop-mobile.png',
    fullPage: true,
  });
  console.log('PASS anonymous public page and owner settings rendered');
  await anon.close();
} finally {
  if (browser) await browser.close();
  if (web) await new Promise((resolve) => web.httpServer.close(resolve));
  if (app) await app.close();
  if (socket) await socket.stop();
  await db.close();
}
