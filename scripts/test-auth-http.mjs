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
// controllers, actual Argon2/JWT/Prisma. Covers auth plus tenant
// switching and cross-account denial. CustomersModule and
// RepairsModule are loaded only so the switch cases can assert
// against real branch-scoped resources (repair creation with a
// foreign branchId). Does not validate Docker startup, a normal
// PostgreSQL 16 installation, real independent connections, or
// production concurrency. Run via `npm run test:auth:http`
// (builds the API first). With FIXFLOW_HTTP_DATABASE_URL set (and
// gated), the same cases run against a normal PostgreSQL 16
// database instead — see scripts/http-test-db.mjs.

process.env.JWT_ACCESS_SECRET = 'test-only-secret-not-for-production';
process.env.JWT_REFRESH_SECRET = 'test-only-refresh-not-for-production';
process.env.NODE_ENV = 'test';
const testDb = await setupHttpTestDb({ port: 15432 });
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
  // The module's own PrismaService (already connected by app.init()).
  // Direct DB writes below use it so the harness never opens a second
  // pool against the single-connection socket server.
  const prisma = mod.get(PrismaService);
  const api = request(app.getHttpServer());
  // Cookie-jar agent: the browser flow. The refresh token travels as
  // the HttpOnly ff_refresh cookie; the access token stays in JSON.
  const agent = request.agent(app.getHttpServer());
  const ORIGIN = 'http://localhost:5173';
  const owner = {
    email: 'owner-a@example.test',
    password: 'twelve-chars-min',
    tenantName: 'Shop A',
    branchName: 'Main',
  };
  const registerRes = await api.post('/api/auth/register').send(owner).expect(201);
  const a = registerRes.body;
  const setCookie = registerRes.headers['set-cookie'] || [];
  if (!setCookie.some((c) => c.startsWith('ff_refresh=') && c.includes('HttpOnly'))) {
    throw new Error('Registration must set an HttpOnly ff_refresh cookie');
  }
  await api
    .post('/api/auth/login')
    .set('Origin', 'https://hostile.example')
    .send(owner)
    .expect(403);
  console.log('PASS registration through HTTP and Prisma with RLS app role');
  await agent
    .post('/api/auth/login')
    .set('Origin', ORIGIN)
    .send({ email: owner.email, password: 'wrong' })
    .expect(401);
  const loginResponse = await agent
    .post('/api/auth/login')
    .set('Origin', ORIGIN)
    .send({ email: owner.email, password: owner.password })
    .expect(200);
  if (loginResponse.body.tokens.refreshToken) throw new Error('Browser JSON exposed refresh token');
  const cookieToken = (r) =>
    decodeURIComponent(r.headers['set-cookie'][0].split(';')[0].split('=')[1]);
  const login = {
    ...loginResponse.body,
    tokens: { ...loginResponse.body.tokens, refreshToken: cookieToken(loginResponse) },
  };
  await agent
    .get('/api/auth/me')
    .set('Authorization', `Bearer ${login.tokens.accessToken}`)
    .expect(200);
  const me = (
    await agent
      .get('/api/auth/me')
      .set('Authorization', `Bearer ${login.tokens.accessToken}`)
      .expect(200)
  ).body;
  if (
    me.memberships[0].tenantName !== 'Shop A' ||
    me.tenantContext?.tenantName !== 'Shop A' ||
    me.memberships[0].branches[0].name !== 'Main'
  ) {
    throw new Error('/me must return tenant and branch names');
  }
  console.log('PASS login, wrong-password rejection and authenticated me');
  // Refresh via cookie only (no JSON body) with an allowed Origin.
  const rotateResponse = await agent.post('/api/auth/refresh').set('Origin', ORIGIN).expect(200);
  if (rotateResponse.body.refreshToken) throw new Error('Browser refresh JSON exposed secret');
  const rotated = { ...rotateResponse.body, refreshToken: cookieToken(rotateResponse) };
  if (!rotated.refreshToken || rotated.refreshToken === login.tokens.refreshToken) {
    throw new Error('Cookie refresh must rotate to a new refresh token');
  }
  console.log('PASS refresh via cookie with allowed Origin rotates');
  // Refresh via cookie WITHOUT Origin: the CSRF check must refuse it.
  await api
    .post('/api/auth/refresh')
    .set('Cookie', `ff_refresh=${rotated.refreshToken}`)
    .expect(403);
  console.log('PASS cookie refresh without Origin rejected with 403');
  // Replay via cookie: the original token is reuse (401) and the
  // rotated token is dead too (family revoked).
  await api
    .post('/api/auth/refresh')
    .set('Cookie', `ff_refresh=${login.tokens.refreshToken}`)
    .set('Origin', ORIGIN)
    .expect(401);
  await api
    .post('/api/auth/refresh')
    .set('Cookie', `ff_refresh=${rotated.refreshToken}`)
    .set('Origin', ORIGIN)
    .expect(401);
  console.log('PASS refresh rotation and replay family revocation');
  // Rate limit: 6 rapid wrong-password logins for one fresh email.
  // The first 5 are 401s; the 6th must be 429 with Retry-After.
  const probeEmail = 'ratelimit-probe@example.test';
  for (let i = 0; i < 5; i++) {
    await api
      .post('/api/auth/login')
      .set('Origin', ORIGIN)
      .send({ email: probeEmail, password: 'wrong-password' })
      .expect(401);
  }
  const limited = await api
    .post('/api/auth/login')
    .set('Origin', ORIGIN)
    .send({ email: probeEmail, password: 'wrong-password' })
    .expect(429);
  if (!limited.headers['retry-after']) {
    throw new Error('Rate-limited login must carry a Retry-After header');
  }
  if (limited.body.statusCode !== 429 || limited.body.message !== 'Too many requests.') {
    throw new Error('Rate-limited login body must be the 429 shape');
  }
  console.log('PASS login rate limit: 6th attempt for one email is 429 with Retry-After');
  const b = (
    await api
      .post('/api/auth/register')
      .send({ ...owner, email: 'owner-b@example.test', tenantName: 'Shop B' })
      .expect(201)
  ).body;
  await api
    .post('/api/auth/select-tenant')
    .set('Authorization', `Bearer ${a.tokens.accessToken}`)
    .send({ tenantId: b.tenant.id })
    .expect(403);
  console.log('PASS cross-tenant selection rejected');
  await api.post('/api/auth/logout').send({ refreshToken: a.tokens.refreshToken }).expect(200);
  await api.post('/api/auth/refresh').send({ refreshToken: a.tokens.refreshToken }).expect(401);
  console.log('PASS logout revocation');

  // --- Tenant switching, cross-account denial, logout families (Phase 8) ---
  const tenantA = a.tenant.id;
  const tenantB = b.tenant.id;
  const branchA = a.branch.id;
  const branchB = b.branch.id;
  const auth = (token) => ({ Authorization: `Bearer ${token}` });

  // Users created directly (Argon2 hashes, never plaintext), mirroring
  // test-repairs-http.mjs. Memberships are inserted with the matching
  // tenant RLS context, one row per (user, tenant).
  async function createUserWithMemberships(email, role, memberships) {
    const hash = await argon2.hash('twelve-chars-min', {
      type: argon2.argon2id,
      memoryCost: 19456,
      timeCost: 2,
      parallelism: 1,
    });
    const user = await prisma.user.create({
      data: { email, passwordHash: hash, name: email.split('@')[0] },
    });
    for (const m of memberships) {
      await prisma.withTenant(m.tenantId, async (tx) => {
        await tx.membership.create({
          data: { userId: user.id, tenantId: m.tenantId, role, branchIds: m.branchIds },
        });
      });
    }
    return user;
  }
  await createUserWithMemberships('dual@example.test', 'manager', [
    { tenantId: tenantA, branchIds: [branchA] },
    { tenantId: tenantB, branchIds: [branchB] },
  ]);
  await createUserWithMemberships('staff-a@example.test', 'technician', [
    { tenantId: tenantA, branchIds: [branchA] },
  ]);
  const loginAs = (email) =>
    api.post('/api/auth/login').send({ email, password: 'twelve-chars-min' }).expect(200);

  // Fixtures for the branch-resource cases: one customer + device per tenant.
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
  const fixturesA = await makeCustomerDevice(a.tokens.accessToken);
  const fixturesB = await makeCustomerDevice(b.tokens.accessToken);

  // Multi-tenant login: unscoped token, selection required, no refresh
  // token until a tenant is picked.
  const dualLogin = (await loginAs('dual@example.test')).body;
  if (
    dualLogin.requiresTenantSelection !== true ||
    dualLogin.tokens.refreshToken ||
    dualLogin.user.email !== 'dual@example.test'
  ) {
    throw new Error('Multi-tenant login must require tenant selection without a refresh token');
  }
  if (
    dualLogin.tenants.length !== 2 ||
    !dualLogin.tenants.some((t) => t.tenantId === tenantA) ||
    !dualLogin.tenants.some((t) => t.tenantId === tenantB)
  ) {
    throw new Error('Multi-tenant login must list both tenants');
  }
  const unscoped = dualLogin.tokens.accessToken;
  const meUnscoped = (await api.get('/api/auth/me').set(auth(unscoped)).expect(200)).body;
  if (meUnscoped.tenantContext !== null || meUnscoped.memberships.length !== 2) {
    throw new Error('/me with an unscoped token must show both memberships and no tenant context');
  }
  // An unscoped token cannot touch tenant resources at all.
  await api
    .post('/api/repairs')
    .set(auth(unscoped))
    .send({
      customerId: fixturesA.customer.id,
      deviceId: fixturesA.device.id,
      branchId: branchA,
      problemDescription: 'No tenant selected',
    })
    .expect(401);
  console.log('PASS multi-tenant login: unscoped token, selection required, no tenant resources');

  // Select tenant A, then tenant B from the scoped token. Each selection
  // issues fresh scoped tokens bound to (user, tenant).
  const selectA = (
    await api
      .post('/api/auth/select-tenant')
      .set(auth(unscoped))
      .send({ tenantId: tenantA })
      .expect(200)
  ).body;
  const tokenDualA = selectA.tokens.accessToken;
  const refreshDualA = selectA.tokens.refreshToken;
  if (!tokenDualA || !refreshDualA || selectA.tenantContext.tenantId !== tenantA) {
    throw new Error('select-tenant A must return scoped tokens for tenant A');
  }
  const meA = (await api.get('/api/auth/me').set(auth(tokenDualA)).expect(200)).body;
  if (meA.tenantContext?.tenantName !== 'Shop A' || meA.user.email !== 'dual@example.test') {
    throw new Error('/me with the tenant-A token must show Shop A');
  }
  const selectB = (
    await api
      .post('/api/auth/select-tenant')
      .set(auth(tokenDualA))
      .send({ tenantId: tenantB })
      .expect(200)
  ).body;
  const tokenDualB = selectB.tokens.accessToken;
  const refreshDualB = selectB.tokens.refreshToken;
  if (!tokenDualB || !refreshDualB || selectB.tenantContext.tenantId !== tenantB) {
    throw new Error('select-tenant B must return scoped tokens for tenant B');
  }
  const meB = (await api.get('/api/auth/me').set(auth(tokenDualB)).expect(200)).body;
  if (meB.tenantContext?.tenantName !== 'Shop B') {
    throw new Error('/me with the tenant-B token must show Shop B');
  }
  console.log('PASS tenant selection: scoped tokens per tenant, /me follows the token');

  // Stale scope: the old tenant-A token still identifies tenant A after
  // the switch — scoped tokens do not follow the user to tenant B.
  const meStale = (await api.get('/api/auth/me').set(auth(tokenDualA)).expect(200)).body;
  if (meStale.tenantContext?.tenantName !== 'Shop A') {
    throw new Error('The pre-switch token must still be scoped to tenant A');
  }
  const repairBody = (branchId, customerId, deviceId) => ({
    customerId,
    deviceId,
    branchId,
    problemDescription: 'Screen cracked',
  });
  await api
    .post('/api/repairs')
    .set(auth(tokenDualA))
    .send(repairBody(branchB, fixturesA.customer.id, fixturesA.device.id))
    .expect(403);
  await api
    .post('/api/repairs')
    .set(auth(tokenDualB))
    .send(repairBody(branchA, fixturesB.customer.id, fixturesB.device.id))
    .expect(403);
  // Positive controls: each token works for its own tenant.
  await api
    .post('/api/repairs')
    .set(auth(tokenDualA))
    .send(repairBody(branchA, fixturesA.customer.id, fixturesA.device.id))
    .expect(201);
  await api
    .post('/api/repairs')
    .set(auth(tokenDualB))
    .send(repairBody(branchB, fixturesB.customer.id, fixturesB.device.id))
    .expect(201);
  console.log('PASS stale scope: old token keeps its tenant; foreign branch is 403 both ways');

  // Cross-account denial: a user who is a member of tenant A only.
  const staffLogin = (await loginAs('staff-a@example.test')).body;
  if (staffLogin.requiresTenantSelection) {
    throw new Error('Single-tenant login must be scoped, not require selection');
  }
  const tokenStaffA = staffLogin.tokens.accessToken;
  await api
    .post('/api/auth/select-tenant')
    .set(auth(tokenStaffA))
    .send({ tenantId: tenantB })
    .expect(403);
  await api.get(`/api/customers/${fixturesB.customer.id}`).set(auth(tokenStaffA)).expect(404);
  await api
    .post('/api/repairs')
    .set(auth(tokenStaffA))
    .send(repairBody(branchB, fixturesA.customer.id, fixturesA.device.id))
    .expect(403);
  console.log('PASS cross-account denial: tenant-B selection 403, tenant-B read 404, branch 403');

  // Logout revokes only that refresh family; the other session keeps
  // working, and a fresh login after logout works.
  await api.post('/api/auth/logout').send({ refreshToken: refreshDualB }).expect(200);
  await api.post('/api/auth/refresh').send({ refreshToken: refreshDualB }).expect(401);
  const stillAlive = await api
    .post('/api/auth/refresh')
    .send({ refreshToken: refreshDualA })
    .expect(200);
  if (!stillAlive.body.accessToken) {
    throw new Error('Logging out one family must not kill the other session');
  }
  const dualRelogin = (await loginAs('dual@example.test')).body;
  if (dualRelogin.requiresTenantSelection !== true) {
    throw new Error('Re-login after logout must work and require tenant selection again');
  }
  const reselected = (
    await api
      .post('/api/auth/select-tenant')
      .set(auth(dualRelogin.tokens.accessToken))
      .send({ tenantId: tenantA })
      .expect(200)
  ).body;
  const meReselected = (
    await api.get('/api/auth/me').set(auth(reselected.tokens.accessToken)).expect(200)
  ).body;
  if (
    meReselected.user.email !== 'dual@example.test' ||
    meReselected.tenantContext?.tenantName !== 'Shop A'
  ) {
    throw new Error('Re-login + re-selection must restore the tenant-A session');
  }
  console.log('PASS logout revokes one family only; fresh login after logout works');

  // The first user's access token still identifies the first user after
  // other users have logged in — tokens are bound to (user, tenant),
  // not to whoever logged in last.
  const meFirst = (await api.get('/api/auth/me').set(auth(a.tokens.accessToken)).expect(200)).body;
  if (
    meFirst.user.email !== 'owner-a@example.test' ||
    meFirst.tenantContext?.tenantName !== 'Shop A'
  ) {
    throw new Error("User A's access token must still identify user A in tenant A");
  }
  console.log('PASS access tokens stay bound to their user and tenant after other logins');
  const unknown = await api.get('/api/auth/me').expect(401);
  if (unknown.body.statusCode !== 401) throw new Error('Missing JWT must fail closed');
  await api
    .post('/api/auth/register')
    .send({ ...owner, email: 'OWNER-A@EXAMPLE.TEST' })
    .expect(409);
  console.log('PASS missing JWT denial and normalized duplicate email');
} finally {
  if (app) await app.close();
  await testDb?.stop();
}
