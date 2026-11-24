/* global console, process, URL */
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { setupHttpTestDb } from './http-test-db.mjs';
import assert from 'node:assert/strict';
process.chdir(fileURLToPath(new URL('../', import.meta.url)));
const require = createRequire(import.meta.url);
const { Test } = require('@nestjs/testing');
const request = require('supertest');
const argon2 = require('argon2');

// Per-tenant public profile (landing page) — Phase 10. Real embedded
// PostgreSQL engine over a TCP socket, actual Nest controllers, actual
// Argon2/JWT/Prisma. Run via `npm run test:public-profile:http`
// (builds the API first). With FIXFLOW_HTTP_DATABASE_URL set (and
// gated), the same cases run against a normal PostgreSQL 16 database
// instead — see scripts/http-test-db.mjs.
//
// What this proves: the public endpoint returns ONLY the eight public
// fields for a published profile; unpublished and unknown slugs are
// both 404; no cross-tenant private data (customers, repairs, staff,
// inventory) can leak; settings are owner-only; validation rejects
// markup, script URLs and bad slugs; a duplicate slug is 409.
process.env.JWT_ACCESS_SECRET = 'test-only-access-secret-not-for-production-use';
process.env.JWT_REFRESH_SECRET = 'test-only-refresh-secret-not-for-production-use';
process.env.NODE_ENV = 'test';
const testDb = await setupHttpTestDb({ port: 15436 });
let app;
try {
  const { PrismaModule } = require('../apps/api/dist/prisma/prisma.module');
  const { AuthModule } = require('../apps/api/dist/auth/auth.module');
  const { CustomersModule } = require('../apps/api/dist/customers/customers.module');
  const { RepairsModule } = require('../apps/api/dist/repairs/repairs.module');
  const { InventoryModule } = require('../apps/api/dist/inventory/inventory.module');
  const { PublicProfileModule } = require('../apps/api/dist/public-profile/public-profile.module');
  const { PrismaService } = require('../apps/api/dist/prisma/prisma.service');
  const mod = await Test.createTestingModule({
    imports: [
      PrismaModule,
      AuthModule,
      CustomersModule,
      RepairsModule,
      InventoryModule,
      PublicProfileModule,
    ],
  }).compile();
  app = mod.createNestApplication();
  app.setGlobalPrefix('api');
  await app.init();
  const prisma = mod.get(PrismaService);
  const api = request(app.getHttpServer());
  const auth = (token) => ({ Authorization: `Bearer ${token}` });

  const PUBLIC_FIELDS = [
    'contact',
    'description',
    'displayName',
    'hours',
    'logoUrl',
    'services',
    'slug',
    'theme',
  ];

  const ownerA = {
    email: 'owner-a@example.test',
    password: 'twelve-chars-min',
    tenantName: 'Shop A',
    branchName: 'Main',
  };
  const a = (await api.post('/api/auth/register').send(ownerA).expect(201)).body;
  const tenantA = a.tenant.id;
  const branchA = a.branch.id;
  const tokenA = a.tokens.accessToken;

  async function createStaff(email, role, branchIds) {
    const hash = await argon2.hash('twelve-chars-min', {
      type: argon2.argon2id,
      memoryCost: 19456,
      timeCost: 2,
      parallelism: 1,
    });
    const user = await prisma.user.create({
      data: { email, passwordHash: hash, name: email.split('@')[0] },
    });
    await prisma.withTenant(tenantA, async (tx) => {
      await tx.membership.create({
        data: { userId: user.id, tenantId: tenantA, role, branchIds },
      });
    });
    const login = (
      await api.post('/api/auth/login').send({ email, password: 'twelve-chars-min' }).expect(200)
    ).body;
    return { user, token: login.tokens.accessToken };
  }
  const manager = await createStaff('manager@example.test', 'manager', [branchA]);
  const b = (
    await api
      .post('/api/auth/register')
      .send({ ...ownerA, email: 'owner-b@example.test', tenantName: 'Shop B' })
      .expect(201)
  ).body;
  const tokenB = b.tokens.accessToken;

  // --- Private data for tenant A (must never appear publicly) ---
  const customer = (
    await api
      .post('/api/customers')
      .set(auth(tokenA))
      .send({ name: 'Sara', phone: '+201000000001' })
      .expect(201)
  ).body;
  const device = (
    await api
      .post(`/api/customers/${customer.id}/devices`)
      .set(auth(tokenA))
      .send({ brand: 'Samsung', model: 'A54' })
      .expect(201)
  ).body;
  const repair = (
    await api
      .post('/api/repairs')
      .set(auth(tokenA))
      .send({
        customerId: customer.id,
        deviceId: device.id,
        branchId: branchA,
        problemDescription: 'Screen cracked',
      })
      .expect(201)
  ).body;
  const part = (
    await api
      .post('/api/parts')
      .set(auth(tokenA))
      .send({ sku: 'SCREEN-A54', name: 'Screen A54' })
      .expect(201)
  ).body;
  await api
    .post('/api/stock/adjust')
    .set(auth(tokenA))
    .send({
      branchId: branchA,
      partId: part.id,
      delta: 10,
      idempotencyKey: 'pub-seed-adjust-00001',
    })
    .expect(200);

  const settingsPath = '/api/tenants/me/public-profile';
  const profileA = {
    slug: 'shop-a-repair',
    displayName: 'Shop A Repair',
    description: 'Phone and laptop repair in Cairo.',
    logoUrl: 'https://example.com/logo-a.png',
    theme: 'green',
    services: [{ name: 'Screen replacement', description: 'Same-day service.' }],
    contact: { phone: '+20 100 000 0000', website: 'https://shop-a.example.test' },
    hours: { sat: { open: '09:00', close: '18:00' }, fri: null },
    published: false,
  };

  // --- Settings: no profile yet ---
  await api.get(settingsPath).set(auth(tokenA)).expect(404);
  console.log('PASS settings GET before setup is 404');

  // --- Settings: owner-only ---
  await api.get(settingsPath).expect(401);
  await api.get(settingsPath).set(auth(manager.token)).expect(403);
  await api.put(settingsPath).set(auth(manager.token)).send(profileA).expect(403);
  console.log('PASS settings endpoints are owner-only (401 anonymous, 403 non-owner)');

  // --- Settings: validation 400s ---
  for (const [name, body] of [
    ['javascript: logo', { ...profileA, logoUrl: 'javascript:alert(1)' }],
    ['data: logo', { ...profileA, logoUrl: 'data:image/png;base64,aaaa' }],
    ['http logo', { ...profileA, logoUrl: 'http://example.com/logo.png' }],
    ['non-image logo', { ...profileA, logoUrl: 'https://example.com/image' }],
    ['HTML in description', { ...profileA, description: '<b>bold</b>' }],
    ['HTML in display name', { ...profileA, displayName: 'Shop <script>' }],
    ['uppercase slug', { ...profileA, slug: 'Shop-A' }],
    ['short slug', { ...profileA, slug: 'ab' }],
    ['reserved slug', { ...profileA, slug: 'admin' }],
    ['oversized display name', { ...profileA, displayName: 'x'.repeat(101) }],
    [
      'too many services',
      { ...profileA, services: Array.from({ length: 21 }, (_, i) => ({ name: `S${i}` })) },
    ],
    ['javascript: website', { ...profileA, contact: { website: 'javascript:alert(1)' } }],
    ['bad email', { ...profileA, contact: { email: 'not-an-email' } }],
    ['close before open', { ...profileA, hours: { sat: { open: '18:00', close: '09:00' } } }],
    ['publish without a display name', { slug: 'no-name-shop', published: true }],
    ['unknown field', { ...profileA, customers: [{ name: 'Sara' }] }],
  ]) {
    await api.put(settingsPath).set(auth(tokenA)).send(body).expect(400);
    console.log(`PASS validation rejects: ${name}`);
  }

  // --- Settings: create unpublished, then publish ---
  const created = (await api.put(settingsPath).set(auth(tokenA)).send(profileA).expect(200)).body;
  assert.equal(created.slug, 'shop-a-repair');
  assert.equal(created.published, false);
  assert.equal(created.displayName, 'Shop A Repair');
  assert.equal(created.theme, 'green');
  console.log('PASS settings PUT creates an unpublished profile');

  // Unpublished profile is invisible to the public endpoint.
  await api.get('/api/public/shops/shop-a-repair').expect(404);
  await api.get('/api/public/shops/unknown-slug').expect(404);
  await api.get('/api/public/shops/BAD_SLUG').expect(400);
  console.log('PASS unpublished and unknown slugs are 404 (malformed slug is 400)');

  const published = (
    await api
      .put(settingsPath)
      .set(auth(tokenA))
      .send({ ...profileA, published: true })
      .expect(200)
  ).body;
  assert.equal(published.published, true);
  console.log('PASS settings PUT publishes the profile');

  // --- Public projection: exactly the eight public fields ---
  const pub = (await api.get('/api/public/shops/shop-a-repair').expect(200)).body;
  assert.deepEqual(Object.keys(pub).sort(), PUBLIC_FIELDS);
  assert.equal(pub.slug, 'shop-a-repair');
  assert.equal(pub.displayName, 'Shop A Repair');
  assert.equal(pub.description, 'Phone and laptop repair in Cairo.');
  assert.equal(pub.logoUrl, 'https://example.com/logo-a.png');
  assert.equal(pub.theme, 'green');
  assert.deepEqual(pub.services, [
    { name: 'Screen replacement', description: 'Same-day service.' },
  ]);
  assert.deepEqual(pub.contact, {
    phone: '+20 100 000 0000',
    website: 'https://shop-a.example.test',
  });
  assert.deepEqual(pub.hours, { sat: { open: '09:00', close: '18:00' }, fri: null });
  const serialized = JSON.stringify(pub);
  for (const leak of [
    'Sara',
    customer.id,
    device.id,
    repair.id,
    part.id,
    'Screen cracked',
    'SCREEN-A54',
    'manager@example.test',
    tenantA,
    branchA,
  ]) {
    assert.ok(!serialized.includes(leak), `public response leaks private data: ${leak}`);
  }
  console.log('PASS public projection returns exactly the eight public fields, no private data');

  // --- Cross-tenant: tenant B's profile and data never appear under A ---
  const profileB = {
    slug: 'shop-b-repair',
    displayName: 'Shop B Repair',
    theme: 'gold',
    services: [{ name: 'Battery replacement' }],
    published: true,
  };
  await api.put(settingsPath).set(auth(tokenB)).send(profileB).expect(200);
  const pubB = (await api.get('/api/public/shops/shop-b-repair').expect(200)).body;
  assert.deepEqual(Object.keys(pubB).sort(), PUBLIC_FIELDS);
  assert.equal(pubB.displayName, 'Shop B Repair');
  assert.equal(pubB.theme, 'gold');
  assert.ok(!JSON.stringify(pubB).includes('Shop A'), 'tenant B page leaks tenant A data');
  // Tenant B's settings read returns B's own profile, never A's.
  const settingsB = (await api.get(settingsPath).set(auth(tokenB)).expect(200)).body;
  assert.equal(settingsB.slug, 'shop-b-repair');
  const settingsA = (await api.get(settingsPath).set(auth(tokenA)).expect(200)).body;
  assert.equal(settingsA.slug, 'shop-a-repair');
  console.log('PASS cross-tenant isolation: each tenant sees only its own profile');

  // --- Duplicate slug is 409 (tenant B cannot take A's slug) ---
  await api
    .put(settingsPath)
    .set(auth(tokenB))
    .send({ ...profileB, slug: 'shop-a-repair' })
    .expect(409);
  console.log('PASS duplicate slug is 409');

  // --- Unpublishing hides the page again ---
  await api
    .put(settingsPath)
    .set(auth(tokenA))
    .send({ ...profileA, published: false })
    .expect(200);
  await api.get('/api/public/shops/shop-a-repair').expect(404);
  console.log('PASS unpublishing hides the public page');

  // --- Rate limiting: 100/min per IP (Phase 11) ---
  // The limit is PUBLIC_SHOP_MAX_PER_IP (100) per
  // PUBLIC_SHOP_WINDOW_MS (60 s) per IP, enforced by
  // PublicShopRateLimitMiddleware — the numbers here must match
  // apps/api/src/auth/rate-limit.ts. supertest always connects from
  // the loopback IP, so the whole harness shares one budget. Six
  // public GETs above already consumed budget from this IP
  // (unpublished 404, unknown 404, malformed 400, published 200,
  // shop-B 200, unpublished-again 404), so 100 - 6 = 94 more are
  // allowed before the next is denied. The under-limit 200 and the
  // unpublished/unknown 404s are the harness's earlier cases — they
  // ran under the limit and prove the limiter does not break normal
  // reads. Window reset is unit-tested with a fake clock
  // (public-shop-rate-limit.spec.ts), not by waiting 60 s here; the
  // Retry-After bound (1-60 s) asserted below is the observable
  // window evidence in this harness.
  await api
    .put(settingsPath)
    .set(auth(tokenA))
    .send({ ...profileA, published: true })
    .expect(200);
  let allowed = 0;
  let firstDenied = null;
  for (let i = 0; i < 110; i++) {
    const res = await api.get('/api/public/shops/shop-a-repair');
    if (res.status === 200) {
      allowed += 1;
      continue;
    }
    if (res.status === 429) {
      firstDenied = res;
      break;
    }
    throw new Error(`unexpected public status while rate-limiting: ${res.status}`);
  }
  assert.equal(allowed, 94, `expected 94 allowed GETs before the limit, got ${allowed}`);
  assert.ok(firstDenied, 'expected a 429 once the limit was exceeded');
  assert.equal(firstDenied.body.statusCode, 429);
  assert.equal(firstDenied.body.message, 'Too many requests.');
  const retryAfter = Number(firstDenied.headers['retry-after']);
  assert.ok(
    Number.isInteger(retryAfter) && retryAfter >= 1 && retryAfter <= 60,
    `Retry-After must be 1-60 seconds, got ${firstDenied.headers['retry-after']}`,
  );
  // Still denied while inside the same window.
  await api.get('/api/public/shops/shop-a-repair').expect(429);
  console.log('PASS rate limiting: 94 more GETs allowed, then 429 with Retry-After, still 429');

  console.log('PASS public profile harness: all cases passed');
  process.exitCode = 0;
} catch (error) {
  console.error('Public profile harness failed:', error);
  process.exitCode = 1;
} finally {
  if (app) await app.close();
  await testDb.stop();
}
