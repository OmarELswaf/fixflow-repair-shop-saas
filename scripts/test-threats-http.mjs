/* global console, process, URL */
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { setupHttpTestDb } from './http-test-db.mjs';
process.chdir(fileURLToPath(new URL('../', import.meta.url)));
const require = createRequire(import.meta.url);
const { Test } = require('@nestjs/testing');
const request = require('supertest');
const argon2 = require('argon2');

// Threat tests from docs/SECURITY.md, wired to run for real.
// Dummy data only, embedded PGlite by default (or a gated local PG16
// test database, see scripts/http-test-db.mjs). Each threat from the
// SECURITY.md list ends in exactly one state: PASS, FAIL, or N/A with
// the reason (feature absent or covered elsewhere). Nothing here is
// marked passed by assumption.
//
// Run via `npm run test:threats:http` (builds the API first).

process.env.JWT_ACCESS_SECRET = 'test-only-secret-not-for-production';
process.env.JWT_REFRESH_SECRET = 'test-only-refresh-not-for-production';
process.env.NODE_ENV = 'test';

const results = [];
function record(name, status, detail = '') {
  results.push({ name, status, detail });
  console.log(`${status} ${name}${detail ? ` — ${detail}` : ''}`);
}
async function check(name, fn) {
  try {
    await fn();
    record(name, 'PASS');
  } catch (error) {
    record(name, 'FAIL', error instanceof Error ? error.message : String(error));
  }
}
function na(name, reason) {
  record(name, 'N/A', reason);
}
function expectEqual(actual, expected, what) {
  if (actual !== expected) throw new Error(`${what}: expected ${expected}, got ${actual}`);
}

