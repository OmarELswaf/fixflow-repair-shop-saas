/* global console, process, URL */
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { setupHttpTestDb } from './http-test-db.mjs';
import assert from 'node:assert/strict';
process.chdir(fileURLToPath(new URL('../', import.meta.url)));
const require = createRequire(import.meta.url);
const { Test } = require('@nestjs/testing');
const request = require('supertest');

// Estimate approval links, search and approval policy. Real embedded PostgreSQL + actual Nest
// controllers. Run: npm run test:approvals:http
process.env.JWT_ACCESS_SECRET = 'test-only-access-secret-not-for-production-use';
process.env.JWT_REFRESH_SECRET = 'test-only-refresh-secret-not-for-production-use';
process.env.NODE_ENV = 'test';
const testDb = await setupHttpTestDb({ port: 15438 });
let app;
try {
  const mods = [
    'prisma/prisma.module#PrismaModule',
    'auth/auth.module#AuthModule',
    'customers/customers.module#CustomersModule',
    'repairs/repairs.module#RepairsModule',
    'tracking/tracking.module#TrackingModule',
    'approvals/approvals.module#ApprovalsModule',
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
  const mk = async (tok, branchId, name, phone) => {
    const c = (await api.post('/api/customers').set(auth(tok)).send({ name, phone }).expect(201))
      .body;
    const d = (
      await api
        .post(`/api/customers/${c.id}/devices`)
        .set(auth(tok))
        .send({ brand: 'Samsung', model: 'A54' })
        .expect(201)
    ).body;
    return (
      await api
        .post('/api/repairs')
        .set(auth(tok))
        .send({ customerId: c.id, deviceId: d.id, branchId, problemDescription: 'Screen cracked' })
        .expect(201)
    ).body;
  };
  const r1 = await mk(tokA, a.branch.id, 'Sara Private', '+201000000001');
  const r2 = await mk(tokA, a.branch.id, 'Omar Other', '+201555555555');
  const rb = await mk(tokB, b.branch.id, 'Sara Private', '+201000000001');

  // search
  const s1 = (await api.get('/api/repairs?search=00000001').set(auth(tokA)).expect(200)).body;
  assert.deepEqual(
    s1.items.map((i) => i.id),
    [r1.id],
  );
  assert.equal(s1.items[0].customer.name, 'Sara Private');
  assert.deepEqual(s1.items[0].device, { brand: 'Samsung', model: 'A54' });
  const s2 = (await api.get('/api/repairs?search=omar').set(auth(tokA)).expect(200)).body;
  assert.deepEqual(
    s2.items.map((i) => i.id),
    [r2.id],
  );
  const s3 = (
    await api
      .get(`/api/repairs?search=${r1.id.slice(-8)}`)
      .set(auth(tokA))
      .expect(200)
  ).body;
  assert.deepEqual(
    s3.items.map((i) => i.id),
    [r1.id],
  );
  const s4 = (await api.get('/api/repairs?search=00000001').set(auth(tokB)).expect(200)).body;
  assert.deepEqual(
    s4.items.map((i) => i.id),
    [rb.id],
    'search never crosses tenants',
  );
  await api.get('/api/repairs?search=a').set(auth(tokA)).expect(400);
  console.log('PASS search by phone, name, repair id; tenant isolated; min length');

  const path = `/api/repairs/${r1.id}/estimates`;
  await api.post(path).send({ amount: 100 }).expect(401);
  await api.post(path).set(auth(tokB)).send({ amount: 100 }).expect(404);
  await api.get(path).set(auth(tokB)).expect(404);
  await api.post(path).set(auth(tokA)).send({ amount: -5 }).expect(400);
  await api.post(path).set(auth(tokA)).send({ amount: 5, x: 1 }).expect(400);
  console.log('PASS estimate auth, cross-tenant 404, validation');

  const e1 = (
    await api
      .post(path)
      .set(auth(tokA))
      .send({ amount: 450.5, description: 'Replace screen' })
      .expect(201)
  ).body;
  assert.match(e1.token, /^[A-Za-z0-9_-]{32}$/);
  const stored = await prisma.withTenant(a.tenant.id, (tx) => tx.repairApproval.findMany());
  assert.ok(!JSON.stringify(stored).includes(e1.token), 'raw token must not be stored');
  assert.equal(
    (await prisma.repairApproval.findMany()).length,
    0,
    'RLS hides approvals without context',
  );
  const list = (await api.get(path).set(auth(tokA)).expect(200)).body;
  assert.equal(list.length, 1);
  assert.ok(!JSON.stringify(list).includes(e1.token) && !('tokenHash' in list[0]));
  console.log('PASS token hashed, RLS, list leaks no token');

  const pub = await api.get(`/api/public/approve/${e1.token}`).expect(200);
  assert.deepEqual(Object.keys(pub.body).sort(), [
    'amount',
    'decidedAt',
    'description',
    'device',
    'shop',
    'status',
  ]);
  assert.equal(pub.body.amount, '450.5');
  assert.equal(pub.body.status, 'pending');
  for (const secret of ['Sara', '+2010', r1.id, tokA])
    assert.ok(!JSON.stringify(pub.body).includes(secret));
  assert.equal(pub.headers['cache-control'], 'no-store');
  console.log('PASS public view minimal, no PII, no-store');

  for (const bad of ['x', 'A'.repeat(32), '../../etc', 'A'.repeat(200)]) {
    await api.get(`/api/public/approve/${encodeURIComponent(bad)}`).expect(404);
    await api
      .post(`/api/public/approve/${encodeURIComponent(bad)}`)
      .send({ decision: 'approve' })
      .expect(404);
  }
  await api.post(`/api/public/approve/${e1.token}`).send({ decision: 'maybe' }).expect(400);
  console.log('PASS guessed/malformed tokens 404, bad decision 400');

  // supersede
  const e2 = (await api.post(path).set(auth(tokA)).send({ amount: 400 }).expect(201)).body;
  await api.get(`/api/public/approve/${e1.token}`).expect(404);
  await api.post(`/api/public/approve/${e1.token}`).send({ decision: 'approve' }).expect(404);
  console.log('PASS superseded estimate link is dead');

  // policy gate
  await api.get('/api/tenants/me/approval-policy').set(auth(tokB)).expect(200);
  await api
    .put('/api/tenants/me/approval-policy')
    .send({ requireEstimateApproval: true })
    .expect(401);
  await api
    .put('/api/tenants/me/approval-policy')
    .set(auth(tokA))
    .send({ requireEstimateApproval: 'yes' })
    .expect(400);
  await api
    .put('/api/tenants/me/approval-policy')
    .set(auth(tokA))
    .send({ requireEstimateApproval: true })
    .expect(200);
  assert.equal(
    (await api.get('/api/tenants/me/approval-policy').set(auth(tokB)).expect(200)).body
      .requireEstimateApproval,
    false,
  );
  const go = async (id, to, ver, tok = tokA) =>
    api
      .post(`/api/repairs/${id}/transition`)
      .set(auth(tok))
      .send({ toStatus: to, expectedVersion: ver });
  await (
    await go(r1.id, 'diagnosing', 0)
  ).body;
  const t = await go(r1.id, 'awaiting_approval', 1);
  assert.equal(t.status, 200);
  const blocked = await go(r1.id, 'in_repair', 2);
  assert.equal(blocked.status, 422);
  console.log('PASS gate blocks in_repair while estimate pending');

  const rej = await api
    .post(`/api/public/approve/${e2.token}`)
    .send({ decision: 'reject' })
    .expect(200);
  assert.equal(rej.body.status, 'rejected');
  await api.post(`/api/public/approve/${e2.token}`).send({ decision: 'approve' }).expect(409);
  assert.equal((await go(r1.id, 'in_repair', 2)).status, 422);
  console.log('PASS single use (409), rejected still blocks');

  const e3 = (await api.post(path).set(auth(tokA)).send({ amount: 300 }).expect(201)).body;
  await api.post(`/api/public/approve/${e3.token}`).send({ decision: 'approve' }).expect(200);
  await api.post(`/api/public/approve/${e3.token}`).send({ decision: 'reject' }).expect(409);
  assert.equal((await api.get(path).set(auth(tokA)).expect(200)).body[0].status, 'approved');
  assert.equal((await go(r1.id, 'in_repair', 2)).status, 200);
  console.log('PASS approved estimate unlocks in_repair');

  // expiry
  const e4 = (
    await api
      .post(`/api/repairs/${r2.id}/estimates`)
      .set(auth(tokA))
      .send({ amount: 10 })
      .expect(201)
  ).body;
  await api.get(`/api/public/approve/${e4.token}`).expect(200);
  await prisma.withTenant(a.tenant.id, (tx) =>
    tx.repairApproval.updateMany({
      where: { id: e4.id },
      data: { expiresAt: new Date(Date.now() - 1000) },
    }),
  );
  await api.get(`/api/public/approve/${e4.token}`).expect(404);
  await api.post(`/api/public/approve/${e4.token}`).send({ decision: 'approve' }).expect(404);
  console.log('PASS expired estimate is 404');

  // policy off for tenant B: no gate
  await go(rb.id, 'diagnosing', 0, tokB);
  await go(rb.id, 'awaiting_approval', 1, tokB);
  assert.equal((await go(rb.id, 'in_repair', 2, tokB)).status, 200);
  console.log('PASS gate off by default; other tenant unaffected');

  let first429;
  for (let i = 0; i < 80; i++) {
    const r = await api.get(`/api/public/approve/${'B'.repeat(32)}`);
    if (r.status === 429) {
      first429 = i;
      break;
    }
  }
  assert.ok(first429 !== undefined, 'rate limit must trigger');
  console.log('PASS public approval is rate limited');
  console.log('PASS approvals harness: all cases passed');
} catch (e) {
  console.error('Approvals harness failed:', e);
  process.exitCode = 1;
} finally {
  if (app) await app.close();
  await testDb.stop();
}
