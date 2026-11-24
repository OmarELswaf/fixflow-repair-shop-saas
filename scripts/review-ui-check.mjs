/* global process, console, document, innerWidth, localStorage, sessionStorage, navigator, URL, fetch, crypto, performance, window, history, PopStateEvent */
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

  // --- Dashboard status chips sync the repairs filter (Phase 11) ---
  // Regression: the repairs filter used to be read from the URL once
  // on mount, so navigating between a dashboard chip
  // (/repairs?status=X) and the bottom navigation (/repairs) while
  // already on /repairs left the list showing the old filter. The
  // filter is now derived from the URL in both directions.
  await page.goto('http://localhost:5173/');
  await page.getByRole('heading', { level: 1 }).waitFor();
  const filteredList = page.waitForResponse(
    (r) => r.url().includes('/api/repairs?') && r.url().includes('status=diagnosing'),
  );
  await page.getByRole('link', { name: /قيد التشخيص/ }).click();
  await filteredList;
  await page.waitForURL(/\/repairs\?status=diagnosing$/);
  const pressedChip = await page
    .getByRole('group', { name: 'الحالة' })
    .locator('[aria-pressed="true"]')
    .textContent();
  if (pressedChip !== 'قيد التشخيص')
    throw new Error('Dashboard chip did not apply the status filter: ' + pressedChip);
  // Same-route navigation via the bottom nav (as a user tapping
  // Repairs) must clear the filter instead of leaving the old one.
  const unfilteredList = page.waitForResponse(
    (r) => r.url().includes('/api/repairs?') && !r.url().includes('status='),
  );
  await page.getByRole('button', { name: 'الإصلاحات', exact: true }).click();
  await unfilteredList;
  await page.waitForURL('http://localhost:5173/repairs');
  const pressedAfter = await page
    .getByRole('group', { name: 'الحالة' })
    .locator('[aria-pressed="true"]')
    .textContent();
  if (pressedAfter !== 'كل الحالات')
    throw new Error('Bottom-nav Repairs did not clear the status filter: ' + pressedAfter);
  console.log('PASS dashboard status chips sync the repairs filter with the URL');

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
  await page.setViewportSize({ width: 1365, height: 950 });
  // --- Movements ledger: repair link + actor name (Phase 6 traceability) ---
  await page.goto('http://localhost:5173/stock');
  await page.getByRole('link', { name: result.id }).first().waitFor();
  await page.getByText('مالك تجريبي').first().waitFor();
  console.log('PASS movements ledger shows the repair link and actor name');

  // --- SearchPicker continuation: 11 matching customers, load the 2nd page ---
  await page.getByRole('link', { name: 'العملاء', exact: true }).click();
  for (let i = 1; i <= 11; i++) {
    await page.getByLabel(/اسم العميل/).fill(`عميل اختبار ${i}`);
    await page.getByRole('button', { name: 'إنشاء العميل', exact: true }).click();
    await page.getByRole('link', { name: `عميل اختبار ${i}`, exact: true }).waitFor();
  }
  await page.getByRole('link', { name: 'الإصلاحات', exact: true }).click();
  await page.getByLabel('ابحث عن عميل بالاسم أو الهاتف…', { exact: true }).fill('عميل اختبار');
  await page.getByRole('option').first().waitFor();
  const firstPageNames = await page.getByRole('option').allTextContents();
  await page.getByRole('button', { name: 'عرض المزيد من النتائج' }).click();
  await page.waitForFunction(() => document.querySelectorAll('[role=option]').length > 10);
  const allNames = await page.getByRole('option').allTextContents();
  if (new Set(allNames).size <= new Set(firstPageNames).size)
    throw new Error('Picker second page missing');
  console.log('PASS SearchPicker continuation loads the second page of results');

  // --- Durable pending retry: seed pending ops, reload, verify the notice
  // and that nothing is re-submitted. ---
  const { tenantId, userId } = await page.evaluate(async () => {
    const refreshed = await (
      await fetch('/api/auth/refresh', { method: 'POST', credentials: 'include' })
    ).json();
    const res = await fetch('/api/auth/me', {
      credentials: 'include',
      headers: { Authorization: `Bearer ${refreshed.accessToken}` },
    });
    const me = await res.json();
    return { tenantId: me.tenantContext?.tenantId, userId: me.user?.id };
  });
  if (!tenantId || !userId) throw new Error('Tenant/user id missing for pending-op seed');
  const stockPosts = [];
  page.on('request', (r) => {
    if (
      r.method() === 'POST' &&
      (/\/api\/stock\/adjust/.test(r.url()) || /\/api\/repairs\/[^/]+\/parts/.test(r.url()))
    )
      stockPosts.push(r.url());
  });
  // Completed case: the adjust above already wrote this movement.
  // Per-op key (Phase 8): fixflow-pending-op:<userId>:<tenantId>:<operationKey>.
  await page.evaluate(
    ([user, tenant, key]) => {
      localStorage.setItem(
        `fixflow-pending-op:${user}:${tenant}:${key}`,
        JSON.stringify({
          operationKey: key,
          kind: 'adjust',
          repairOrderId: null,
          createdAt: new Date().toISOString(),
          userId: user,
        }),
      );
    },
    [userId, tenantId, adjustKey],
  );
  await page.reload();
  await page.getByText(/اكتمل تغيير مخزون/).waitFor();
  if (stockPosts.length) throw new Error('Pending op re-submitted after reload: ' + stockPosts[0]);
  await page
    .getByRole('alert')
    .filter({ hasText: 'اكتمل تغيير مخزون' })
    .getByRole('button', { name: 'إغلاق' })
    .click();
  // Unknown case: a key with no movement must stay unconfirmed.
  const unknownKey = await page.evaluate(() => crypto.randomUUID());
  await page.evaluate(
    ([user, tenant, key]) => {
      localStorage.setItem(
        `fixflow-pending-op:${user}:${tenant}:${key}`,
        JSON.stringify({
          operationKey: key,
          kind: 'adjust',
          repairOrderId: null,
          createdAt: new Date().toISOString(),
          userId: user,
        }),
      );
    },
    [userId, tenantId, unknownKey],
  );
  await page.reload();
  const unknownAlert = page.getByRole('alert').filter({ hasText: 'تعذر تأكيد تغيير مخزون' });
  await unknownAlert.waitFor();
  if (stockPosts.length) throw new Error('Pending op re-submitted after reload: ' + stockPosts[0]);
  await unknownAlert.getByRole('link', { name: 'المخزون' }).waitFor();
  await unknownAlert.getByRole('button', { name: 'لقد تحققت' }).click();
  await page.waitForFunction(
    ([user, tenant, key]) =>
      localStorage.getItem(`fixflow-pending-op:${user}:${tenant}:${key}`) === null,
    [userId, tenantId, unknownKey],
  );
  console.log('PASS durable pending retry: completed + unknown notices, no re-submit');

  // --- REAL lost-response tests: route interception, no seeding ---
  // The stock write goes through the real form + stockWrite; the
  // response is lost in the browser while the server has (case A) or
  // has not (case B) processed the write. Reload, then the banner
  // reconciles from the ledger — never a re-POST.
  const lostPosts = [];
  page.on('request', (r) => {
    if (r.method() === 'POST' && r.url().endsWith('/api/stock/adjust'))
      lostPosts.push(r.postDataJSON().idempotencyKey);
  });
  async function freshAccessToken() {
    return page.evaluate(async () => {
      const refreshed = await (
        await fetch('/api/auth/refresh', { method: 'POST', credentials: 'include' })
      ).json();
      if (!refreshed.accessToken)
        throw new Error('Fixture refresh missing access token ' + JSON.stringify(refreshed));
      return refreshed.accessToken;
    });
  }
  async function readPendingKey() {
    const handle = await page.waitForFunction(
      ([user, tenant]) => {
        const keys = Object.keys(localStorage).filter((k) =>
          k.startsWith(`fixflow-pending-op:${user}:${tenant}:`),
        );
        return keys.length ? keys[0].split(':').pop() : null;
      },
      [userId, tenantId],
      { timeout: 10000 },
    );
    return handle.jsonValue();
  }
  async function setupAdjustForm(delta) {
    await page.evaluate(() => {
      history.pushState({}, '', '/');
      window.dispatchEvent(new PopStateEvent('popstate'));
    });
    await page.getByRole('heading', { level: 1 }).waitFor();
    await page.evaluate(() => {
      history.pushState({}, '', '/stock');
      window.dispatchEvent(new PopStateEvent('popstate'));
    });
    try {
      await page
        .getByRole('combobox', { name: 'الفرع', exact: true })
        .last()
        .click({ timeout: 10000 });
    } catch (e) {
      console.log('ADJUST FAIL', page.url(), await page.locator('body').innerText());
      throw e;
    }
    await page.getByRole('option', { name: 'الفرع الرئيسي', exact: true }).click();
    await page.getByRole('combobox', { name: 'اختر القطعة', exact: true }).fill('SCREEN');
    await page.getByRole('option', { name: /SCREEN-A54/ }).click();
    await page.getByLabel(/التغيير/).fill(String(delta));
  }
  // Case A: forward to the server, wait until the movement is in the
  // ledger, then kill the response — the browser never sees it.
  const tokenA = await freshAccessToken();
  await setupAdjustForm(5);
  let finishRoute;
  let routeDone = new Promise((resolve) => {
    finishRoute = resolve;
  });
  await page.route('**/api/stock/adjust', async (route) => {
    const key = route.request().postDataJSON().idempotencyKey;
    const response = await route.fetch();
    await page.waitForFunction(
      async ([k, token]) => {
        const res = await fetch(`/api/stock/movements?operationKey=${k}`, {
          headers: { Authorization: `Bearer ${token}` },
        });
        const body = await res.json();
        return Array.isArray(body.items) && body.items.length > 0;
      },
      [key, tokenA],
      { timeout: 10000 },
    );
    await response.dispose?.();
    await route.abort('failed');
    finishRoute();
  });
  await page.getByRole('button', { name: 'تعديل', exact: true }).click();
  const lostKeyA = await readPendingKey();
  await routeDone;
  await page.unroute('**/api/stock/adjust');
  if (!lostKeyA) throw new Error('No pending record after the lost response');
  if (lostPosts.length !== 1 || lostPosts[0] !== lostKeyA)
    throw new Error('Expected exactly one adjust POST for the lost write');
  await page.reload();
  await page.getByText(/اكتمل تغيير مخزون/).waitFor();
  if (lostPosts.length !== 1) throw new Error('Lost write was re-submitted after reload');
  await page
    .getByRole('alert')
    .filter({ hasText: 'اكتمل تغيير مخزون' })
    .getByRole('button', { name: 'إغلاق' })
    .click();
  console.log('PASS real lost response (server applied): completed notice, no re-POST');

  // Case B: abort before the server ever sees the request.
  await setupAdjustForm(7);
  await page.route('**/api/stock/adjust', (route) => route.abort('failed'));
  await page.getByRole('button', { name: 'تعديل', exact: true }).click();
  const lostKeyB = await readPendingKey();
  await page.unroute('**/api/stock/adjust');
  if (!lostKeyB) throw new Error('No pending record after the aborted request');
  if (lostPosts.length !== 2) throw new Error('Expected exactly two lost adjust POSTs');
  await page.reload();
  await page.getByText(/تعذر تأكيد تغيير مخزون/).waitFor();
  if (lostPosts.length !== 2) throw new Error('Unknown write was re-submitted after reload');
  const stillPendingB = await page.evaluate(
    ([user, tenant, key]) =>
      localStorage.getItem(`fixflow-pending-op:${user}:${tenant}:${key}`) !== null,
    [userId, tenantId, lostKeyB],
  );
  if (!stillPendingB) throw new Error('Unknown pending record vanished');
  await page
    .getByRole('alert')
    .filter({ hasText: 'تعذر تأكيد تغيير مخزون' })
    .getByRole('button', { name: 'لقد تحققت' })
    .click();
  console.log('PASS real lost response (server never saw it): unknown notice, no re-POST');

  // Multi-tab event delivery: outcome reads can be duplicated safely.
  const page2 = await page.context().newPage();
  await page2.goto('http://localhost:5173/stock');
  await page2.getByText('SCREEN-A54').first().waitFor();
  const sharedUnknown = await page.evaluate(() => crypto.randomUUID());
  await page.evaluate(
    ([u, t, k]) =>
      localStorage.setItem(
        `fixflow-pending-op:${u}:${t}:${k}`,
        JSON.stringify({
          userId: u,
          operationKey: k,
          kind: 'adjust',
          repairOrderId: null,
          createdAt: new Date().toISOString(),
        }),
      ),
    [userId, tenantId, sharedUnknown],
  );
  await page2.getByText(/تعذر تأكيد تغيير مخزون/).waitFor();
  await page2.getByRole('button', { name: 'لقد تحققت' }).click();
  await page.waitForFunction(
    ([u, t, k]) => !localStorage.getItem(`fixflow-pending-op:${u}:${t}:${k}`),
    [userId, tenantId, sharedUnknown],
  );
  await page2.close();
  console.log('PASS multi-tab storage-event notice and dismissal; no exclusive-lookup claim');

  // --- Reports + Team in English, desktop 1280 and mobile 390 ---
  await page.setViewportSize({ width: 1280, height: 950 });
  await page.getByRole('button', { name: 'language-toggle' }).click();
  await page.goto('http://localhost:5173/reports');
  await page.getByRole('heading', { level: 1 }).waitFor();
  await page.getByText(/As of/).first().waitFor();
  await page.getByText('SCREEN-A54', { exact: true }).filter({ visible: true }).waitFor();
  await page.evaluate(() => window.scrollTo(0, 0));
  await page.screenshot({
    path: '/downloads/fixflow-phase8-reports-en-desktop.png',
    fullPage: true,
  });
  if (await page.evaluate(() => document.documentElement.scrollWidth > innerWidth))
    throw new Error('Reports English desktop overflow');
  await page.goto('http://localhost:5173/team');
  await page
    .getByText('ui-review@example.test', { exact: true })
    .filter({ visible: true })
    .waitFor();
  await page.evaluate(() => window.scrollTo(0, 0));
  await page.screenshot({ path: '/downloads/fixflow-phase8-team-en-desktop.png', fullPage: true });
  if (await page.evaluate(() => document.documentElement.scrollWidth > innerWidth))
    throw new Error('Team English desktop overflow');
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto('http://localhost:5173/reports');
  await page.getByText('SCREEN-A54', { exact: true }).filter({ visible: true }).waitFor();
  await page.evaluate(() => window.scrollTo(0, 0));
  await page.screenshot({
    path: '/downloads/fixflow-phase8-reports-en-mobile.png',
    fullPage: true,
  });
  if (await page.evaluate(() => document.documentElement.scrollWidth > innerWidth))
    throw new Error('Reports English mobile overflow');
  await page.goto('http://localhost:5173/team');
  await page
    .getByText('ui-review@example.test', { exact: true })
    .filter({ visible: true })
    .waitFor();
  await page.evaluate(() => window.scrollTo(0, 0));
  await page.screenshot({ path: '/downloads/fixflow-phase8-team-en-mobile.png', fullPage: true });
  if (await page.evaluate(() => document.documentElement.scrollWidth > innerWidth))
    throw new Error('Team English mobile overflow');
  console.log('PASS reports and team in English, desktop 1280 and mobile 390');
  // Back to Arabic for the logout step below. The account-switch and
  // tenant-switch sections that follow use the desktop sidebar (logout
  // button and switch-workshop link), so return to a desktop viewport
  // first: on a phone those controls live in the drawer.
  await page.getByRole('button', { name: 'language-toggle' }).click();
  await page.setViewportSize({ width: 1280, height: 950 });
  await page.getByRole('link', { name: 'الإصلاحات', exact: true }).waitFor();

  // --- Account switch: user A's pending op must not leak to user B ---
  // Insert user B into the same tenant directly in the test database
  // (same argon2 parameters as the API's HTTP harness).
  const argon2 = require('argon2');
  const userBId = crypto.randomUUID();
  const { PrismaService } = require('../apps/api/dist/prisma/prisma.service');
  const prisma = mod.get(PrismaService);
  const branchRow = await prisma.withTenant(tenantId, (tx) =>
    tx.branch.findFirst({ where: { tenantId } }),
  );
  const branchId = branchRow?.id;
  if (!branchId) throw new Error('No branch found for account switch');
  const passwordHashB = await argon2.hash('twelve-chars-min', {
    type: argon2.argon2id,
    memoryCost: 19456,
    timeCost: 2,
    parallelism: 1,
  });
  await prisma.user.create({
    data: {
      id: userBId,
      email: 'ui-review-b@example.test',
      name: 'مستخدم ثانٍ',
      passwordHash: passwordHashB,
    },
  });
  await prisma.withTenant(tenantId, (tx) =>
    tx.membership.create({
      data: { userId: userBId, tenantId, role: 'manager', branchIds: [branchId] },
    }),
  );
  // Create a pending op for user A via the real lost-response flow,
  // without reloading and without logging out through the UI (the
  // app's logout clears the current user's pending records — that is
  // exactly what this test must NOT do to user A's record).
  // Repeated full-page visual navigations bootstrap auth each time. Respect the real
  // per-IP refresh limiter rather than disabling it in this integration fixture.
  if (!process.env.SKIP_MATCHED_SHOTS) await page.waitForTimeout(61000);
  const tokenSwitch = await freshAccessToken();
  routeDone = new Promise((resolve) => {
    finishRoute = resolve;
  });

  await setupAdjustForm(4);
  await page.route('**/api/stock/adjust', async (route) => {
    const key = route.request().postDataJSON().idempotencyKey;
    const response = await route.fetch();
    await page.waitForFunction(
      async ([k, token]) => {
        const res = await fetch(`/api/stock/movements?operationKey=${k}`, {
          headers: { Authorization: `Bearer ${token}` },
        });
        const body = await res.json();
        return Array.isArray(body.items) && body.items.length > 0;
      },
      [key, tokenSwitch],
      { timeout: 10000 },
    );
    await response.dispose?.();
    await route.abort('failed');
    finishRoute();
  });
  await page.getByRole('button', { name: 'تعديل', exact: true }).click();
  await routeDone;
  await page.unroute('**/api/stock/adjust');
  const pendingA = await page.evaluate(
    ([user, tenant]) =>
      Object.keys(localStorage).filter((k) =>
        k.startsWith(`fixflow-pending-op:${user}:${tenant}:`),
      ),
    [userId, tenantId],
  );
  if (pendingA.length !== 1) throw new Error('Expected exactly one pending op for user A');
  // Invalidate A's server session without touching localStorage.
  await page.evaluate(async (token) => {
    const res = await fetch('/api/auth/logout-all', {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}` },
    });
    if (!res.ok) throw new Error('logout-all failed: ' + res.status);
  }, tokenSwitch);
  // Reload drops the in-memory tokens, so the app boots logged out.
  await page.reload();
  await page.waitForURL('**/login');
  await page.getByLabel(/البريد الإلكتروني/).fill('ui-review-b@example.test');
  await page.getByLabel(/كلمة المرور/).fill('twelve-chars-min');
  await page.getByRole('button', { name: 'دخول', exact: true }).click();
  await page.waitForURL('http://localhost:5173/');
  // No pending notice from user A may appear for user B.
  await page.waitForTimeout(2000);
  if ((await page.getByText(/اكتمل تغيير مخزون|تعذر تأكيد تغيير مخزون/).count()) !== 0)
    throw new Error('User A pending op leaked to user B');
  // And user A's record is still in localStorage, untouched.
  const pendingAfter = await page.evaluate(
    ([user, tenant]) =>
      Object.keys(localStorage).filter((k) =>
        k.startsWith(`fixflow-pending-op:${user}:${tenant}:`),
      ),
    [userId, tenantId],
  );
  if (JSON.stringify(pendingAfter) !== JSON.stringify(pendingA))
    throw new Error('User A pending record was touched by user B');
  console.log('PASS account switch: no pending ops from user A shown to user B, A record intact');

  // --- Cookie-refresh scope change: a write started as A must abort,
  // --- never retry under B ---
  // Design against the real client (apps/web/src/api/client.ts):
  // apiFetch retries once after a 401 via the HttpOnly refresh
  // cookie, but compares the refreshed JWT's (sub, tenantId) with
  // the scope the request started with. A scope change clears the
  // in-memory token and throws UnauthorizedError — the original
  // write is never re-sent (unit regression: "never retries a write
  // under a different account after cookie refresh", exactly two
  // fetch calls). The 401 here is induced by route interception to
  // simulate an expired token at the moment of the switch; the
  // abort/no-retry behavior is the code under test. Page 2 shares
  // the browser context, so its logout/login swaps the refresh
  // cookie for both pages.
  // Page 1 is logged in as B after the account-switch section; log
  // back in as A first.
  await page.getByRole('button', { name: 'تسجيل الخروج', exact: true }).click();
  await page.waitForURL('**/login');
  await page.getByLabel(/البريد الإلكتروني/).fill('ui-review@example.test');
  await page.getByLabel(/كلمة المرور/).fill('local-review-only-pass');
  await page.getByRole('button', { name: 'دخول', exact: true }).click();
  await page.waitForURL('http://localhost:5173/');
  // The account-switch section left one pending op for A in storage;
  // the banner reconciles it on login (completed) — wait until the
  // record is gone, then dismiss the notice, so this test starts
  // from a clean slate.
  await page.waitForFunction(
    ([user, tenant]) =>
      Object.keys(localStorage).filter((k) => k.startsWith(`fixflow-pending-op:${user}:${tenant}:`))
        .length === 0,
    [userId, tenantId],
    { timeout: 10000 },
  );
  const scopeLeftover = page.getByRole('alert').filter({ hasText: 'اكتمل تغيير مخزون' });
  if ((await scopeLeftover.count()) > 0) {
    await scopeLeftover.getByRole('button', { name: 'إغلاق' }).click();
  }
  const scopePage = await page.context().newPage();
  await scopePage.goto('http://localhost:5173/stock');
  await scopePage.getByText('SCREEN-A54').first().waitFor();
  // Track only page 1's requests for this test.
  const scopeAdjustPosts = [];
  const scopeRefreshPosts = [];
  page.on('request', (r) => {
    if (r.method() === 'POST' && r.url().endsWith('/api/stock/adjust'))
      scopeAdjustPosts.push(r.url());
    if (r.method() === 'POST' && r.url().endsWith('/api/auth/refresh'))
      scopeRefreshPosts.push(r.url());
  });
  // Hold page 1's adjust request until B has taken over the cookie.
  let releaseHeld;
  const held = new Promise((resolve) => {
    releaseHeld = resolve;
  });
  await page.route('**/api/stock/adjust', async (route) => {
    await held;
    await route.fulfill({
      status: 401,
      contentType: 'application/json',
      body: JSON.stringify({ statusCode: 401, message: 'Unauthorized' }),
    });
  });
  await setupAdjustForm(3);
  const heldRequest = page.waitForRequest(
    (r) => r.url().endsWith('/api/stock/adjust') && r.method() === 'POST',
  );
  await page.getByRole('button', { name: 'تعديل', exact: true }).click();
  const heldReq = await heldRequest;
  const scopeKey = heldReq.postDataJSON().idempotencyKey;
  if (typeof scopeKey !== 'string' || !scopeKey)
    throw new Error('Scope-change adjust idempotency key missing');
  // Page 2 (same context, same cookie jar): log out A, log in as B.
  // Its logout clears A's pending records by design, including the
  // in-flight one — the abort is proven by the request counts below,
  // not by the record's fate.
  await scopePage.getByRole('button', { name: 'تسجيل الخروج', exact: true }).click();
  await scopePage.waitForURL('**/login');
  await scopePage.getByLabel(/البريد الإلكتروني/).fill('ui-review-b@example.test');
  await scopePage.getByLabel(/كلمة المرور/).fill('twelve-chars-min');
  await scopePage.getByRole('button', { name: 'دخول', exact: true }).click();
  await scopePage.waitForURL('http://localhost:5173/');
  // Release the held request: it answers 401, page 1 refreshes with
  // B's cookie and must abort instead of retrying under B.
  const scopeRefreshReq = page.waitForRequest(
    (r) => r.url().endsWith('/api/auth/refresh') && r.method() === 'POST',
  );
  scopeRefreshPosts.length = 0;
  releaseHeld();
  await scopeRefreshReq;
  await page.waitForTimeout(1000);
  await page.unroute('**/api/stock/adjust');
  if (scopeAdjustPosts.length !== 1)
    throw new Error(
      'Scope-change write was retried or never sent: ' + scopeAdjustPosts.length + ' adjust POSTs',
    );
  // Other dashboard queries may also refresh after the account switch.
  // The safety invariant is no replay of the held write, checked above.
  if (scopeRefreshPosts.length < 1) throw new Error('Expected refresh after held 401');
  // No write landed under B: the held request never reached the
  // server, and no retry was sent.
  const movedUnderB = await scopePage.evaluate(async (key) => {
    const refreshed = await (
      await fetch('/api/auth/refresh', { method: 'POST', credentials: 'include' })
    ).json();
    const res = await fetch(`/api/stock/movements?operationKey=${key}`, {
      headers: { Authorization: `Bearer ${refreshed.accessToken}` },
    });
    const body = await res.json();
    return Array.isArray(body.items) ? body.items.length : -1;
  }, scopeKey);
  if (movedUnderB !== 0)
    throw new Error('Scope-change write landed under B: ' + movedUnderB + ' movements');
  // No stale pending notice on either page.
  await page.waitForTimeout(1000);
  if ((await page.getByText(/اكتمل تغيير مخزون|تعذر تأكيد تغيير مخزون/).count()) !== 0)
    throw new Error('Stale pending notice on page 1 after the scope-change abort');
  if ((await scopePage.getByText(/اكتمل تغيير مخزون|تعذر تأكيد تغيير مخزون/).count()) !== 0)
    throw new Error('Stale pending notice under user B after the scope-change abort');
  await scopePage.close();
  console.log(
    'PASS cookie-refresh scope change: write aborted, no retry under the new account, no B-side stock change, no stale notice',
  );

  // --- Second tenant fixture for the same-user switch test ---
  // Tenant B is created through the real register endpoint (Node
  // fetch, no browser cookies involved), then user A is added as a
  // manager of tenant B via the tenant-scoped Prisma fixture setup
  // under RLS (same pattern as the account-switch section).
  const regB = await fetch('http://localhost:3000/api/auth/register', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Origin: 'http://localhost:5173' },
    body: JSON.stringify({
      email: 'ui-review-c@example.test',
      password: 'twelve-chars-min',
      name: 'مالك ورشة ثانية',
      tenantName: 'ورشة ثانية',
      branchName: 'الفرع الثاني',
    }),
  });
  if (!regB.ok) throw new Error('Second-tenant register failed: ' + regB.status);
  const regBBody = await regB.json();
  const tenantBId = regBBody.tenant.id;
  const branchBId = regBBody.branch.id;
  if (!tenantBId || !branchBId) throw new Error('Second-tenant fixture missing ids');
  await prisma.withTenant(tenantBId, (tx) =>
    tx.membership.create({
      data: { userId, tenantId: tenantBId, role: 'manager', branchIds: [branchBId] },
    }),
  );

  // --- Same-user tenant switch: no stale notice, no replay ---
  // The app had no in-app tenant switch before Phase 9 (the only
  // path was logout + login); the shell now offers one to
  // multi-tenant users. Reviewed behavior for the op: switching
  // tenants clears the previous tenant's pending records for the
  // current user (AuthContext keeps an explicit previous scope),
  // so the op must NOT reappear after switching back, and must
  // never be replayed.
  // Page 1 is logged in as A with a cleared token after the
  // scope-change abort; log out and back in so A picks up the
  // second membership and the tenant picker.
  await page.getByRole('button', { name: 'تسجيل الخروج', exact: true }).click();
  await page.waitForURL('**/login');
  await page.getByLabel(/البريد الإلكتروني/).fill('ui-review@example.test');
  await page.getByLabel(/كلمة المرور/).fill('local-review-only-pass');
  await page.getByRole('button', { name: 'دخول', exact: true }).click();
  await page.waitForURL('**/select-tenant');
  await page.getByRole('button', { name: /ورشة الاختبار/ }).click();
  await page.waitForURL('http://localhost:5173/');
  const switchPosts = [];
  page.on('request', (r) => {
    if (r.method() === 'POST' && r.url().endsWith('/api/stock/adjust')) switchPosts.push(r.url());
  });
  // Create a pending op in tenant A via the real lost-response flow
  // (server applied it, response lost). Do NOT reload: the record
  // must still be unreconciled when the switch happens, so the
  // switch itself is what clears it.
  const tokenSwitchB = await freshAccessToken();
  let switchRouteDone;
  const switchRoutePromise = new Promise((resolve) => {
    switchRouteDone = resolve;
  });
  await setupAdjustForm(3);
  await page.route('**/api/stock/adjust', async (route) => {
    const key = route.request().postDataJSON().idempotencyKey;
    const response = await route.fetch();
    await page.waitForFunction(
      async ([k, token]) => {
        const res = await fetch(`/api/stock/movements?operationKey=${k}`, {
          headers: { Authorization: `Bearer ${token}` },
        });
        const body = await res.json();
        return Array.isArray(body.items) && body.items.length > 0;
      },
      [key, tokenSwitchB],
      { timeout: 10000 },
    );
    await response.dispose?.();
    await route.abort('failed');
    switchRouteDone();
  });
  await page.getByRole('button', { name: 'تعديل', exact: true }).click();
  await switchRoutePromise;
  await page.unroute('**/api/stock/adjust');
  const pendingBeforeSwitch = await page.evaluate(
    ([user, tenant]) =>
      Object.keys(localStorage).filter((k) =>
        k.startsWith(`fixflow-pending-op:${user}:${tenant}:`),
      ),
    [userId, tenantId],
  );
  if (pendingBeforeSwitch.length !== 1)
    throw new Error('Expected exactly one pending op before the switch');
  if (switchPosts.length !== 1)
    throw new Error('Expected exactly one adjust POST before the switch');
  // Switch to tenant B from the shell (same user, no logout).
  await page.getByRole('link', { name: 'تبديل الورشة', exact: true }).click();
  await page.waitForURL('**/select-tenant');
  await page.getByRole('button', { name: /ورشة ثانية/ }).click();
  await page.waitForURL('http://localhost:5173/');
  await page.waitForTimeout(2000);
  if ((await page.getByText(/اكتمل تغيير مخزون|تعذر تأكيد تغيير مخزون/).count()) !== 0)
    throw new Error('Tenant A pending notice leaked to tenant B');
  if (switchPosts.length !== 1) throw new Error('Switch replayed the pending write');
  const pendingAfterSwitch = await page.evaluate(
    ([user, tenant]) =>
      Object.keys(localStorage).filter((k) =>
        k.startsWith(`fixflow-pending-op:${user}:${tenant}:`),
      ),
    [userId, tenantId],
  );
  if (pendingAfterSwitch.length !== 0)
    throw new Error('Tenant A pending record survived the tenant switch');
  // No stale tenant-A data on tenant B's stock page: B has no parts.
  await page.goto('http://localhost:5173/stock');
  await page.waitForLoadState('domcontentloaded');
  await page.waitForTimeout(1500);
  if ((await page.getByText('SCREEN-A54', { exact: true }).count()) !== 0)
    throw new Error('Tenant A stock data leaked to tenant B');
  if ((await page.getByText('الفرع الرئيسي', { exact: true }).count()) !== 0)
    throw new Error('Tenant A branch leaked to tenant B');
  // Switch back to tenant A: the cleared op must NOT reappear, and
  // nothing is replayed. Tenant A data is intact again.
  await page.getByRole('link', { name: 'تبديل الورشة', exact: true }).click();
  await page.waitForURL('**/select-tenant');
  await page.getByRole('button', { name: /ورشة الاختبار/ }).click();
  await page.waitForURL('http://localhost:5173/');
  await page.waitForTimeout(2000);
  if ((await page.getByText(/اكتمل تغيير مخزون|تعذر تأكيد تغيير مخزون/).count()) !== 0)
    throw new Error('Cleared tenant A pending op reappeared after switching back');
  if (switchPosts.length !== 1) throw new Error('Switch back replayed the pending write');
  await page.goto('http://localhost:5173/stock');
  await page.getByText('SCREEN-A54').first().waitFor();
  console.log(
    'PASS same-user tenant switch: no stale notice/data, no replay, cleared op stays cleared',
  );

  // --- Public page: publish/unpublish via the settings UI, 320px (Phase 11) ---
  // The fixture shop has no public profile yet. Publish one through
  // the real settings form, check the anonymous page at 320px, then
  // unpublish and check the same slug is not found. No real shop
  // details; the fixture name is labelled as a test workshop.
  await page.goto('http://localhost:5173/settings/public-profile');
  await page
    .getByRole('heading', { name: 'الصفحة العامة للورشة', exact: true, level: 1 })
    .waitFor();
  await page.getByLabel(/العنوان \(slug\)/).fill('review-workshop');
  await page.getByLabel('اسم الورشة المعروض').fill('ورشة تجريبية');
  await page.getByRole('switch', { name: 'منشورة' }).check();
  await page.getByRole('button', { name: 'حفظ الصفحة العامة', exact: true }).click();
  await page.getByText('تم حفظ الصفحة العامة.', { exact: true }).waitFor();
  await page.getByText('معاينة — هذه هي الصفحة المنشورة حالياً.', { exact: true }).waitFor();
  const publicPage = await browser.newPage({ viewport: { width: 320, height: 700 } });
  await publicPage.goto('http://localhost:5173/s/review-workshop');
  await publicPage.getByRole('heading', { name: 'ورشة تجريبية', level: 1 }).waitFor();
  if (await publicPage.evaluate(() => document.documentElement.scrollWidth > innerWidth))
    throw new Error('Public page horizontal overflow at 320px');
  if (await publicPage.locator('main nav').count()) throw new Error('Private nav on public page');
  // Unpublish: the same slug must become not-found, not a stale page.
  await page.getByRole('switch', { name: 'منشورة' }).uncheck();
  await page.getByRole('button', { name: 'حفظ الصفحة العامة', exact: true }).click();
  await page.getByText('تم حفظ الصفحة العامة.', { exact: true }).waitFor();
  await page
    .getByText('معاينة — الصفحة غير منشورة بعد، ولن يراها الزوار حتى تنشرها.', { exact: true })
    .waitFor();
  await publicPage.reload();
  await publicPage.getByText('هذه الصفحة غير موجودة أو غير منشورة.', { exact: true }).waitFor();
  await publicPage.close();
  console.log('PASS public page publish/unpublish via settings UI, anonymous 320px, no overflow');

  await page.getByRole('button', { name: 'تسجيل الخروج', exact: true }).click();
  await page.waitForURL('**/login');
  if (errors.length || failures.length) throw new Error([...errors, ...failures].join('; '));
  console.log(
    'PASS actual Chrome parts/stock adjustment/reserve/consume/release and Arabic RTL: register, customer/device intake, repair create/detail/transition, mobile overflow, cookie refresh reload, logout, no browser errors',
  );
} finally {
  if (browser) await browser.close();
  if (web) await new Promise((resolve) => web.httpServer.close(resolve));
  if (app) await app.close();
  if (socket) await socket.stop();
  await db.close();
}