const testDb = await setupHttpTestDb({ port: 15433 });
let app;
try {
  const { PrismaModule } = require('../apps/api/dist/prisma/prisma.module');
  const { AuthModule } = require('../apps/api/dist/auth/auth.module');
  const { CustomersModule } = require('../apps/api/dist/customers/customers.module');
  const { RepairsModule } = require('../apps/api/dist/repairs/repairs.module');
  const { InventoryModule } = require('../apps/api/dist/inventory/inventory.module');
  const { ReportsModule } = require('../apps/api/dist/reports/reports.module');
  const { PrismaService } = require('../apps/api/dist/prisma/prisma.service');
  const mod = await Test.createTestingModule({
    imports: [
      PrismaModule,
      AuthModule,
      CustomersModule,
      RepairsModule,
      InventoryModule,
      ReportsModule,
    ],
  }).compile();
  app = mod.createNestApplication();
  app.setGlobalPrefix('api');
  await app.init();
  const prisma = mod.get(PrismaService);
  const api = request(app.getHttpServer());

  // Fixtures: two independent tenants, A and B.
  const a = (
    await api
      .post('/api/auth/register')
      .send({
        email: 'owner-a@example.test',
        password: 'twelve-chars-min',
        tenantName: 'Shop A',
        branchName: 'Main',
      })
      .expect(201)
  ).body;
  const b = (
    await api
      .post('/api/auth/register')
      .send({
        email: 'owner-b@example.test',
        password: 'twelve-chars-min',
        tenantName: 'Shop B',
        branchName: 'Main',
      })
      .expect(201)
  ).body;
  const authA = { Authorization: `Bearer ${a.tokens.accessToken}` };
  const authB = { Authorization: `Bearer ${b.tokens.accessToken}` };

  const customerA = (
    await api
      .post('/api/customers')
      .set(authA)
      .send({ name: 'Customer A', phone: '+201000000000' })
      .expect(201)
  ).body;
  const deviceA = (
    await api
      .post(`/api/customers/${customerA.id}/devices`)
      .set(authA)
      .send({ brand: 'Apple', model: 'iPhone 12' })
      .expect(201)
  ).body;
  const partA = (
    await api
      .post('/api/parts')
      .set(authA)
      .send({ sku: 'SCR-IP12', name: 'iPhone 12 screen' })
      .expect(201)
  ).body;
  const repairA = (
    await api
      .post('/api/repairs')
      .set(authA)
      .send({
        customerId: customerA.id,
        deviceId: deviceA.id,
        branchId: a.branch.id,
        problemDescription: 'broken screen',
      })
      .expect(201)
  ).body;

  // 1. Cross-tenant IDOR: B cannot address A's resources by id.
  await check('cross-tenant IDOR: customer detail', async () => {
    await api.get(`/api/customers/${customerA.id}`).set(authB).expect(404);
  });
  await check('cross-tenant IDOR: repair detail', async () => {
    await api.get(`/api/repairs/${repairA.id}`).set(authB).expect(404);
  });
  await check('cross-tenant IDOR: part detail', async () => {
    await api.get(`/api/parts/${partA.id}`).set(authB).expect(404);
  });
  await check('cross-tenant IDOR: branch-scoped report outside scope', async () => {
    await api.get(`/api/reports/repairs/summary?branchId=${a.branch.id}`).set(authB).expect(403);
  });
  await check('cross-tenant IDOR: own-tenant report leaks nothing of A', async () => {
    const res = await api.get('/api/reports/repairs/summary').set(authB).expect(200);
    const body = JSON.stringify(res.body);
    if (body.includes(repairA.id) || body.includes(customerA.id)) {
      throw new Error('B report response contains tenant A identifiers');
    }
  });

  // 2. Client tenant spoof: a forged tenant header is ignored.
  await check('client tenant spoof (forged header ignored)', async () => {
    const res = await api
      .get('/api/customers')
      .set(authB)
      .set('x-tenant-id', a.tenant.id)
      .expect(200);
    if (JSON.stringify(res.body).includes(customerA.id)) {
      throw new Error("forged tenant header returned tenant A's customer");
    }
  });

  // 3. Branch escalation: a member scoped to branch 1 cannot read or
  // write branch 2 of the same tenant.
  let branchA2;
  let recToken;
  {
    branchA2 = await prisma.withTenant(a.tenant.id, (tx) =>
      tx.branch.create({ data: { tenantId: a.tenant.id, name: 'Second' } }),
    );
    const recUser = await prisma.user.create({
      data: {
        email: 'rec-a@example.test',
        name: 'Receptionist A',
        passwordHash: await argon2.hash('twelve-chars-min'),
      },
    });
    await prisma.withTenant(a.tenant.id, (tx) =>
      tx.membership.create({
        data: {
          userId: recUser.id,
          tenantId: a.tenant.id,
          role: 'receptionist',
          branchIds: [a.branch.id],
        },
      }),
    );
    const recLogin = (
      await api
        .post('/api/auth/login')
        .send({ email: 'rec-a@example.test', password: 'twelve-chars-min' })
        .expect(200)
    ).body;
    recToken = recLogin.tokens.accessToken;
  }
  const authRec = { Authorization: `Bearer ${recToken}` };
  await check('branch escalation: list repairs of out-of-scope branch', async () => {
    await api.get(`/api/repairs?branchId=${branchA2.id}`).set(authRec).expect(403);
  });
  await check('branch escalation: create repair in out-of-scope branch', async () => {
    await api
      .post('/api/repairs')
      .set(authRec)
      .send({
        customerId: customerA.id,
        deviceId: deviceA.id,
        branchId: branchA2.id,
        problemDescription: 'escalation attempt',
      })
      .expect(403);
  });
  await check('branch scoping still allows the in-scope branch', async () => {
    const res = await api.get('/api/repairs').set(authRec).expect(200);
    if (!JSON.stringify(res.body).includes(repairA.id)) {
      throw new Error('in-scope repair missing from the member list');
    }
  });

  // 4. RLS bypass: the app role without a tenant context reads nothing,
  // even though tenant A rows exist.
  await check('RLS default-deny: no tenant set, no customer rows', async () => {
    const rows = await prisma.customer.findMany({ take: 5 });
    expectEqual(rows.length, 0, 'customers visible without tenant context');
  });
  await check('RLS default-deny: no tenant set, no membership rows', async () => {
    const rows = await prisma.membership.findMany({ take: 5 });
    expectEqual(rows.length, 0, 'memberships visible without auth context');
  });

  // 5. Composite FK bypass: a repair_event cannot point at another
  // tenant's order, even when the row passes the RLS tenant check.
  await check('composite FK bypass: cross-tenant repair_event insert refused', async () => {
    let refused = false;
    try {
      await prisma.withTenant(
        b.tenant.id,
        (tx) =>
          tx.$executeRaw`INSERT INTO repair_events ("id", "tenantId", "orderId", "actorId", "toStatus", "createdAt")
          VALUES ('threat-test-event-1', ${b.tenant.id}, ${repairA.id}, 'threat-test', 'received', ${new Date()})`,
      );
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (!message.includes('23503') && !/foreign key/i.test(message)) throw error;
      refused = true;
    }
    if (!refused) throw new Error('cross-tenant repair_event insert was accepted');
  });

  // Threats covered elsewhere or not applicable in this phase.
  na(
    'refresh-token reuse (database-backed path)',
    'covered by scripts/test-auth-http.mjs: replay of a rotated cookie is 401 and revokes the family (runs in CI)',
  );
  na(
    'inventory race (last unit, two orders)',
    'needs true concurrent connections; covered by scripts/test-contention.mjs under `npm run test:pg16` (needs Docker + PostgreSQL 16)',
  );
  na('webhook replay and forgery', 'no webhook endpoints exist; subscriptions are schema-only');
  na(
    'quota bypass under concurrency',
    'quota enforcement is not implemented (entitlements unwired)',
  );
  na('money race (double payment / double refund)', 'no payments module exists in this phase');
  na('file access across tenants', 'no file storage exists in this phase');
} finally {
  if (app) await app.close();
  await testDb.stop();
}

const failedChecks = results.filter((r) => r.status === 'FAIL');
const passed = results.filter((r) => r.status === 'PASS').length;
const notApplicable = results.filter((r) => r.status === 'N/A').length;
console.log(
  `threat tests: ${passed} passed, ${failedChecks.length} failed, ${notApplicable} not applicable`,
);
if (failedChecks.length > 0) {
  process.exitCode = 1;
}
