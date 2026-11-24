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
// `npm run test:inventory:http` (builds the API first). With
// FIXFLOW_HTTP_DATABASE_URL set (and gated), the same cases run
// against a normal PostgreSQL 16 database instead — see
// scripts/http-test-db.mjs.
process.env.JWT_ACCESS_SECRET = 'test-only-secret-not-for-production';
process.env.JWT_REFRESH_SECRET = 'test-only-refresh-not-for-production';
process.env.NODE_ENV = 'test';
const testDb = await setupHttpTestDb({ port: 15434 });
let app;
try {
  const { PrismaModule } = require('../apps/api/dist/prisma/prisma.module');
  const { AuthModule } = require('../apps/api/dist/auth/auth.module');
  const { CustomersModule } = require('../apps/api/dist/customers/customers.module');
  const { RepairsModule } = require('../apps/api/dist/repairs/repairs.module');
  const { InventoryModule } = require('../apps/api/dist/inventory/inventory.module');
  const { PrismaService } = require('../apps/api/dist/prisma/prisma.service');
  const mod = await Test.createTestingModule({
    imports: [PrismaModule, AuthModule, CustomersModule, RepairsModule, InventoryModule],
  }).compile();
  app = mod.createNestApplication();
  app.setGlobalPrefix('api');
  await app.init();
  // The module's own PrismaService (already connected by app.init()).
  // Direct DB writes below use it so the harness never opens a second
  // pool against the single-connection socket server.
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

  // --- Staff users, created directly (Argon2 hashes, never plaintext) ---
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
  const tech1 = await createStaff('tech-1@example.test', 'technician', [branchA]);
  const tech2 = await createStaff('tech-2@example.test', 'technician', [branchB.id]);
  const tech3 = await createStaff('tech-3@example.test', 'technician', [branchA]);
  const manager = await createStaff('manager@example.test', 'manager', [branchA, branchB.id]);
  const receptionist = await createStaff('reception@example.test', 'receptionist', [branchA]);
  const accountant = await createStaff('accountant@example.test', 'accountant', [branchA]);
  const b = (
    await api
      .post('/api/auth/register')
      .send({ ...ownerA, email: 'owner-b@example.test', tenantName: 'Shop B' })
      .expect(201)
  ).body;
  const tokenB = b.tokens.accessToken;

  // --- Customers / devices (one repair customer per tenant) ---
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
  async function stockRow(token, branchId, partId) {
    const rows = (
      await api.get('/api/stock').set(auth(token)).query({ branchId, partId }).expect(200)
    ).body;
    return rows.items.find((r) => r.partId === partId) ?? null;
  }

  // --- Parts catalog ---
  const partA1 = (
    await api
      .post('/api/parts')
      .set(auth(tokenA))
      .send({ sku: 'SCREEN-A54', name: 'Screen A54' })
      .expect(201)
  ).body;
  const partA2 = (
    await api
      .post('/api/parts')
      .set(auth(tokenA))
      .send({ sku: 'BAT-A54', name: 'Battery A54' })
      .expect(201)
  ).body;
  const partB1 = (
    await api
      .post('/api/parts')
      .set(auth(tokenB))
      .send({ sku: 'SCREEN-B', name: 'Screen B' })
      .expect(201)
  ).body;
  await api
    .post('/api/parts')
    .set(auth(tokenA))
    .send({ sku: 'SCREEN-A54', name: 'Duplicate' })
    .expect(409);
  await api
    .post('/api/parts')
    .set(auth(tokenA))
    .send({ sku: 'NEW', name: 'Priced', price: 5 })
    .expect(400);
  await api.post('/api/parts').set(auth(tokenA)).send({ sku: 'NEW' }).expect(400);
  await api
    .post('/api/parts')
    .set(auth(receptionist.token))
    .send({ sku: 'X', name: 'X' })
    .expect(403);
  await api
    .post('/api/parts')
    .set(auth(accountant.token))
    .send({ sku: 'X', name: 'X' })
    .expect(403);
  await api.get(`/api/parts/${partB1.id}`).set(auth(tokenA)).expect(404);
  const partDetail = (await api.get(`/api/parts/${partA1.id}`).set(auth(tokenA)).expect(200)).body;
  if (
    partDetail.sku !== 'SCREEN-A54' ||
    !Array.isArray(partDetail.stock) ||
    partDetail.stock.length !== 0
  ) {
    throw new Error('Part detail must return sku and branch-scoped stock with branch names');
  }
  const partList = (await api.get('/api/parts').set(auth(tokenA)).expect(200)).body;
  if (
    !partList.items.some((p) => p.id === partA1.id) ||
    !partList.items.some((p) => p.id === partA2.id) ||
    partList.items.some((p) => p.id === partB1.id)
  ) {
    throw new Error('Part list must be tenant-scoped');
  }
  const bySku = (
    await api.get('/api/parts').set(auth(tokenA)).query({ search: 'SCREEN-A54' }).expect(200)
  ).body;
  if (!bySku.items.some((p) => p.id === partA1.id) || bySku.items.some((p) => p.id === partA2.id)) {
    throw new Error('Part search by SKU failed');
  }
  const byName = (
    await api.get('/api/parts').set(auth(tokenA)).query({ search: 'Battery' }).expect(200)
  ).body;
  if (!byName.items.some((p) => p.id === partA2.id)) throw new Error('Part search by name failed');
  const receptionistParts = (await api.get('/api/parts').set(auth(receptionist.token)).expect(200))
    .body;
  if (!receptionistParts.items.some((p) => p.id === partA1.id)) {
    throw new Error('Receptionist must be able to read the parts catalog');
  }
  console.log(
    'PASS parts: create, duplicate SKU 409, strict no-price 400, search, cross-tenant 404, roles',
  );

  // --- Stock read + adjust ---
  const emptyStock = (
    await api.get('/api/stock').set(auth(tokenA)).query({ branchId: branchA }).expect(200)
  ).body;
  if (emptyStock.items.length !== 0) throw new Error('Stock must start empty');
  await api.get('/api/stock').set(auth(tokenA)).query({ branchId: b.branch.id }).expect(403);
  await api.get('/api/stock').set(auth(tokenA)).query({ branchId: branchB.id }).expect(403);
  const tech2Stock = (await api.get('/api/stock').set(auth(tech2.token)).expect(200)).body;
  if (tech2Stock.items.length !== 0) throw new Error('Technician stock list must be branch-scoped');
  const adjust1 = (
    await api
      .post('/api/stock/adjust')
      .set(auth(tokenA))
      .send({ branchId: branchA, partId: partA1.id, delta: 10, idempotencyKey: 'adjust-00000001' })
      .expect(200)
  ).body;
  if (adjust1.qtyOnHand !== 10 || adjust1.reservedQty !== 0 || adjust1.available !== 10) {
    throw new Error('Adjust must return the new stock row');
  }
  const adjustReplay = (
    await api
      .post('/api/stock/adjust')
      .set(auth(tokenA))
      .send({ branchId: branchA, partId: partA1.id, delta: 10, idempotencyKey: 'adjust-00000001' })
      .expect(200)
  ).body;
  if (adjustReplay.qtyOnHand !== 10)
    throw new Error('Adjust replay must return the stored response');
  await api
    .post('/api/stock/adjust')
    .set(auth(tokenA))
    .send({ branchId: branchA, partId: partA1.id, delta: 5, idempotencyKey: 'adjust-00000001' })
    .expect(409);
  await api
    .post('/api/stock/adjust')
    .set(auth(tokenA))
    .send({ branchId: branchA, partId: partA1.id, delta: 0, idempotencyKey: 'adjust-00000002' })
    .expect(400);
  await api
    .post('/api/stock/adjust')
    .set(auth(tokenA))
    .send({ branchId: branchA, partId: partA1.id, delta: -11, idempotencyKey: 'adjust-00000003' })
    .expect(422);
  await api
    .post('/api/stock/adjust')
    .set(auth(tokenA))
    .send({ branchId: branchB.id, partId: partA1.id, delta: 1, idempotencyKey: 'adjust-00000004' })
    .expect(403);
  await api
    .post('/api/stock/adjust')
    .set(auth(tokenA))
    .send({ branchId: branchA, partId: partB1.id, delta: 1, idempotencyKey: 'adjust-00000005' })
    .expect(404);
  await api
    .post('/api/stock/adjust')
    .set(auth(receptionist.token))
    .send({ branchId: branchA, partId: partA1.id, delta: 1, idempotencyKey: 'adjust-00000006' })
    .expect(403);
  await api
    .post('/api/stock/adjust')
    .set(auth(tokenA))
    .send({ branchId: branchA, partId: partA2.id, delta: 10, idempotencyKey: 'adjust-00000002' })
    .expect(200);
  console.log(
    'PASS stock: branch-scoped read, adjust, replay, same-key-different-body 409, beyond-on-hand 422, branch 403, cross-tenant 404, receptionist 403',
  );

  // --- Reserve: happy path, merge, insufficient, scoping, roles ---
  const r1 = await createRepair(tokenA, branchA);
  const reserve1 = (
    await api
      .post(`/api/repairs/${r1.id}/parts`)
      .set(auth(tokenA))
      .send({ partId: partA1.id, qty: 3, idempotencyKey: 'reserve-00000001' })
      .expect(200)
  ).body;
  if (reserve1.qty !== 3 || reserve1.status !== 'reserved' || reserve1.partSku !== 'SCREEN-A54') {
    throw new Error('Reserve must return the line with part sku');
  }
  let row = await stockRow(tokenA, branchA, partA1.id);
  if (!row || row.qtyOnHand !== 10 || row.reservedQty !== 3 || row.available !== 7) {
    throw new Error('Reserve must raise reservedQty only, qtyOnHand unchanged');
  }
  if (row.partSku !== 'SCREEN-A54' || row.partName !== 'Screen A54' || row.branchName !== 'Main') {
    throw new Error('Stock rows must carry part sku/name and branch name');
  }
  const merged = (
    await api
      .post(`/api/repairs/${r1.id}/parts`)
      .set(auth(tokenA))
      .send({ partId: partA1.id, qty: 2, idempotencyKey: 'reserve-00000002' })
      .expect(200)
  ).body;
  if (merged.id !== reserve1.id || merged.qty !== 5) {
    throw new Error('Second reserve of the same part must merge into the one line');
  }
  row = await stockRow(tokenA, branchA, partA1.id);
  if (!row || row.reservedQty !== 5) throw new Error('Merged reserve must raise reservedQty to 5');
  await api
    .post(`/api/repairs/${r1.id}/parts`)
    .set(auth(tokenA))
    .send({ partId: partA1.id, qty: 6, idempotencyKey: 'reserve-00000003' })
    .expect(422);
  row = await stockRow(tokenA, branchA, partA1.id);
  if (!row || row.reservedQty !== 5) throw new Error('Failed reserve must not move stock');
  await api
    .post(`/api/repairs/${r1.id}/parts`)
    .set(auth(tokenA))
    .send({ partId: partB1.id, qty: 1, idempotencyKey: 'reserve-00000004' })
    .expect(404);
  await api
    .post(`/api/repairs/${r1.id}/parts`)
    .set(auth(receptionist.token))
    .send({ partId: partA1.id, qty: 1, idempotencyKey: 'reserve-00000005' })
    .expect(403);
  await api
    .post(`/api/repairs/${r1.id}/parts`)
    .set(auth(tokenA))
    .send({ partId: partA1.id, qty: 0, idempotencyKey: 'reserve-00000006' })
    .expect(400);
  await api
    .post(`/api/repairs/${r1.id}/parts`)
    .set(auth(tokenA))
    .send({ partId: partA1.id, qty: 1 })
    .expect(400);
  // Branch bypass: the branch-B repair is invisible to the branch-A owner,
  // exactly like RepairsService.loadOrder (404, not a 403 — there is no
  // branch in the reserve body to reject at the guard).
  const rBranchB = await createRepair(manager.token, branchB.id);
  await api
    .post(`/api/repairs/${rBranchB.id}/parts`)
    .set(auth(tokenA))
    .send({ partId: partA1.id, qty: 1, idempotencyKey: 'reserve-00000007' })
    .expect(404);
  // Terminal orders cannot take new reservations.
  const rCancel = await createRepair(tokenA, branchA);
  await api
    .post(`/api/repairs/${rCancel.id}/transition`)
    .set(auth(tokenA))
    .send({ toStatus: 'cancelled', expectedVersion: 0 })
    .expect(200);
  await api
    .post(`/api/repairs/${rCancel.id}/parts`)
    .set(auth(tokenA))
    .send({ partId: partA1.id, qty: 1, idempotencyKey: 'reserve-00000008' })
    .expect(422);
  console.log(
    'PASS reserve: happy path, merge, insufficient 422, cross-tenant 404, branch 404, terminal 422, receptionist 403',
  );

  // --- Idempotent replay of reserve ---
  const replayed = (
    await api
      .post(`/api/repairs/${r1.id}/parts`)
      .set(auth(tokenA))
      .send({ partId: partA1.id, qty: 3, idempotencyKey: 'reserve-00000001' })
      .expect(200)
  ).body;
  if (replayed.id !== reserve1.id || replayed.qty !== 3) {
    throw new Error('Replay must return the original stored response, not the merged line');
  }
  await api
    .post(`/api/repairs/${r1.id}/parts`)
    .set(auth(tokenA))
    .send({ partId: partA1.id, qty: 4, idempotencyKey: 'reserve-00000001' })
    .expect(409);
  row = await stockRow(tokenA, branchA, partA1.id);
  if (!row || row.reservedQty !== 5) throw new Error('Replay must not move stock again');
  console.log(
    'PASS idempotency: reserve replay returns the original line, same key different body 409',
  );

  // --- Release ---
  const r2 = await createRepair(tokenA, branchA);
  const line2 = (
    await api
      .post(`/api/repairs/${r2.id}/parts`)
      .set(auth(tokenA))
      .send({ partId: partA2.id, qty: 2, idempotencyKey: 'reserve-00000009' })
      .expect(200)
  ).body;
  const released = (
    await api
      .post(`/api/repairs/${r2.id}/parts/${line2.id}/release`)
      .set(auth(tokenA))
      .send({ idempotencyKey: 'release-00000001' })
      .expect(200)
  ).body;
  if (released.status !== 'released' || released.id !== line2.id) {
    throw new Error('Release must return the released line');
  }
  row = await stockRow(tokenA, branchA, partA2.id);
  if (!row || row.qtyOnHand !== 10 || row.reservedQty !== 0) {
    throw new Error('Release must lower reservedQty only, qtyOnHand unchanged');
  }
  await api
    .post(`/api/repairs/${r2.id}/parts/${line2.id}/release`)
    .set(auth(tokenA))
    .send({ idempotencyKey: 'release-00000002' })
    .expect(409);
  const releaseReplay = (
    await api
      .post(`/api/repairs/${r2.id}/parts/${line2.id}/release`)
      .set(auth(tokenA))
      .send({ idempotencyKey: 'release-00000001' })
      .expect(200)
  ).body;
  if (releaseReplay.id !== line2.id || releaseReplay.status !== 'released') {
    throw new Error('Release replay must return the original response');
  }
  await api
    .post(`/api/repairs/${r1.id}/parts/${line2.id}/release`)
    .set(auth(tokenA))
    .send({ idempotencyKey: 'release-00000003' })
    .expect(404);
  await api
    .post(`/api/repairs/${r2.id}/parts/no-such-line/release`)
    .set(auth(tokenA))
    .send({ idempotencyKey: 'release-00000004' })
    .expect(404);
  console.log('PASS release: happy path, double-release 409, same-key replay, wrong-order 404');

  // --- Consume ---
  const r3 = await createRepair(tokenA, branchA);
  await api
    .post(`/api/repairs/${r3.id}/assign`)
    .set(auth(tokenA))
    .send({ technicianUserId: tech1.user.id })
    .expect(200);
  const line3 = (
    await api
      .post(`/api/repairs/${r3.id}/parts`)
      .set(auth(tokenA))
      .send({ partId: partA1.id, qty: 2, idempotencyKey: 'reserve-00000010' })
      .expect(200)
  ).body;
  const consumed = (
    await api
      .post(`/api/repairs/${r3.id}/parts/${line3.id}/consume`)
      .set(auth(tech1.token))
      .send({ idempotencyKey: 'consume-00000001' })
      .expect(200)
  ).body;
  if (consumed.status !== 'consumed') throw new Error('Consume must return the consumed line');
  row = await stockRow(tokenA, branchA, partA1.id);
  if (!row || row.qtyOnHand !== 8 || row.reservedQty !== 5) {
    throw new Error('Consume must decrement qtyOnHand AND reservedQty exactly once');
  }
  await api
    .post(`/api/repairs/${r3.id}/parts/${line3.id}/consume`)
    .set(auth(tech1.token))
    .send({ idempotencyKey: 'consume-00000002' })
    .expect(409);
  const r4 = await createRepair(tokenA, branchA);
  const line4 = (
    await api
      .post(`/api/repairs/${r4.id}/parts`)
      .set(auth(tokenA))
      .send({ partId: partA1.id, qty: 1, idempotencyKey: 'reserve-00000011' })
      .expect(200)
  ).body;
  await api
    .post(`/api/repairs/${r4.id}/parts/${line4.id}/consume`)
    .set(auth(tech3.token))
    .send({ idempotencyKey: 'consume-00000003' })
    .expect(404);
  await api
    .post(`/api/repairs/${r4.id}/parts/${line4.id}/consume`)
    .set(auth(receptionist.token))
    .send({ idempotencyKey: 'consume-00000004' })
    .expect(403);
  await api
    .post(`/api/repairs/${r4.id}/parts/${line4.id}/consume`)
    .set(auth(accountant.token))
    .send({ idempotencyKey: 'consume-00000005' })
    .expect(403);
  const r5 = await createRepair(tokenA, branchA);
  const line5 = (
    await api
      .post(`/api/repairs/${r5.id}/parts`)
      .set(auth(tokenA))
      .send({ partId: partA2.id, qty: 1, idempotencyKey: 'reserve-00000012' })
      .expect(200)
  ).body;
  await api
    .post(`/api/repairs/${r5.id}/parts/${line5.id}/consume`)
    .set(auth(manager.token))
    .send({ idempotencyKey: 'consume-00000006' })
    .expect(200);
  row = await stockRow(tokenA, branchA, partA2.id);
  if (!row || row.qtyOnHand !== 9 || row.reservedQty !== 0) {
    throw new Error('Manager consume must decrement both quantities once');
  }
  console.log(
    'PASS consume: technician own-assigned ok, both down once, unassigned 403, receptionist/accountant 403, manager ok',
  );

  // --- Second-branch flow (manager is scoped to both branches) ---
  await api
    .post('/api/stock/adjust')
    .set(auth(manager.token))
    .send({ branchId: branchB.id, partId: partA1.id, delta: 5, idempotencyKey: 'adjust-00000007' })
    .expect(200);
  const lineB = (
    await api
      .post(`/api/repairs/${rBranchB.id}/parts`)
      .set(auth(manager.token))
      .send({ partId: partA1.id, qty: 2, idempotencyKey: 'reserve-00000013' })
      .expect(200)
  ).body;
  await api
    .post(`/api/repairs/${rBranchB.id}/parts/${lineB.id}/consume`)
    .set(auth(manager.token))
    .send({ idempotencyKey: 'consume-00000007' })
    .expect(200);
  row = await stockRow(manager.token, branchB.id, partA1.id);
  if (!row || row.qtyOnHand !== 3 || row.reservedQty !== 0) {
    throw new Error('Second-branch consume must be isolated to its own branch stock');
  }
  console.log('PASS second branch: adjust, reserve and consume isolated to branch B');

  // --- Cancel / unrepairable auto-release ---
  const r6 = await createRepair(tokenA, branchA);
  const line6 = (
    await api
      .post(`/api/repairs/${r6.id}/parts`)
      .set(auth(tokenA))
      .send({ partId: partA1.id, qty: 2, idempotencyKey: 'reserve-00000014' })
      .expect(200)
  ).body;
  row = await stockRow(tokenA, branchA, partA1.id);
  if (!row || row.reservedQty !== 8) throw new Error('Pre-cancel reservedQty must be 8');
  await api
    .post(`/api/repairs/${r6.id}/transition`)
    .set(auth(tokenA))
    .send({ toStatus: 'cancelled', expectedVersion: 0 })
    .expect(200);
  row = await stockRow(tokenA, branchA, partA1.id);
  if (!row || row.reservedQty !== 6 || row.qtyOnHand !== 8) {
    throw new Error('Cancel must auto-release reserved parts: reserved back, on-hand untouched');
  }
  const parts6 = (await api.get(`/api/repairs/${r6.id}/parts`).set(auth(tokenA)).expect(200)).body;
  if (parts6.find((l) => l.id === line6.id)?.status !== 'released') {
    throw new Error('Cancelled repair lines must read released');
  }
  const r7 = await createRepair(tokenA, branchA);
  await api
    .post(`/api/repairs/${r7.id}/parts`)
    .set(auth(tokenA))
    .send({ partId: partA1.id, qty: 1, idempotencyKey: 'reserve-00000015' })
    .expect(200);
  await api
    .post(`/api/repairs/${r7.id}/transition`)
    .set(auth(tokenA))
    .send({ toStatus: 'diagnosing', expectedVersion: 0 })
    .expect(200);
  await api
    .post(`/api/repairs/${r7.id}/transition`)
    .set(auth(tokenA))
    .send({ toStatus: 'unrepairable', expectedVersion: 1, note: 'Board dead' })
    .expect(200);
  row = await stockRow(tokenA, branchA, partA1.id);
  if (!row || row.reservedQty !== 6 || row.qtyOnHand !== 8) {
    throw new Error('Unrepairable must auto-release reserved parts');
  }
  await api
    .post(`/api/repairs/${r7.id}/parts`)
    .set(auth(tokenA))
    .send({ partId: partA1.id, qty: 1, idempotencyKey: 'reserve-00000016' })
    .expect(422);
  console.log(
    'PASS auto-release: cancel and unrepairable free reserved stock in the same transaction',
  );

  // --- Repair parts list scoping ---
  const partsR1 = (await api.get(`/api/repairs/${r1.id}/parts`).set(auth(tokenA)).expect(200)).body;
  if (
    partsR1.length !== 1 ||
    partsR1[0].id !== reserve1.id ||
    partsR1[0].qty !== 5 ||
    partsR1[0].partSku !== 'SCREEN-A54'
  ) {
    throw new Error('Repair parts list must return the merged line with part sku/name');
  }
  await api.get(`/api/repairs/${r1.id}/parts`).set(auth(tech1.token)).expect(404);
  await api.get(`/api/repairs/${r1.id}/parts`).set(auth(tech2.token)).expect(404);
  await api
    .post(`/api/repairs/${r1.id}/assign`)
    .set(auth(tokenA))
    .send({ technicianUserId: tech1.user.id })
    .expect(200);
  const partsR1Tech = (
    await api.get(`/api/repairs/${r1.id}/parts`).set(auth(tech1.token)).expect(200)
  ).body;
  if (partsR1Tech.length !== 1) throw new Error('Assigned technician must read the repair parts');
  await api.get(`/api/repairs/${rBranchB.id}/parts`).set(auth(tokenA)).expect(404);
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
  await api.get(`/api/repairs/${bRepair.id}/parts`).set(auth(tokenA)).expect(404);
  console.log('PASS repair parts list: branch/technician/cross-tenant scoping');

  // --- Movements ledger: exact sequence, append-only ---
  const movementsA1 = (
    await api
      .get('/api/stock/movements')
      .set(auth(tokenA))
      .query({ branchId: branchA, partId: partA1.id, limit: 100 })
      .expect(200)
  ).body;
  const seqA1 = movementsA1.items.map((m) => [m.qty, m.reason]);
  if (
    movementsA1.items[0]?.partSku !== 'SCREEN-A54' ||
    movementsA1.items[0]?.partName !== 'Screen A54' ||
    movementsA1.items[0]?.branchName !== 'Main'
  ) {
    throw new Error('Movements must carry part sku/name and branch name');
  }
  const expectedA1 = [
    [-1, 'release'],
    [1, 'reserve'],
    [-2, 'release'],
    [2, 'reserve'],
    [1, 'reserve'],
    [-2, 'consume'],
    [2, 'reserve'],
    [2, 'reserve'],
    [3, 'reserve'],
    [10, 'adjust'],
  ];
  if (JSON.stringify(seqA1) !== JSON.stringify(expectedA1)) {
    throw new Error(`Part A1 branch A movements mismatch: ${JSON.stringify(seqA1)}`);
  }
  const movementsA = (
    await api
      .get('/api/stock/movements')
      .set(auth(tokenA))
      .query({ branchId: branchA, limit: 100 })
      .expect(200)
  ).body;
  if (movementsA.items.length !== 15) {
    throw new Error(`Branch A must have 15 movements, got ${movementsA.items.length}`);
  }
  const tech2Movements = (
    await api.get('/api/stock/movements').set(auth(tech2.token)).query({ limit: 100 }).expect(200)
  ).body;
  if (
    tech2Movements.items.length !== 3 ||
    tech2Movements.items.some((m) => m.branchId === branchA)
  ) {
    throw new Error('Movement list must be branch-scoped for the caller');
  }
  let appendBlocked = false;
  try {
    await prisma.withTenant(tenantA, (tx) =>
      tx.$executeRawUnsafe(`DELETE FROM stock_movements WHERE "tenantId"=$1`, tenantA),
    );
  } catch (e) {
    appendBlocked = String(e).includes('append-only');
  }
  if (!appendBlocked) throw new Error('Stock movement deletion was not blocked');
  console.log('PASS movements: exact ledger sequence, branch scoping, append-only trigger');
  // A replay must not bypass a newly revoked branch grant.
  await prisma.withTenant(tenantA, (tx) =>
    tx.membership.updateMany({
      where: { userId: a.user.id, tenantId: tenantA },
      data: { branchIds: [] },
    }),
  );
  await api
    .post('/api/stock/adjust')
    .set(auth(tokenA))
    .send({ branchId: branchA, partId: partA1.id, delta: 10, idempotencyKey: 'adjust-00000001' })
    .expect(403);
  await api
    .post(`/api/repairs/${r1.id}/parts`)
    .set(auth(tokenA))
    .send({ partId: partA1.id, qty: 3, idempotencyKey: 'reserve-00000001' })
    .expect(404);
  console.log('PASS idempotency replay rechecks current branch authorization');
  console.log('PASS inventory HTTP suite');
} finally {
  if (app) await app.close();
  await testDb?.stop();
}
