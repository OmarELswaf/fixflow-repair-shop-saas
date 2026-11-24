/* global console, process, URL, fetch, setTimeout */
import { spawn, execFile } from 'node:child_process';
import { createRequire } from 'node:module';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { checkContentionGate } from './contention-gate.mjs';

/**
 * Normal-PostgreSQL contention suite. This is NOT part of `npm test`
 * and NOT part of CI: it needs a real PostgreSQL 16 server, a built
 * API and a TEST database the operator set up on purpose.
 *
 * Gate (see contention-gate.mjs): FIXFLOW_TEST_DATABASE_URL must
 * point at a localhost database whose name contains 'test', and
 * FIXFLOW_TEST_DB_CONFIRM must be 'test'. Anything else is refused
 * with exit code 2 — never against real data.
 *
 * Database setup the operator provides (like docker-compose):
 * - FIXFLOW_TEST_DATABASE_URL: the APP role (non-owner, NOBYPASSRLS,
 *   table grants, e.g. fixflow_test_app). The API and all
 *   verification queries connect as this role.
 * - FIXFLOW_TEST_MIGRATION_DATABASE_URL (optional, defaults to the
 *   test URL): an OWNER role that can run `prisma migrate deploy`.
 *   When the two are the same role the API refuses to start (its
 *   startup role check rejects table owners), so they must differ
 *   on a real server.
 *
 * The script uses only `pg`, fetch and child_process. It never
 * imports the generated Prisma client.
 */
process.chdir(fileURLToPath(new URL('../', import.meta.url)));
const require = createRequire(import.meta.url);
const { Pool } = require('pg');
const argon2 = require('argon2');

const gate = checkContentionGate(process.env);
if (!gate.ok) {
  console.error(`REFUSED: ${gate.reason}`);
  console.error(
    'Set FIXFLOW_TEST_DATABASE_URL to a localhost TEST database and FIXFLOW_TEST_DB_CONFIRM=test.',
  );
  process.exit(2);
}
const TEST_URL = process.env.FIXFLOW_TEST_DATABASE_URL;
const MIGRATION_URL = process.env.FIXFLOW_TEST_MIGRATION_DATABASE_URL ?? TEST_URL;
const API_PORT = 3100;
const API_BASE = `http://127.0.0.1:${API_PORT}`;

const failures = [];
function check(name, cond, detail = '') {
  if (cond) {
    console.log(`PASS ${name}`);
  } else {
    console.log(`FAIL ${name}${detail ? ` — ${detail}` : ''}`);
    failures.push(name);
  }
}

function execFileAsync(file, args, options) {
  return new Promise((resolve, reject) => {
    execFile(file, args, options, (error, stdout, stderr) => {
      if (error) {
        error.stdout = stdout;
        error.stderr = stderr;
        reject(error);
      } else resolve({ stdout, stderr });
    });
  });
}

