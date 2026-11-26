/* global console, process, URL */
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { setupHttpTestDb } from './http-test-db.mjs';
import assert from 'node:assert/strict';
process.chdir(fileURLToPath(new URL('../', import.meta.url)));
const require = createRequire(import.meta.url);
const { Test } = require('@nestjs/testing');
const request = require('supertest');

// Customer repair tracking links. Real embedded PostgreSQL + actual Nest
// controllers. Run: npm run test:tracking:http
process.env.JWT_ACCESS_SECRET = 'test-only-access-secret-not-for-production-use';
process.env.JWT_REFRESH_SECRET = 'test-only-refresh-secret-not-for-production-use';
process.env.NODE_ENV = 'test';
const testDb = await setupHttpTestDb({ port: 15437 });
let app;
try {
  const mods = [
    'prisma/prisma.module#PrismaModule',
    'auth/auth.module#AuthModule',
    'customers/customers.module#CustomersModule',
    'repairs/repairs.module#RepairsModule',
    'tracking/tracking.module#TrackingModule',
  ].map((m) => {
    const [p, n] = m.split('#');
    return require(`../apps/api/dist/${p}`)[n];
  });
  const { PrismaService } = require('../apps/api/dist/prisma/prisma.service');
  const mod = await Test.createTestingModule({ imports: mods }).compile();
  app = mod.createNestApplication();
  app.setGlobalPrefix('api');
  await app.init();
  const prisma = mod.get(PrismaService);
  const api = request(app.getHttpServer());
  const auth = (t) => ({ Authorization: `Bearer ${t}` });
  const reg = async (email, tenantName) =>
    (
      await api
        .post('/api/auth/register')
        .send({ email, password: 'twelve-chars-min', tenantName, branchName: 'Main' })
        .expect(201)
    ).body;

  const a = await reg('owner-a@example.test', 'ورشة النور');
  const b = await reg('owner-b@example.test', 'Shop B');
  const tokA = a.tokens.accessToken;
  const tokB = b.tokens.accessToken;

  const customer = (
    await api
      .post('/api/customers')
      .set(auth(tokA))
      .send({ name: 'Sara Private', phone: '+201000000001' })
      .expect(201)
  ).body;
  const device = (
    await api
      .post(`/api/customers/${customer.id}/devices`)
      .set(auth(tokA))
      .send({ brand: 'Samsung', model: 'A54' })
      .expect(201)
  ).body;
  const expected = new Date(Date.now() + 2 * 86400000).toISOString();
  const repair = (
    await api
      .post('/api/repairs')
      .set(auth(tokA))
      .send({
        customerId: customer.id,
        deviceId: device.id,
        branchId: a.branch.id,
        problemDescription: 'Screen cracked SECRET-PROBLEM',
        expectedReadyAt: expected,
      })
      .expect(201)
  ).body;
  assert.equal(new Date(repair.expectedReadyAt).toISOString(), expected);
  console.log('PASS repair stores expectedReadyAt');

  const linkPath = `/api/repairs/${repair.id}/tracking-link`;
  await api.post(linkPath).send({}).expect(401);
  console.log('PASS anonymous cannot create a link');
  await api.post(linkPath).set(auth(tokB)).send({}).expect(404);
  await api.delete(linkPath).set(auth(tokB)).expect(404);
  console.log('PASS other tenant cannot create or revoke a link (404)');
  await api.post(linkPath).set(auth(tokA)).send({ days: 500 }).expect(400);
  await api.post(linkPath).set(auth(tokA)).send({ extra: 1 }).expect(400);
  console.log('PASS link DTO validation');

  const link = (await api.post(linkPath).set(auth(tokA)).send({}).expect(201)).body;
  assert.match(link.token, /^[A-Za-z0-9_-]{32}$/);
  assert.equal(link.path, `/t/${link.token}`);
  const rows = await prisma.withTenant(a.tenant.id, (tx) => tx.repairTrackingLink.findMany());
  assert.equal(rows.length, 1);
  assert.notEqual(rows[0].tokenHash, link.token);
  assert.ok(!JSON.stringify(rows).includes(link.token), 'raw token must not be stored');
  console.log('PASS token is 192-bit and stored only as a hash');
  const noCtx = await prisma.repairTrackingLink.findMany();
  assert.equal(noCtx.length, 0, 'RLS must hide links without tenant or token context');
  console.log('PASS RLS hides links when no tenant/token context is set');

  const pub = await api.get(`/api/public/track/${link.token}`).expect(200);
  assert.deepEqual(Object.keys(pub.body).sort(), [
    'device',
    'expectedReadyAt',
    'shop',
    'status',
    'timeline',
    'updatedAt',
  ]);
  assert.equal(pub.body.shop.name, 'ورشة النور');
  assert.deepEqual(pub.body.device, { brand: 'Samsung', model: 'A54' });
  assert.equal(pub.body.status, 'received');
  const raw = JSON.stringify(pub.body);
  for (const secret of [
    'Sara',
    '+2010',
    'SECRET-PROBLEM',
    customer.id,
    repair.id,
    a.tenant.id,
    'owner-a',
  ]) {
    assert.ok(!raw.includes(secret), `public response leaked ${secret}`);
  }
  assert.equal(pub.headers['cache-control'], 'no-store');
  assert.match(pub.headers['x-robots-tag'], /noindex/);
  console.log(
    'PASS public view works with no account, minimal fields, no leaks, no-store + noindex',
  );

  await api
    .post(`/api/repairs/${repair.id}/transition`)
    .set(auth(tokA))
    .send({ toStatus: 'diagnosing', expectedVersion: repair.version, note: 'PRIVATE-NOTE' })
    .expect(200);
  const pub2 = (await api.get(`/api/public/track/${link.token}`).expect(200)).body;
  assert.equal(pub2.status, 'diagnosing');
  assert.deepEqual(
    pub2.timeline.map((e) => e.status),
    ['received', 'diagnosing'],
  );
  assert.ok(!JSON.stringify(pub2).includes('PRIVATE-NOTE'));
  console.log('PASS timeline follows status changes and hides staff notes');

  const bad = await api.get('/api/public/track/not-a-token').expect(404);
  const guess = await api.get(`/api/public/track/${'A'.repeat(32)}`).expect(404);
  assert.deepEqual(bad.body.message, guess.body.message);
  console.log('PASS malformed and unknown tokens are the same 404');

  const link2 = (await api.post(linkPath).set(auth(tokA)).send({}).expect(201)).body;
  await api.get(`/api/public/track/${link.token}`).expect(404);
  await api.get(`/api/public/track/${link2.token}`).expect(200);
  console.log('PASS creating a new link revokes the old one');

  await api.delete(linkPath).set(auth(tokA)).expect(200);
  await api.get(`/api/public/track/${link2.token}`).expect(404);
  console.log('PASS revoke works');

  const link3 = (await api.post(linkPath).set(auth(tokA)).send({ days: 1 }).expect(201)).body;
  await prisma.withTenant(a.tenant.id, (tx) =>
    tx.repairTrackingLink.updateMany({ data: { expiresAt: new Date(Date.now() - 1000) } }),
  );
  await api.get(`/api/public/track/${link3.token}`).expect(404);
  console.log('PASS expired link is 404');

  // Tenant B's link never shows tenant A data.
  const cB = (
    await api
      .post('/api/customers')
      .set(auth(tokB))
      .send({ name: 'Bob', phone: '+201000000002' })
      .expect(201)
  ).body;
  const dB = (
    await api
      .post(`/api/customers/${cB.id}/devices`)
      .set(auth(tokB))
      .send({ brand: 'Apple', model: 'iPhone 12' })
      .expect(201)
  ).body;
  const rB = (
    await api
      .post('/api/repairs')
      .set(auth(tokB))
      .send({
        customerId: cB.id,
        deviceId: dB.id,
        branchId: b.branch.id,
        problemDescription: 'Battery',
      })
      .expect(201)
  ).body;
  const lB = (
    await api.post(`/api/repairs/${rB.id}/tracking-link`).set(auth(tokB)).send({}).expect(201)
  ).body;
  const pubB = (await api.get(`/api/public/track/${lB.token}`).expect(200)).body;
  assert.equal(pubB.shop.name, 'Shop B');
  assert.deepEqual(pubB.device, { brand: 'Apple', model: 'iPhone 12' });
  console.log('PASS each link shows only its own tenant and repair');

  let first429;
  for (let i = 0; i < 70; i++) {
    const r = await api.get(`/api/public/track/${'B'.repeat(32)}`);
    if (r.status === 429) {
      first429 = i;
      break;
    }
  }
  assert.ok(first429 !== undefined && first429 <= 60, 'rate limit must trigger');
  console.log(`PASS public tracking is rate limited (429 after ${first429} more requests)`);

  console.log('PASS tracking harness: all cases passed');
} catch (e) {
  console.error('Tracking harness failed:', e);
  process.exitCode = 1;
} finally {
  if (app) await app.close();
  await testDb.stop();
}
