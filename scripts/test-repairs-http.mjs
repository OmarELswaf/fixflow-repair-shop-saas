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
// `npm run test:repairs:http` (builds the API first). With
// FIXFLOW_HTTP_DATABASE_URL set (and gated), the same cases run
// against a normal PostgreSQL 16 database instead — see
// scripts/http-test-db.mjs.
process.env.JWT_ACCESS_SECRET = 'test-only-secret-not-for-production';
process.env.JWT_REFRESH_SECRET = 'test-only-refresh-not-for-production';
process.env.NODE_ENV = 'test';
const testDb = await setupHttpTestDb({ port: 15433 });
let app;
try {
  const { PrismaModule } = require('../apps/api/dist/prisma/prisma.module');
  const { AuthModule } = require('../apps/api/dist/auth/auth.module');
  const { CustomersModule } = require('../apps/api/dist/customers/customers.module');
  const { RepairsModule } = require('../apps/api/dist/repairs/repairs.module');
  const { PrismaService } = require('../apps/api/dist/prisma/prisma.service');
  const mod = await Test.createTestingModule({
    imports: [PrismaModule, AuthModule, CustomersModule, RepairsModule],
  }).compile();
  app = mod.createNestApplication();
  app.setGlobalPrefix('api');
  await app.init();
  // The module's own PrismaService (already connected by app.init(),
  // which also ran the non-owner role check). Direct DB writes below
  // use it so the harness never opens a second pool against the
  // single-connection socket server.
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
  const receptionist = await createStaff('reception@example.test', 'receptionist', [branchA]);
  const accountant = await createStaff('accountant@example.test', 'accountant', [branchA]);

  // --- Customers ---
  const customer = (
    await api
      .post('/api/customers')
      .set(auth(tokenA))
      .send({ name: 'Sara', phone: '+201001234567' })
      .expect(201)
  ).body;
  await api.post('/api/customers').set(auth(tokenA)).send({ name: '' }).expect(400);
  await api.post('/api/customers').set(auth(tokenA)).send({ name: 'X', phone: 'abc' }).expect(400);
  const byName = (
    await api.get('/api/customers').set(auth(tokenA)).query({ search: 'Sara' }).expect(200)
  ).body;
  if (!byName.items.some((c) => c.id === customer.id)) throw new Error('Search by name failed');
  const byPhone = (
    await api.get('/api/customers').set(auth(tokenA)).query({ search: '001234567' }).expect(200)
  ).body;
  if (!byPhone.items.some((c) => c.id === customer.id)) throw new Error('Search by phone failed');
  const b = (
    await api
      .post('/api/auth/register')
      .send({ ...ownerA, email: 'owner-b@example.test', tenantName: 'Shop B' })
      .expect(201)
  ).body;
  const otherCustomer = (
    await api
      .post('/api/customers')
      .set(auth(b.tokens.accessToken))
      .send({ name: 'Other', phone: '+20222222222' })
      .expect(201)
  ).body;
  await api.get(`/api/customers/${otherCustomer.id}`).set(auth(tokenA)).expect(404);
  const detail = (await api.get(`/api/customers/${customer.id}`).set(auth(tokenA)).expect(200))
    .body;
  if (detail.name !== 'Sara' || !Array.isArray(detail.devices) || !Array.isArray(detail.repairs)) {
    throw new Error('Customer detail shape wrong');
  }
  console.log('PASS customers: create, validation, search, cross-tenant 404, detail');

  // --- Device intake (no unlock passwords) ---
  const device = (
    await api
      .post(`/api/customers/${customer.id}/devices`)
      .set(auth(tokenA))
      .send({ brand: 'Samsung', model: 'A54', serial: 'SN-1' })
      .expect(201)
  ).body;
  await api
    .post(`/api/customers/${customer.id}/devices`)
    .set(auth(tokenA))
    .send({ brand: 'Samsung', model: 'A54', password: '1234' })
    .expect(400);
  const detail2 = (await api.get(`/api/customers/${customer.id}`).set(auth(tokenA)).expect(200))
    .body;
  if ('password' in detail2.devices[0]) throw new Error('Device must never store a password');
  console.log('PASS device intake: create, strict rejection of password field, no password stored');

  // --- Repair creation ---
  async function createRepair(token, overrides = {}) {
    return (
      await api
        .post('/api/repairs')
        .set(auth(token))
        .send({
          customerId: customer.id,
          deviceId: device.id,
          branchId: branchA,
          problemDescription: 'Screen cracked',
          ...overrides,
        })
        .expect(201)
    ).body;
  }
  const repair = await createRepair(tokenA);
  if (repair.status !== 'received' || repair.version !== 0) {
    throw new Error('New repair must start received at version 0');
  }
  await api
    .post('/api/repairs')
    .set(auth(tokenA))
    .send({
      customerId: customer.id,
      deviceId: device.id,
      branchId: b.branch.id,
      problemDescription: 'Out of scope branch',
    })
    .expect(403);
  const customer2 = (
    await api
      .post('/api/customers')
      .set(auth(tokenA))
      .send({ name: 'Omar', phone: '+20333333333' })
      .expect(201)
  ).body;
  const device2 = (
    await api
      .post(`/api/customers/${customer2.id}/devices`)
      .set(auth(tokenA))
      .send({ brand: 'Apple', model: 'iPhone 13' })
      .expect(201)
  ).body;
  await api
    .post('/api/repairs')
    .set(auth(tokenA))
    .send({
      customerId: customer.id,
      deviceId: device2.id,
      branchId: branchA,
      problemDescription: 'Device belongs to another customer',
    })
    .expect(422);
  const list = (await api.get('/api/repairs').set(auth(tokenA)).expect(200)).body;
  if (!list.items.some((r) => r.id === repair.id)) throw new Error('Repair list missing repair');
  const filtered = (
    await api.get('/api/repairs').set(auth(tokenA)).query({ status: 'delivered' }).expect(200)
  ).body;
  if (filtered.items.some((r) => r.id === repair.id)) {
    throw new Error('Status filter must exclude a received repair');
  }
  console.log('PASS repairs: create, branch scope 403, device/customer mismatch 422, list+filter');

  // --- Assignment ---
  const assigned = (
    await api
      .post(`/api/repairs/${repair.id}/assign`)
      .set(auth(tokenA))
      .send({ technicianUserId: tech1.user.id })
      .expect(200)
  ).body;
  if (assigned.assignedTechnicianId !== tech1.user.id) throw new Error('Assign did not stick');
  await api
    .post(`/api/repairs/${repair.id}/assign`)
    .set(auth(tokenA))
    .send({ technicianUserId: receptionist.user.id })
    .expect(422);
  await api
    .post(`/api/repairs/${repair.id}/assign`)
    .set(auth(tokenA))
    .send({ technicianUserId: tech2.user.id })
    .expect(422);
  await api
    .post(`/api/repairs/${repair.id}/assign`)
    .set(auth(receptionist.token))
    .send({ technicianUserId: tech1.user.id })
    .expect(403);
  console.log('PASS assignment: owner ok, non-technician 422, wrong-branch 422, no-permission 403');

  // --- Technician directory ---
  const techsA = (
    await api
      .get('/api/repairs/technicians')
      .set(auth(tokenA))
      .query({ branchId: branchA })
      .expect(200)
  ).body;
  const techIdsA = techsA.map((u) => u.id);
  if (
    !techIdsA.includes(tech1.user.id) ||
    !techIdsA.includes(tech3.user.id) ||
    techIdsA.includes(tech2.user.id)
  ) {
    throw new Error('Technician directory must list only branch-scoped technicians');
  }
  await api
    .get('/api/repairs/technicians')
    .set(auth(tokenA))
    .query({ branchId: b.branch.id })
    .expect(403);
  await api
    .get('/api/repairs/technicians')
    .set(auth(receptionist.token))
    .query({ branchId: branchA })
    .expect(403);
  console.log('PASS technician directory: branch-scoped list, out-of-scope 403, no-permission 403');

  // --- Transitions ---
  function transition(token, id, toStatus, expectedVersion, note) {
    return api
      .post(`/api/repairs/${id}/transition`)
      .set(auth(token))
      .send({ toStatus, expectedVersion, ...(note ? { note } : {}) });
  }
  let r2 = await createRepair(tokenA);
  r2 = (await transition(tokenA, r2.id, 'diagnosing', 0).expect(200)).body;
  if (r2.version !== 1 || r2.status !== 'diagnosing')
    throw new Error('Transition must bump version');
  await transition(tokenA, r2.id, 'diagnosing', 0).expect(409);
  const r3 = await createRepair(tokenA);
  await transition(tokenA, r3.id, 'ready', 0).expect(422);
  r2 = (await transition(tokenA, r2.id, 'in_repair', 1).expect(200)).body;
  r2 = (await transition(tokenA, r2.id, 'quality_check', 2, 'Checked display').expect(200)).body;
  r2 = (await transition(tokenA, r2.id, 'ready', 3).expect(200)).body;
  r2 = (await transition(tokenA, r2.id, 'delivered', 4).expect(200)).body;
  await transition(tokenA, r2.id, 'diagnosing', 5).expect(422);
  let r4 = await createRepair(tokenA);
  await transition(tokenA, r4.id, 'diagnosing', 0).expect(200);
  r4 = (await transition(tokenA, r4.id, 'unrepairable', 1, 'Board dead').expect(200)).body;
  await transition(tokenA, r4.id, 'in_repair', 2).expect(422);
  console.log('PASS transitions: happy path, illegal 422, stale version 409, terminal states');

  // --- Technician-only transition rule ---
  const r5 = await createRepair(tokenA);
  await transition(tech1.token, r5.id, 'diagnosing', 0).expect(404);
  await api
    .post(`/api/repairs/${r5.id}/assign`)
    .set(auth(tokenA))
    .send({ technicianUserId: tech1.user.id })
    .expect(200);
  await transition(tech1.token, r5.id, 'diagnosing', 1).expect(200);
  await transition(tech3.token, r5.id, 'in_repair', 2).expect(404);
  console.log('PASS technician rule: unassigned 403, assigned 200, other technician 403');

  // Independent access-control regressions, including reads and implicit lists.
  await api.get(`/api/repairs/${r5.id}`).set(auth(tech3.token)).expect(404);
  await api.get(`/api/repairs/${r5.id}/receipt`).set(auth(tech3.token)).expect(404);
  await api.get(`/api/repairs/${r5.id}`).set(auth(tech2.token)).expect(404);
  const techList = (await api.get('/api/repairs').set(auth(tech3.token)).expect(200)).body;
  if (techList.items.some((r) => r.id === r5.id))
    throw new Error('Technician list leaked another assignment');
  const branchList = (await api.get('/api/repairs').set(auth(tech2.token)).expect(200)).body;
  if (branchList.items.length) throw new Error('Implicit list leaked another branch');
  const scopedCustomer = (
    await api.get(`/api/customers/${customer.id}`).set(auth(tech2.token)).expect(200)
  ).body;
  if (scopedCustomer.repairs.length) throw new Error('Customer history leaked another branch');
  await transition(tech1.token, r5.id, 'in_repair', 1).expect(409);
  console.log(
    'PASS scope regressions: detail, receipt, implicit lists, customer history and assignment version',
  );

  // --- Least-privilege roles ---
  await api
    .post('/api/customers')
    .set(auth(receptionist.token))
    .send({ name: 'Reception Customer', phone: '+20444444444' })
    .expect(201);
  const r6 = await createRepair(receptionist.token);
  await transition(receptionist.token, r6.id, 'diagnosing', 0).expect(403);
  await api
    .post('/api/repairs')
    .set(auth(accountant.token))
    .send({
      customerId: customer.id,
      deviceId: device.id,
      branchId: branchA,
      problemDescription: 'Accountant must not create repairs',
    })
    .expect(403);
  console.log('PASS roles: receptionist creates but cannot transition; accountant cannot create');

  // --- Receipt and immutable history ---
  const receipt = (await api.get(`/api/repairs/${r2.id}/receipt`).set(auth(tokenA)).expect(200))
    .body;
  if (
    !receipt.order ||
    !receipt.customer ||
    !receipt.device ||
    !receipt.tenant ||
    !receipt.issuedAt ||
    receipt.events.length !== 6
  ) {
    throw new Error('Receipt must return order, customer, device, tenant, events, issuedAt');
  }
  const toStatuses = receipt.events.map((e) => e.toStatus);
  if (
    JSON.stringify(toStatuses) !==
    JSON.stringify(['received', 'diagnosing', 'in_repair', 'quality_check', 'ready', 'delivered'])
  ) {
    throw new Error('Events must be append-only and chronological');
  }
  const detailR5 = (await api.get(`/api/repairs/${r5.id}`).set(auth(tokenA)).expect(200)).body;
  if (detailR5.assignedTechnician?.id !== tech1.user.id) {
    throw new Error('Repair detail must include the assigned technician');
  }
  // A repair that belongs to tenant B is 404 for tenant A.
  const bCustomerDevice = (
    await api
      .post(`/api/customers/${otherCustomer.id}/devices`)
      .set(auth(b.tokens.accessToken))
      .send({ brand: 'Xiaomi', model: 'Redmi' })
      .expect(201)
  ).body;
  const bRepair = (
    await api
      .post('/api/repairs')
      .set(auth(b.tokens.accessToken))
      .send({
        customerId: otherCustomer.id,
        deviceId: bCustomerDevice.id,
        branchId: b.branch.id,
        problemDescription: 'Tenant B repair',
      })
      .expect(201)
  ).body;
  await api.get(`/api/repairs/${bRepair.id}`).set(auth(tokenA)).expect(404);
  for (const table of ['repair_events', 'audit_log']) {
    let rejected = false;
    try {
      await prisma.withTenant(tenantA, (tx) =>
        tx.$executeRawUnsafe(`DELETE FROM ${table} WHERE "tenantId"=$1`, tenantA),
      );
    } catch (e) {
      rejected = String(e).includes('append-only');
    }
    if (!rejected) throw new Error('History mutation was not blocked: ' + table);
  }
  console.log('PASS database append-only event and audit history');
  console.log('PASS receipt and history: receipt shape, 6 chronological events, detail+technician');
} finally {
  if (app) await app.close();
  await testDb?.stop();
}