async function http(method, path, token, body) {
  const res = await fetch(`${API_BASE}${path}`, {
    method,
    headers: {
      'Content-Type': 'application/json',
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  let parsed = null;
  try {
    parsed = await res.json();
  } catch {
    // Non-JSON error bodies are reported by status alone.
  }
  return { status: res.status, body: parsed };
}

async function waitForHealth(child, timeoutMs = 30000) {
  const started = Date.now();
  for (;;) {
    try {
      const res = await fetch(`${API_BASE}/api/health`);
      if (res.status === 200) return;
    } catch {
      // Not up yet.
    }
    if (Date.now() - started > timeoutMs) {
      throw new Error('API did not become healthy in time.');
    }
    await new Promise((r) => setTimeout(r, 500));
  }
}

let apiChild = null;
let apiStderr = '';
let pool = null;

async function stopApi() {
  if (!apiChild) return;
  apiChild.kill('SIGTERM');
  await Promise.race([
    new Promise((r) => apiChild.once('exit', r)),
    new Promise((r) => setTimeout(r, 5000)),
  ]);
  if (apiChild.exitCode === null) apiChild.kill('SIGKILL');
  apiChild = null;
}

try {
  // --- 1. Migrate the TEST database (owner role) ---
  console.log('Migrating the test database...');
  try {
    await execFileAsync('npx', ['prisma', 'migrate', 'deploy'], {
      cwd: 'apps/api',
      env: { ...process.env, DATABASE_URL: MIGRATION_URL, DATABASE_OWNER_URL: MIGRATION_URL },
      maxBuffer: 10 * 1024 * 1024,
    });
  } catch (error) {
    console.error('Migration failed. If the test URL role is not an owner,');
    console.error('set FIXFLOW_TEST_MIGRATION_DATABASE_URL to an owner role.');
    console.error(String(error.stderr || error.message).slice(-2000));
    process.exit(1);
  }
  console.log('PASS migrate deploy');

  // --- 2. Start the built API against the TEST database ---
  apiChild = spawn('node', ['apps/api/dist/main.js'], {
    env: {
      ...process.env,
      DATABASE_URL: TEST_URL,
      JWT_ACCESS_SECRET: 'test-only-secret-not-for-production',
      JWT_REFRESH_SECRET: 'test-only-refresh-not-for-production',
      WEB_ORIGINS: 'http://localhost:5173',
      PORT: String(API_PORT),
      NODE_ENV: 'test',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  apiChild.stderr.on('data', (d) => {
    apiStderr += String(d);
    if (apiStderr.length > 20000) apiStderr = apiStderr.slice(-20000);
  });
  try {
    await waitForHealth(apiChild);
  } catch (error) {
    console.error(error.message);
    console.error(apiStderr.slice(-2000));
    process.exit(1);
  }
  console.log('PASS api healthy');

  pool = new Pool({ connectionString: TEST_URL, max: 5 });

  async function withTenantClient(tenantId, fn) {
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      await client.query(`SELECT set_config('app.tenant_id', $1, true)`, [tenantId]);
      const out = await fn(client);
      await client.query('COMMIT');
      return out;
    } catch (error) {
      await client.query('ROLLBACK').catch(() => {});
      throw error;
    } finally {
      client.release();
    }
  }

  async function createStaff(tenantId, email, role, branchIds) {
    const hash = await argon2.hash('twelve-chars-min', {
      type: argon2.argon2id,
      memoryCost: 19456,
      timeCost: 2,
      parallelism: 1,
    });
    const userId = randomUUID();
    await withTenantClient(tenantId, async (client) => {
      await client.query(
        `INSERT INTO users (id, email, "passwordHash", name) VALUES ($1, $2, $3, $4)`,
        [userId, email, hash, email.split('@')[0]],
      );
      await client.query(
        `INSERT INTO memberships (id, "userId", "tenantId", role, "branchIds") VALUES ($1, $2, $3, $4, $5)`,
        [randomUUID(), userId, tenantId, role, branchIds],
      );
    });
    const login = await http('POST', '/api/auth/login', null, {
      email,
      password: 'twelve-chars-min',
    });
    if (login.status !== 200) throw new Error(`Staff login failed for ${email}: ${login.status}`);
    return { userId, token: login.body.tokens.accessToken };
  }

  async function stockRow(tenantId, branchId, partId) {
    const { rows } = await pool.query(
      `SELECT "qtyOnHand", "reservedQty" FROM branch_stock WHERE "tenantId"=$1 AND "branchId"=$2 AND "partId"=$3`,
      [tenantId, branchId, partId],
    );
    return rows[0] ?? null;
  }

  async function countQuery(sql, params) {
    const { rows } = await pool.query(sql, params);
    return Number(rows[0].n);
  }

  // --- 3. Seed via HTTP ---
  const owner = (
    await http('POST', '/api/auth/register', null, {
      email: 'owner@example.test',
      password: 'twelve-chars-min',
      tenantName: 'Contention Shop',
      branchName: 'Main',
    })
  ).body;
  const tenantId = owner.tenant.id;
  const branchId = owner.branch.id;
  const ownerToken = owner.tokens.accessToken;
  const tech1 = await createStaff(tenantId, 'tech-1@example.test', 'technician', [branchId]);
  const tech3 = await createStaff(tenantId, 'tech-3@example.test', 'technician', [branchId]);
  const manager = await createStaff(tenantId, 'manager@example.test', 'manager', [branchId]);
  const customer = (await http('POST', '/api/customers', ownerToken, { name: 'Sara' })).body;
  const device = (
    await http('POST', `/api/customers/${customer.id}/devices`, ownerToken, {
      brand: 'Samsung',
      model: 'A54',
    })
  ).body;

  async function makePart(sku) {
    const res = await http('POST', '/api/parts', ownerToken, { sku, name: `Part ${sku}` });
    if (res.status !== 201) throw new Error(`Part create failed: ${res.status}`);
    return res.body;
  }
  async function makeRepair() {
    const res = await http('POST', '/api/repairs', ownerToken, {
      customerId: customer.id,
      deviceId: device.id,
      branchId,
      problemDescription: 'Screen cracked',
    });
    if (res.status !== 201) throw new Error(`Repair create failed: ${res.status}`);
    return res.body;
  }
  async function adjust(partId, delta, key) {
    const res = await http('POST', '/api/stock/adjust', ownerToken, {
      branchId,
      partId,
      delta,
      idempotencyKey: key,
    });
    if (res.status !== 200) throw new Error(`Adjust failed: ${res.status}`);
    return res.body;
  }
  async function reserve(repairId, partId, qty, key, token = ownerToken) {
    return http('POST', `/api/repairs/${repairId}/parts`, token, {
      partId,
      qty,
      idempotencyKey: key,
    });
  }

  // --- (a) Last-unit reserve: two concurrent reserves, one must lose ---
  {
    const part = await makePart('LAST-UNIT');
    await adjust(part.id, 1, 'cont-a-adjust-00000001');
    const repair = await makeRepair();
    const [r1, r2] = await Promise.all([
      reserve(repair.id, part.id, 1, 'cont-a-res-00000001'),
      reserve(repair.id, part.id, 1, 'cont-a-res-00000002'),
    ]);
    const statuses = [r1.status, r2.status].sort();
    check(
      '(a) last-unit reserve: exactly one 200 and one 422',
      statuses[0] === 200 && statuses[1] === 422,
      `got ${r1.status}/${r2.status}`,
    );
    const row = await stockRow(tenantId, branchId, part.id);
    check(
      '(a) last-unit reserve: reservedQty is exactly 1',
      row !== null && row.qtyOnHand === 1 && row.reservedQty === 1,
      JSON.stringify(row),
    );
    const lines = await countQuery(
      `SELECT count(*)::int AS n FROM repair_parts WHERE "tenantId"=$1 AND "branchId"=$2 AND "partId"=$3 AND status='reserved'`,
      [tenantId, branchId, part.id],
    );
    check('(a) last-unit reserve: exactly one reserved line', lines === 1, `got ${lines}`);
    const moves = await countQuery(
      `SELECT count(*)::int AS n FROM stock_movements WHERE "tenantId"=$1 AND "branchId"=$2 AND "partId"=$3 AND reason='reserve'`,
      [tenantId, branchId, part.id],
    );
    check('(a) last-unit reserve: exactly one reserve movement', moves === 1, `got ${moves}`);
  }

  // --- (b) Reserve racing a cancel: exactly one outcome, consistent state ---
  {
    const part = await makePart('RACE-CANCEL');
    await adjust(part.id, 3, 'cont-b-adjust-00000001');
    const repair = await makeRepair();
    const [reserveRes, cancelRes] = await Promise.all([
      reserve(repair.id, part.id, 3, 'cont-b-res-00000001'),
      http('POST', `/api/repairs/${repair.id}/transition`, ownerToken, {
        toStatus: 'cancelled',
        expectedVersion: 0,
      }),
    ]);
    check(
      '(b) reserve-vs-cancel: cancel succeeds',
      cancelRes.status === 200,
      `got ${cancelRes.status}`,
    );
    const detail = await http('GET', `/api/repairs/${repair.id}`, ownerToken);
    check(
      '(b) reserve-vs-cancel: repair is cancelled',
      detail.status === 200 && detail.body.status === 'cancelled',
      `got ${detail.status}/${detail.body?.status}`,
    );
    const row = await stockRow(tenantId, branchId, part.id);
    check(
      '(b) reserve-vs-cancel: reservedQty is 0 after cancel',
      row !== null && row.reservedQty === 0 && row.qtyOnHand === 3,
      JSON.stringify(row),
    );
    if (reserveRes.status === 200) {
      const lineId = reserveRes.body.id;
      const line = await countQuery(
        `SELECT count(*)::int AS n FROM repair_parts WHERE id=$1 AND status='released'`,
        [lineId],
      );
      check('(b) reserve-vs-cancel: winning reserve was auto-released', line === 1, `got ${line}`);
      const autoRelease = await countQuery(
        `SELECT count(*)::int AS n FROM stock_movements WHERE "repairPartId"=$1 AND reason='release' AND "operationKey"=$2`,
        [lineId, `auto-release:${repair.id}:${lineId}`],
      );
      check(
        '(b) reserve-vs-cancel: auto-release movement is traced',
        autoRelease === 1,
        `got ${autoRelease}`,
      );
    } else {
      check(
        '(b) reserve-vs-cancel: losing reserve is a clean 422',
        reserveRes.status === 422,
        `got ${reserveRes.status}`,
      );
      const lines = await countQuery(
        `SELECT count(*)::int AS n FROM repair_parts WHERE "tenantId"=$1 AND "orderId"=$2`,
        [tenantId, repair.id],
      );
      check('(b) reserve-vs-cancel: losing reserve left no line', lines === 0, `got ${lines}`);
    }
  }

  // --- (c) Consume racing a reassignment: at most one consumption ---
  {
    const part = await makePart('RACE-REASSIGN');
    await adjust(part.id, 5, 'cont-c-adjust-00000001');
    const repair = await makeRepair();
    const assigned = await http('POST', `/api/repairs/${repair.id}/assign`, ownerToken, {
      technicianUserId: tech1.userId,
    });
    if (assigned.status !== 200) throw new Error(`Assign failed: ${assigned.status}`);
    const line = (await reserve(repair.id, part.id, 2, 'cont-c-res-00000001')).body;
    const [consumeRes, reassignRes] = await Promise.all([
      http('POST', `/api/repairs/${repair.id}/parts/${line.id}/consume`, tech1.token, {
        idempotencyKey: 'cont-c-cons-00000001',
      }),
      http('POST', `/api/repairs/${repair.id}/assign`, manager.token, {
        technicianUserId: tech3.userId,
      }),
    ]);
    check(
      '(c) consume-vs-reassignment: no 500 from either side',
      consumeRes.status !== 500 && reassignRes.status !== 500,
      `consume ${consumeRes.status}, reassign ${reassignRes.status}`,
    );
    check(
      '(c) consume-vs-reassignment: reassign succeeds',
      reassignRes.status === 200,
      `got ${reassignRes.status}`,
    );
    const parts = await http('GET', `/api/repairs/${repair.id}/parts`, ownerToken);
    const lineNow = parts.body.find((l) => l.id === line.id);
    const row = await stockRow(tenantId, branchId, part.id);
    const consumeMoves = await countQuery(
      `SELECT count(*)::int AS n FROM stock_movements WHERE "repairPartId"=$1 AND reason='consume'`,
      [line.id],
    );
    if (consumeRes.status === 200) {
      check(
        '(c) consume-vs-reassignment: winning consume decremented both once',
        lineNow?.status === 'consumed' &&
          row !== null &&
          row.qtyOnHand === 3 &&
          row.reservedQty === 0 &&
          consumeMoves === 1,
        `line ${lineNow?.status}, row ${JSON.stringify(row)}, moves ${consumeMoves}`,
      );
    } else {
      check(
        '(c) consume-vs-reassignment: losing consume is a clean 403',
        consumeRes.status === 403,
        `got ${consumeRes.status}`,
      );
      check(
        '(c) consume-vs-reassignment: line stays reserved, stock untouched',
        lineNow?.status === 'reserved' &&
          row !== null &&
          row.qtyOnHand === 5 &&
          row.reservedQty === 2 &&
          consumeMoves === 0,
        `line ${lineNow?.status}, row ${JSON.stringify(row)}, moves ${consumeMoves}`,
      );
    }
  }

  // --- (d) Duplicate retries: same key 5x concurrently, one effect ---
  {
    const part = await makePart('DUP-RETRY');
    await adjust(part.id, 5, 'cont-d-adjust-00000001');
    const repair = await makeRepair();
    const attempts = await Promise.all(
      Array.from({ length: 5 }, () => reserve(repair.id, part.id, 2, 'cont-d-res-00000001')),
    );
    const all200 = attempts.every((a) => a.status === 200);
    const sameLine = attempts.every((a) => a.body?.id === attempts[0].body?.id);
    const sameQty = attempts.every((a) => a.body?.qty === 2);
    check(
      '(d) duplicate retries: all 5 responses identical',
      all200 && sameLine && sameQty,
      attempts.map((a) => `${a.status}:${a.body?.id}`).join(','),
    );
    const row = await stockRow(tenantId, branchId, part.id);
    check(
      '(d) duplicate retries: reservedQty moved exactly once',
      row !== null && row.reservedQty === 2,
      JSON.stringify(row),
    );
    const moves = await countQuery(
      `SELECT count(*)::int AS n FROM stock_movements WHERE "tenantId"=$1 AND "branchId"=$2 AND "partId"=$3 AND reason='reserve' AND "operationKey"=$4`,
      [tenantId, branchId, part.id, 'cont-d-res-00000001'],
    );
    check('(d) duplicate retries: exactly one reserve movement', moves === 1, `got ${moves}`);
  }

  // --- (e) Rollback: a failing reserve leaves no partial writes ---
  {
    const part = await makePart('ROLLBACK');
    await adjust(part.id, 5, 'cont-e-adjust-00000001');
    const repair = await makeRepair();
    const beforeMoves = await countQuery(
      `SELECT count(*)::int AS n FROM stock_movements WHERE "tenantId"=$1 AND "branchId"=$2 AND "partId"=$3`,
      [tenantId, branchId, part.id],
    );
    const beforeLines = await countQuery(
      `SELECT count(*)::int AS n FROM repair_parts WHERE "tenantId"=$1 AND "orderId"=$2`,
      [tenantId, repair.id],
    );
    const failed = await reserve(repair.id, part.id, 999, 'cont-e-res-00000001');
    check(
      '(e) rollback: over-reserve is a clean 422',
      failed.status === 422,
      `got ${failed.status}`,
    );
    const afterMoves = await countQuery(
      `SELECT count(*)::int AS n FROM stock_movements WHERE "tenantId"=$1 AND "branchId"=$2 AND "partId"=$3`,
      [tenantId, branchId, part.id],
    );
    const afterLines = await countQuery(
      `SELECT count(*)::int AS n FROM repair_parts WHERE "tenantId"=$1 AND "orderId"=$2`,
      [tenantId, repair.id],
    );
    const row = await stockRow(tenantId, branchId, part.id);
    check(
      '(e) rollback: no partial movement or line, stock unchanged',
      afterMoves === beforeMoves &&
        afterLines === beforeLines &&
        row !== null &&
        row.qtyOnHand === 5 &&
        row.reservedQty === 0,
      `moves ${beforeMoves}->${afterMoves}, lines ${beforeLines}->${afterLines}, row ${JSON.stringify(row)}`,
    );
    // Direct proof the test database honors rollback.
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      await client.query(`SELECT set_config('app.tenant_id', $1, true)`, [tenantId]);
      await client.query(
        `INSERT INTO stock_movements (id, "tenantId", "branchId", "partId", qty, reason) VALUES ($1, $2, $3, $4, 1, 'adjust')`,
        ['cont-rollback-probe', tenantId, branchId, part.id],
      );
      await client.query('ROLLBACK');
    } finally {
      client.release();
    }
    const probe = await countQuery(
      `SELECT count(*)::int AS n FROM stock_movements WHERE id='cont-rollback-probe'`,
      [],
    );
    check('(e) rollback: rolled-back insert is gone', probe === 0, `got ${probe}`);
  }

  // --- Global invariants (direct SQL, explicit tenant filter) ---
  const negative = await countQuery(
    `SELECT count(*)::int AS n FROM branch_stock WHERE "tenantId"=$1 AND ("qtyOnHand" < 0 OR "reservedQty" < 0 OR "reservedQty" > "qtyOnHand")`,
    [tenantId],
  );
  check('invariants: no negative or over-reserved stock', negative === 0, `got ${negative}`);
  const mismatched = await countQuery(
    `SELECT count(*)::int AS n FROM branch_stock bs WHERE bs."tenantId"=$1 AND bs."reservedQty" <> COALESCE((SELECT SUM(qty) FROM repair_parts rp WHERE rp."tenantId"=bs."tenantId" AND rp."branchId"=bs."branchId" AND rp."partId"=bs."partId" AND rp.status='reserved'), 0)`,
    [tenantId],
  );
  check(
    'invariants: reservedQty equals reserved lines everywhere',
    mismatched === 0,
    `got ${mismatched}`,
  );
  const orphanParts = await countQuery(
    `SELECT count(*)::int AS n FROM stock_movements m WHERE m."tenantId"=$1 AND NOT EXISTS (SELECT 1 FROM parts p WHERE p."tenantId"=m."tenantId" AND p.id=m."partId")`,
    [tenantId],
  );
  check('invariants: no orphan movements (part)', orphanParts === 0, `got ${orphanParts}`);
  const orphanOrders = await countQuery(
    `SELECT count(*)::int AS n FROM stock_movements m WHERE m."tenantId"=$1 AND m."repairOrderId" IS NOT NULL AND NOT EXISTS (SELECT 1 FROM repair_orders o WHERE o."tenantId"=m."tenantId" AND o.id=m."repairOrderId")`,
    [tenantId],
  );
  check('invariants: no orphan movements (repair)', orphanOrders === 0, `got ${orphanOrders}`);
  const orphanLines = await countQuery(
    `SELECT count(*)::int AS n FROM stock_movements m WHERE m."tenantId"=$1 AND m."repairPartId" IS NOT NULL AND NOT EXISTS (SELECT 1 FROM repair_parts rp WHERE rp."tenantId"=m."tenantId" AND rp.id=m."repairPartId")`,
    [tenantId],
  );
  check('invariants: no orphan movements (line)', orphanLines === 0, `got ${orphanLines}`);
  const overCeiling = await countQuery(
    `SELECT count(*)::int AS n FROM branch_stock WHERE "tenantId"=$1 AND ("qtyOnHand" > 1000000000 OR "reservedQty" > 1000000000)`,
    [tenantId],
  );
  check('invariants: no stock above the quantity ceiling', overCeiling === 0, `got ${overCeiling}`);

  console.log(
    failures.length === 0
      ? 'PASS contention suite: all scenarios and invariants held'
      : `FAIL contention suite: ${failures.length} check(s) failed`,
  );
  process.exitCode = failures.length === 0 ? 0 : 1;
} catch (error) {
  console.error('Contention suite error:', error);
  process.exitCode = 1;
} finally {
  await stopApi();
  if (pool) await pool.end();
}
