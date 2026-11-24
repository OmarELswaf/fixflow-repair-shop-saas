/* global console, process, URL */
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { setupHttpTestDb } from './http-test-db.mjs';
process.chdir(fileURLToPath(new URL('../', import.meta.url)));
const require = createRequire(import.meta.url);
const { Test } = require('@nestjs/testing');
const request = require('supertest');
const argon2 = require('argon2');

// Real embedded PostgreSQL engine over a TCP socket, actual Nest
// controllers, actual Argon2/JWT/Prisma. Does not validate Docker
// startup, a normal PostgreSQL 16 installation, real independent
// connections, or production concurrency. Run via
// `npm run test:reports:http` (builds the API first). With
// FIXFLOW_HTTP_DATABASE_URL set (and gated), the same cases run
// against a normal PostgreSQL 16 database instead — see
// scripts/http-test-db.mjs.
process.env.JWT_ACCESS_SECRET = 'test-only-secret-not-for-production';
process.env.JWT_REFRESH_SECRET = 'test-only-refresh-not-for-production';
process.env.NODE_ENV = 'test';
process.env.DB_POOL_MAX = '1';
const testDb = await setupHttpTestDb({ port: 15435 });
let app;
try {
  const { PrismaModule } = require('../apps/api/dist/prisma/prisma.module');
  const { AuthModule } = require('../apps/api/dist/auth/auth.module');
  const { CustomersModule } = require('../apps/api/dist/customers/customers.module');
  const { RepairsModule } = require('../apps/api/dist/repairs/repairs.module');
  const { InventoryModule } = require('../apps/api/dist/inventory/inventory.module');
  const { ReportsModule } = require('../apps/api/dist/reports/reports.module');
  const { AdminModule } = require('../apps/api/dist/admin/admin.module');
  const { PrismaService } = require('../apps/api/dist/prisma/prisma.service');
  const mod = await Test.createTestingModule({
    imports: [
      PrismaModule,
      AuthModule,
      CustomersModule,
      RepairsModule,
      InventoryModule,
      ReportsModule,
      AdminModule,
    ],
  }).compile();
  app = mod.createNestApplication();
  app.setGlobalPrefix('api');
  await app.init();
  const prisma = mod.get(PrismaService);
  const api = request(app.getHttpServer());
  const auth = (token) => ({ Authorization: `Bearer ${token}` });

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
  const branchB = await prisma.withTenant(tenantA, async (tx) =>
    tx.branch.create({ data: { tenantId: tenantA, name: 'Second' } }),
  );
  await prisma.withTenant(tenantA, (tx) =>
    tx.membership.update({
      where: { userId_tenantId: { userId: a.user.id, tenantId: tenantA } },
      data: { branchIds: [branchA, branchB.id] },
    }),
  );
  const manager = await createStaff('manager@example.test', 'manager', [branchA, branchB.id]);
  const tech1 = await createStaff('tech-1@example.test', 'technician', [branchA]);
  const accountant = await createStaff('accountant@example.test', 'accountant', [branchA]);
  const cashier = await createStaff('cashier@example.test', 'cashier', [branchA]);
  const receptionist = await createStaff('reception@example.test', 'receptionist', [branchA]);
  const b = (
    await api
      .post('/api/auth/register')
      .send({ ...ownerA, email: 'owner-b@example.test', tenantName: 'Shop B' })
      .expect(201)
  ).body;
  const tokenB = b.tokens.accessToken;

  async function makeCustomerDevice(token) {
    const customer = (
      await api.post('/api/customers').set(auth(token)).send({ name: 'Sara' }).expect(201)
    ).body;
    const device = (
      await api
        .post(`/api/customers/${customer.id}/devices`)
        .set(auth(token))
        .send({ brand: 'Samsung', model: 'A54' })
        .expect(201)
    ).body;
    return { customer, device };
  }
  const { customer, device } = await makeCustomerDevice(tokenA);
  const other = await makeCustomerDevice(tokenB);

  async function createRepair(token, branchId, overrides = {}) {
    return (
      await api
        .post('/api/repairs')
        .set(auth(token))
        .send({
          customerId: customer.id,
          deviceId: device.id,
          branchId,
          problemDescription: 'Screen cracked',
          ...overrides,
        })
        .expect(201)
    ).body;
  }
  async function backdate(repairId, daysAgo) {
    await prisma.withTenant(tenantA, (tx) =>
      tx.repairOrder.update({
        where: { id: repairId },
        data: { createdAt: new Date(Date.now() - daysAgo * 24 * 60 * 60 * 1000) },
      }),
    );
  }

  // --- Parts + stock ---
  async function makePart(token, sku) {
    return (
      await api
        .post('/api/parts')
        .set(auth(token))
        .send({ sku, name: `Part ${sku}` })
        .expect(201)
    ).body;
  }
  async function adjust(token, branchId, partId, delta, key) {
    return (
      await api
        .post('/api/stock/adjust')
        .set(auth(token))
        .send({ branchId, partId, delta, idempotencyKey: key })
        .expect(200)
    ).body;
  }
  const partA1 = await makePart(tokenA, 'SCREEN-A54');
  const partA2 = await makePart(tokenA, 'BAT-A54');
  const partA3 = await makePart(tokenA, 'GLASS-A54');
  const partB1 = await makePart(tokenB, 'SCREEN-B');
  await adjust(tokenA, branchA, partA1.id, 10, 'rep-adjust-00000001');
  await adjust(tokenA, branchB.id, partA1.id, 4, 'rep-adjust-00000002');
  await adjust(tokenA, branchA, partA2.id, 5, 'rep-adjust-00000003');
  await adjust(tokenA, branchA, partA3.id, 5, 'rep-adjust-00000004');
  await adjust(tokenB, b.branch.id, partB1.id, 7, 'rep-adjust-00000005');

  // --- Repairs for the summary (created before any later repairs) ---
  const r1 = await createRepair(tokenA, branchA);
  const r2 = await createRepair(tokenA, branchA);
  await api
    .post(`/api/repairs/${r2.id}/transition`)
    .set(auth(tokenA))
    .send({ toStatus: 'diagnosing', expectedVersion: 0 })
    .expect(200);
  await backdate(r2.id, 3);
  const r3 = await createRepair(tokenA, branchA);
  await api
    .post(`/api/repairs/${r3.id}/transition`)
    .set(auth(tokenA))
    .send({ toStatus: 'diagnosing', expectedVersion: 0 })
    .expect(200);
  await api
    .post(`/api/repairs/${r3.id}/transition`)
    .set(auth(tokenA))
    .send({ toStatus: 'awaiting_parts', expectedVersion: 1 })
    .expect(200);
  await backdate(r3.id, 10);
  const r4 = await createRepair(tokenA, branchA);
  await backdate(r4.id, 40);
  const r5 = await createRepair(tokenA, branchB.id);
  void r5; // Counted by the branch-B summary; never reserved against.
  const bRepair = (
    await api
      .post('/api/repairs')
      .set(auth(tokenB))
      .send({
        customerId: other.customer.id,
        deviceId: other.device.id,
        branchId: b.branch.id,
        problemDescription: 'Tenant B repair',
      })
      .expect(201)
  ).body;
  void bRepair;

  // --- Repairs summary ---
  const summary = (await api.get('/api/reports/repairs/summary').set(auth(tokenA)).expect(200))
    .body;
  const byStatus = Object.fromEntries(summary.byStatus.map((s) => [s.status, s.count]));
  const aging = Object.fromEntries(summary.aging.map((s) => [s.bucket, s.count]));
  if (
    summary.total !== 5 ||
    byStatus.received !== 3 ||
    byStatus.diagnosing !== 1 ||
    byStatus.awaiting_parts !== 1
  ) {
    throw new Error(`Summary counts wrong: ${JSON.stringify(summary)}`);
  }
  if (aging['0-1d'] !== 2 || aging['2-7d'] !== 1 || aging['8-30d'] !== 1 || aging['30d+'] !== 1) {
    throw new Error(`Aging buckets wrong: ${JSON.stringify(summary.aging)}`);
  }
  const receivedOnly = (
    await api
      .get('/api/reports/repairs/summary')
      .set(auth(tokenA))
      .query({ status: 'received' })
      .expect(200)
  ).body;
  if (
    receivedOnly.total !== 3 ||
    receivedOnly.byStatus.length !== 1 ||
    receivedOnly.byStatus[0].status !== 'received'
  ) {
    throw new Error(`Status filter wrong: ${JSON.stringify(receivedOnly)}`);
  }
  const branchBSummary = (
    await api
      .get('/api/reports/repairs/summary')
      .set(auth(tokenA))
      .query({ branchId: branchB.id })
      .expect(200)
  ).body;
  if (branchBSummary.total !== 1) {
    throw new Error(`Branch filter wrong: ${JSON.stringify(branchBSummary)}`);
  }
  await api
    .get('/api/reports/repairs/summary')
    .set(auth(tokenA))
    .query({ branchId: b.branch.id })
    .expect(403);
  const recentOnly = (
    await api
      .get('/api/reports/repairs/summary')
      .set(auth(tokenA))
      .query({ from: new Date(Date.now() - 2 * 24 * 60 * 60 * 1000).toISOString() })
      .expect(200)
  ).body;
  if (recentOnly.total !== 2) throw new Error(`From filter wrong: ${JSON.stringify(recentOnly)}`);
  const oldOnly = (
    await api
      .get('/api/reports/repairs/summary')
      .set(auth(tokenA))
      .query({ to: new Date(Date.now() - 5 * 24 * 60 * 60 * 1000).toISOString() })
      .expect(200)
  ).body;
  if (oldOnly.total !== 2) throw new Error(`To filter wrong: ${JSON.stringify(oldOnly)}`);
  await api
    .get('/api/reports/repairs/summary')
    .set(auth(tokenA))
    .query({ status: 'nope' })
    .expect(400);
  await api
    .get('/api/reports/repairs/summary')
    .set(auth(tokenA))
    .query({ from: 'not-a-date' })
    .expect(400);
  await api.get('/api/reports/repairs/summary').set(auth(tech1.token)).expect(403);
  await api.get('/api/reports/repairs/summary').set(auth(cashier.token)).expect(403);
  await api.get('/api/reports/repairs/summary').set(auth(receptionist.token)).expect(403);
  await api.get('/api/reports/repairs/summary').set(auth(accountant.token)).expect(200);
  // Snapshot label: one ISO timestamp, and the parts agree with the whole.
  if (!summary.snapshotAt || Number.isNaN(Date.parse(summary.snapshotAt))) {
    throw new Error(`Summary snapshotAt missing or not ISO: ${JSON.stringify(summary)}`);
  }
  const byStatusTotal = summary.byStatus.reduce((n, s) => n + s.count, 0);
  const agingTotal = summary.aging.reduce((n, s) => n + s.count, 0);
  if (byStatusTotal !== summary.total || agingTotal !== summary.total) {
    throw new Error(`Summary parts must sum to total: ${JSON.stringify(summary)}`);
  }
  console.log('PASS reports summary: counts, aging buckets, status/branch/date filters, roles');

  // --- Team (owner only, read-only) ---
  const team = (await api.get('/api/admin/team').set(auth(tokenA)).expect(200)).body;
  if (
    team.branches.length !== 2 ||
    !team.branches.some((x) => x.name === 'Main') ||
    !team.branches.some((x) => x.name === 'Second')
  ) {
    throw new Error(`Team branches wrong: ${JSON.stringify(team.branches)}`);
  }
  if (team.members.length !== 6) {
    throw new Error(`Team must list 6 members, got ${team.members.length}`);
  }
  const techMember = team.members.find((m) => m.email === 'tech-1@example.test');
  if (
    !techMember ||
    techMember.role !== 'technician' ||
    techMember.branchIds.length !== 1 ||
    techMember.branchIds[0] !== branchA ||
    techMember.branchNames[0] !== 'Main'
  ) {
    throw new Error(`Team member shape wrong: ${JSON.stringify(techMember)}`);
  }
  if (JSON.stringify(team).includes('passwordHash')) {
    throw new Error('Team response must never include password hashes');
  }
  await api.get('/api/admin/team').set(auth(manager.token)).expect(403);
  await api.get('/api/admin/team').set(auth(accountant.token)).expect(403);
  console.log('PASS team: owner-only read, branches + members with branch names');

  // --- Reserve flows that feed reconciliation + trace ---
  const reserve1 = (
    await api
      .post(`/api/repairs/${r1.id}/parts`)
      .set(auth(tokenA))
      .send({ partId: partA1.id, qty: 3, idempotencyKey: 'rep-recon-00000001' })
      .expect(200)
  ).body;
  const rTrace = await createRepair(tokenA, branchA);
  const traceLine = (
    await api
      .post(`/api/repairs/${rTrace.id}/parts`)
      .set(auth(manager.token))
      .send({ partId: partA1.id, qty: 1, idempotencyKey: 'rep-trace-00000001' })
      .expect(200)
  ).body;
  void reserve1;

  // --- Deterministic retry: same reserve key 3x concurrently ---
  const rD = await createRepair(tokenA, branchA);
  const dupAttempts = await Promise.all(
    Array.from({ length: 3 }, () =>
      api
        .post(`/api/repairs/${rD.id}/parts`)
        .set(auth(tokenA))
        .send({ partId: partA3.id, qty: 2, idempotencyKey: 'rep-dup-00000001' })
        .expect(200),
    ),
  );
  const dupBodies = dupAttempts.map((r) => r.body);
  if (!dupBodies.every((x) => x.id === dupBodies[0].id && x.qty === 2 && x.status === 'reserved')) {
    throw new Error('Same-key retries must return the identical stored line');
  }
  const dupMoves = (
    await api
      .get('/api/stock/movements')
      .set(auth(tokenA))
      .query({ branchId: branchA, partId: partA3.id, limit: 100 })
      .expect(200)
  ).body;
  if (dupMoves.items.filter((m) => m.operationKey === 'rep-dup-00000001').length !== 1) {
    throw new Error('Same-key retries must create exactly one movement');
  }
  console.log('PASS deterministic retry: 3x same-key reserve, identical line, one movement');

  // --- Stock reconciliation (with a direct-DB drift, then restored) ---
  const recon = (
    await api.get('/api/reports/stock').set(auth(tokenA)).query({ branchId: branchA }).expect(200)
  ).body;
  const rowA1 = recon.items.find((r) => r.partId === partA1.id);
  const rowA2 = recon.items.find((r) => r.partId === partA2.id);
  const rowA3 = recon.items.find((r) => r.partId === partA3.id);
  if (
    !rowA1 ||
    rowA1.qtyOnHand !== 10 ||
    rowA1.reservedQty !== 4 ||
    rowA1.available !== 6 ||
    rowA1.reservedLinesTotal !== 4 ||
    rowA1.discrepancy !== 0 ||
    rowA1.reconciled !== true
  ) {
    throw new Error(`Reconciliation row A1 wrong: ${JSON.stringify(rowA1)}`);
  }
  if (
    !rowA2 ||
    rowA2.qtyOnHand !== 5 ||
    rowA2.reservedQty !== 0 ||
    rowA2.available !== 5 ||
    rowA2.reconciled !== true
  ) {
    throw new Error(`Reconciliation row A2 wrong: ${JSON.stringify(rowA2)}`);
  }
  if (!rowA3 || rowA3.reservedQty !== 2 || rowA3.reservedLinesTotal !== 2 || !rowA3.reconciled) {
    throw new Error(`Reconciliation row A3 wrong: ${JSON.stringify(rowA3)}`);
  }
  if (recon.items.some((r) => r.partId === partB1.id)) {
    throw new Error('Stock report must not leak the other tenant');
  }
  // Drift: the counter runs ahead of the lines (simulates a missed release).
  await prisma.withTenant(tenantA, (tx) =>
    tx.branchStock.update({
      where: {
        tenantId_branchId_partId: { tenantId: tenantA, branchId: branchA, partId: partA1.id },
      },
      data: { reservedQty: 6 },
    }),
  );
  const drifted = (
    await api
      .get('/api/reports/stock')
      .set(auth(tokenA))
      .query({ branchId: branchA, partId: partA1.id })
      .expect(200)
  ).body;
  if (
    drifted.items.length !== 1 ||
    drifted.items[0].discrepancy !== 2 ||
    drifted.items[0].reconciled !== false
  ) {
    throw new Error(`Drift must show discrepancy 2: ${JSON.stringify(drifted.items)}`);
  }
  const summaryDrifted = (
    await api
      .get('/api/reports/stock/summary')
      .set(auth(tokenA))
      .query({ branchId: branchA })
      .expect(200)
  ).body;
  if (summaryDrifted.mismatchedRows !== 1) {
    throw new Error(`Drifted summary must report 1 mismatch: ${JSON.stringify(summaryDrifted)}`);
  }
  await prisma.withTenant(tenantA, (tx) =>
    tx.branchStock.update({
      where: {
        tenantId_branchId_partId: { tenantId: tenantA, branchId: branchA, partId: partA1.id },
      },
      data: { reservedQty: 4 },
    }),
  );
  const summaryClean = (
    await api
      .get('/api/reports/stock/summary')
      .set(auth(tokenA))
      .query({ branchId: branchA })
      .expect(200)
  ).body;
  if (
    summaryClean.totalParts !== 3 ||
    summaryClean.totalOnHand !== 20 ||
    summaryClean.totalReserved !== 6 ||
    summaryClean.totalAvailable !== 14 ||
    summaryClean.mismatchedRows !== 0
  ) {
    throw new Error(`Clean summary wrong: ${JSON.stringify(summaryClean)}`);
  }
  const summaryB = (
    await api
      .get('/api/reports/stock/summary')
      .set(auth(tokenA))
      .query({ branchId: branchB.id })
      .expect(200)
  ).body;
  if (
    summaryB.totalParts !== 1 ||
    summaryB.totalOnHand !== 4 ||
    summaryB.totalReserved !== 0 ||
    summaryB.totalAvailable !== 4 ||
    summaryB.mismatchedRows !== 0
  ) {
    throw new Error(`Branch B summary wrong: ${JSON.stringify(summaryB)}`);
  }
  // Pagination: limit 1 walks all three branch-A rows via cursor.
  const page1 = (
    await api
      .get('/api/reports/stock')
      .set(auth(tokenA))
      .query({ branchId: branchA, limit: 1 })
      .expect(200)
  ).body;
  if (page1.items.length !== 1 || !page1.nextCursor) {
    throw new Error(`Page 1 wrong: ${JSON.stringify(page1)}`);
  }
  const page2 = (
    await api
      .get('/api/reports/stock')
      .set(auth(tokenA))
      .query({ branchId: branchA, limit: 1, cursor: page1.nextCursor })
      .expect(200)
  ).body;
  if (page2.items.length !== 1 || !page2.nextCursor) {
    throw new Error(`Page 2 wrong: ${JSON.stringify(page2)}`);
  }
  const page3 = (
    await api
      .get('/api/reports/stock')
      .set(auth(tokenA))
      .query({ branchId: branchA, limit: 1, cursor: page2.nextCursor })
      .expect(200)
  ).body;
  if (page3.items.length !== 1 || page3.nextCursor !== null) {
    throw new Error(`Page 3 wrong: ${JSON.stringify(page3)}`);
  }
  if (new Set([page1.items[0].partId, page2.items[0].partId, page3.items[0].partId]).size !== 3) {
    throw new Error('Pagination must visit three distinct rows');
  }
  await api
    .get('/api/reports/stock')
    .set(auth(tokenA))
    .query({ branchId: b.branch.id })
    .expect(403);
  await api.get('/api/reports/stock').set(auth(tokenA)).query({ cursor: 'bad' }).expect(400);
  await api.get('/api/reports/stock').set(auth(tech1.token)).expect(403);
  await api.get('/api/reports/stock').set(auth(cashier.token)).expect(403);
  console.log('PASS stock reconciliation: row math, drift + restore, summary, pagination, scoping');

  // --- Stock overview: summary + page from one snapshot ---
  const overview = (
    await api
      .get('/api/reports/stock/overview')
      .set(auth(tokenA))
      .query({ branchId: branchA, limit: 1 })
      .expect(200)
  ).body;
  if (!overview.snapshotAt || Number.isNaN(Date.parse(overview.snapshotAt))) {
    throw new Error(`Overview snapshotAt missing or not ISO: ${JSON.stringify(overview)}`);
  }
  if (
    overview.summary.totalParts !== 3 ||
    overview.summary.totalOnHand !== 20 ||
    overview.summary.totalReserved !== 6 ||
    overview.summary.totalAvailable !== 14 ||
    overview.summary.mismatchedRows !== 0
  ) {
    throw new Error(`Overview summary wrong: ${JSON.stringify(overview.summary)}`);
  }
  // Full cursor scan: the summary must equal the sums over the scanned
  // rows. No concurrent writes happen in this harness, so the per-page
  // snapshots agree; the check is that summary and rows agree within
  // one response and the summary stays stable across its pages.
  const scanned = [];
  let overviewCursor = null;
  do {
    const page = (
      await api
        .get('/api/reports/stock/overview')
        .set(auth(tokenA))
        .query({
          branchId: branchA,
          limit: 1,
          ...(overviewCursor ? { cursor: overviewCursor } : {}),
        })
        .expect(200)
    ).body;
    if (!page.snapshotAt || Number.isNaN(Date.parse(page.snapshotAt))) {
      throw new Error(`Overview page snapshotAt missing or not ISO: ${JSON.stringify(page)}`);
    }
    if (JSON.stringify(page.summary) !== JSON.stringify(overview.summary)) {
      throw new Error(`Overview summary changed across pages: ${JSON.stringify(page.summary)}`);
    }
    scanned.push(...page.items);
    overviewCursor = page.nextCursor;
  } while (overviewCursor);
  if (scanned.length !== 3) {
    throw new Error(`Overview scan must visit 3 rows, got ${scanned.length}`);
  }
  const overviewSum = (key) => scanned.reduce((n, r) => n + r[key], 0);
  if (
    overviewSum('qtyOnHand') !== overview.summary.totalOnHand ||
    overviewSum('reservedQty') !== overview.summary.totalReserved ||
    overviewSum('available') !== overview.summary.totalAvailable ||
    scanned.filter((r) => !r.reconciled).length !== overview.summary.mismatchedRows
  ) {
    throw new Error(
      `Overview summary disagrees with scanned rows: ${JSON.stringify(overview.summary)} vs ${JSON.stringify(scanned)}`,
    );
  }
  const overviewPart = (
    await api
      .get('/api/reports/stock/overview')
      .set(auth(tokenA))
      .query({ branchId: branchA, partId: partA1.id })
      .expect(200)
  ).body;
  if (
    overviewPart.summary.totalParts !== 1 ||
    overviewPart.summary.totalOnHand !== 10 ||
    overviewPart.items.length !== 1 ||
    overviewPart.items[0].partId !== partA1.id
  ) {
    throw new Error(`Overview part filter wrong: ${JSON.stringify(overviewPart)}`);
  }
  const overviewB = (
    await api
      .get('/api/reports/stock/overview')
      .set(auth(tokenA))
      .query({ branchId: branchB.id })
      .expect(200)
  ).body;
  if (overviewB.summary.totalParts !== 1 || overviewB.items.length !== 1) {
    throw new Error(`Branch B overview wrong: ${JSON.stringify(overviewB)}`);
  }
  await api
    .get('/api/reports/stock/overview')
    .set(auth(tokenA))
    .query({ cursor: 'bad' })
    .expect(400);
  await api
    .get('/api/reports/stock/overview')
    .set(auth(tokenA))
    .query({ cursor: 'one:two:three' })
    .expect(400);
  await api
    .get('/api/reports/stock/overview')
    .set(auth(tokenA))
    .query({ branchId: b.branch.id })
    .expect(403);
  await api.get('/api/reports/stock/overview').set(auth(tech1.token)).expect(403);
  await api.get('/api/reports/stock/overview').set(auth(cashier.token)).expect(403);
  console.log('PASS stock overview: one-snapshot summary + page, full-scan agreement, scoping');

  // --- Movement trace fields ---
  const traceMoves = (
    await api
      .get('/api/stock/movements')
      .set(auth(tokenA))
      .query({ branchId: branchA, partId: partA1.id, limit: 100 })
      .expect(200)
  ).body;
  const traceMove = traceMoves.items.find((m) => m.operationKey === 'rep-trace-00000001');
  if (
    !traceMove ||
    traceMove.repairOrderId !== rTrace.id ||
    traceMove.repairPartId !== traceLine.id ||
    traceMove.actorId !== manager.user.id ||
    traceMove.actorName !== 'manager' ||
    traceMove.reason !== 'reserve'
  ) {
    throw new Error(`Trace movement wrong: ${JSON.stringify(traceMove)}`);
  }
  const adjustMove = traceMoves.items.find((m) => m.operationKey === 'rep-adjust-00000001');
  if (
    !adjustMove ||
    adjustMove.repairOrderId !== null ||
    adjustMove.repairPartId !== null ||
    adjustMove.actorId !== a.user.id
  ) {
    throw new Error(`Adjust movement trace wrong: ${JSON.stringify(adjustMove)}`);
  }
  console.log('PASS movement trace: repair/line/operation/actor on reserve and adjust');

  // --- Movements by operationKey (durable-retry reconciliation) ---
  const byKey = (
    await api
      .get('/api/stock/movements')
      .set(auth(tokenA))
      .query({ operationKey: 'rep-trace-00000001' })
      .expect(200)
  ).body;
  if (
    byKey.items.length !== 1 ||
    byKey.items[0].repairOrderId !== rTrace.id ||
    byKey.items[0].repairPartId !== traceLine.id ||
    byKey.items[0].actorId !== manager.user.id ||
    byKey.items[0].actorName !== 'manager'
  ) {
    throw new Error(`operationKey filter wrong: ${JSON.stringify(byKey.items)}`);
  }
  // Combines with the branch filter: the same key in the other branch finds nothing.
  const byKeyWrongBranch = (
    await api
      .get('/api/stock/movements')
      .set(auth(tokenA))
      .query({ operationKey: 'rep-trace-00000001', branchId: branchB.id })
      .expect(200)
  ).body;
  if (byKeyWrongBranch.items.length !== 0) {
    throw new Error(
      `operationKey + wrong branch must be empty: ${JSON.stringify(byKeyWrongBranch.items)}`,
    );
  }
  const byUnknownKey = (
    await api
      .get('/api/stock/movements')
      .set(auth(tokenA))
      .query({ operationKey: 'rep-nope-00000001' })
      .expect(200)
  ).body;
  if (byUnknownKey.items.length !== 0) {
    throw new Error(
      `Unknown operationKey must return an empty page: ${JSON.stringify(byUnknownKey.items)}`,
    );
  }
  await api
    .get('/api/stock/movements')
    .set(auth(tokenA))
    .query({ operationKey: 'short' })
    .expect(400);
  console.log(
    'PASS movements operationKey filter: exact match, branch combination, unknown key, validation',
  );

  // --- operationKey filter: cross-tenant isolation (Phase 8) ---
  // The same key value written under tenant B must not leak into
  // tenant A results, and vice versa. Idempotency keys are scoped
  // per tenant, so the same value can exist in both.
  await adjust(tokenB, b.branch.id, partB1.id, 1, 'rep-trace-00000001');
  const byKeyB = (
    await api
      .get('/api/stock/movements')
      .set(auth(tokenB))
      .query({ operationKey: 'rep-trace-00000001' })
      .expect(200)
  ).body;
  if (
    byKeyB.items.length !== 1 ||
    byKeyB.items[0].repairOrderId !== null ||
    byKeyB.items[0].actorId !== b.user.id ||
    byKeyB.items[0].branchId !== b.branch.id
  ) {
    throw new Error(`operationKey filter must be tenant-scoped: ${JSON.stringify(byKeyB.items)}`);
  }
  if (byKeyB.items[0].id === byKey.items[0].id) {
    throw new Error('Tenant A and B movements with the same key must be different rows');
  }
  // Out-of-scope branch combined with the filter is 403, not an empty page.
  await api
    .get('/api/stock/movements')
    .set(auth(tokenA))
    .query({ operationKey: 'rep-trace-00000001', branchId: b.branch.id })
    .expect(403);
  // Exact lookup among many movements: the unfiltered ledger holds
  // several rows, the filter still returns exactly one.
  const allMoves = (
    await api.get('/api/stock/movements').set(auth(tokenA)).query({ limit: 100 }).expect(200)
  ).body;
  if (allMoves.items.length <= 5) {
    throw new Error(`Expected several movements in the ledger, got ${allMoves.items.length}`);
  }
  const byKeyAgain = (
    await api
      .get('/api/stock/movements')
      .set(auth(tokenA))
      .query({ operationKey: 'rep-trace-00000001' })
      .expect(200)
  ).body;
  if (byKeyAgain.items.length !== 1 || byKeyAgain.items[0].id !== byKey.items[0].id) {
    throw new Error('operationKey filter must return exactly the one matching movement');
  }
  console.log(
    'PASS movements operationKey filter: cross-tenant isolation, out-of-scope branch 403, exact lookup among many',
  );

  // Aggregates must not overflow int4 when several valid rows are summed.
  await prisma.withTenant(tenantA, (tx) =>
    tx.branchStock.updateMany({
      where: { tenantId: tenantA, branchId: branchA },
      data: { qtyOnHand: 1000000000 },
    }),
  );
  const large = (
    await api
      .get('/api/reports/stock/summary')
      .set(auth(tokenA))
      .query({ branchId: branchA })
      .expect(200)
  ).body;
  if (large.totalOnHand !== 3000000000) throw new Error('Aggregate int4 overflow regression');
  await adjust(tokenA, branchA, partA1.id, 1, 'rep-ceiling-00000001').then(
    () => {
      throw new Error('Expected ceiling refusal');
    },
    (error) => {
      if (!String(error.message).includes('422')) throw error;
    },
  );
  await api
    .get('/api/reports/stock')
    .set(auth(tokenA))
    .query({ cursor: 'one:two:three' })
    .expect(400);
  await api
    .get('/api/reports/repairs/summary')
    .set(auth(tokenA))
    .query({ from: '2026-11-25', to: '2026-11-24' })
    .expect(400);
  await api.get('/api/reports/repairs/summary').set(auth(tokenA)).query({ from: '1' }).expect(400);
  console.log('PASS quantity ceilings, 3-billion aggregate, strict stock cursor');
  console.log('PASS reports HTTP suite');
} finally {
  if (app) await app.close();
  await testDb?.stop();
}
