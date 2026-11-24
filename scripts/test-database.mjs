/* global console */
import { PGlite } from '@electric-sql/pglite';
import { readFileSync, readdirSync } from 'node:fs';
import { resolve } from 'node:path';
import assert from 'node:assert/strict';

// Real embedded PostgreSQL engine, not a SQL mock. Does not validate TCP,
// Docker image startup, Prisma driver pooling or production PostgreSQL 16.
const db = new PGlite();
let checks = 0;
async function rejects(sql) {
  await assert.rejects(db.exec(sql));
  checks++;
}
try {
  const migrations = resolve('apps/api/prisma/migrations');
  for (const dir of readdirSync(migrations)
    .filter((x) => /^\d/.test(x))
    .sort()) {
    await db.exec(readFileSync(resolve(migrations, dir, 'migration.sql'), 'utf8'));
  }
  checks++;
  await db.exec(`
    CREATE ROLE fixflow_test_app NOSUPERUSER NOBYPASSRLS;
    GRANT USAGE ON SCHEMA public TO fixflow_test_app;
    GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO fixflow_test_app;
    INSERT INTO tenants (id,name) VALUES ('a','Tenant A'),('b','Tenant B');
    INSERT INTO branches (id,"tenantId",name) VALUES ('ba','a','Branch A'),('bb','b','Branch B');
    INSERT INTO customers (id,"tenantId",name) VALUES ('ca','a','Customer A'),('cb','b','Customer B');
    INSERT INTO parts (id,"tenantId",sku,name) VALUES ('pa','a','A','Part A'),('pb','b','B','Part B');
    INSERT INTO branch_stock ("tenantId","branchId","partId","qtyOnHand") VALUES ('a','ba','pa',5);
    INSERT INTO roles (id,"tenantId",name) VALUES ('ra','a','Owner'),('rb','b','Owner');
    INSERT INTO permissions (id,name) VALUES ('p','repair:read');
    INSERT INTO role_permissions ("tenantId","roleId","permissionId") VALUES ('a','ra','p'),('b','rb','p');
    INSERT INTO users (id,email,"passwordHash") VALUES ('ua','a@example.test','test-hash'),('ub','b@example.test','test-hash');
    INSERT INTO memberships (id,"userId","tenantId",role) VALUES ('ma','ua','a','owner'),('mb','ub','b','owner');
    INSERT INTO refresh_sessions (id,"userId","tenantId","tokenHash","familyId","expiresAt") VALUES ('sa','ua','a','hash-a','family-a',now()+interval '1 day'),('sb','ub','b','hash-b','family-b',now()+interval '1 day');
    SET ROLE fixflow_test_app;
  `);
  assert.equal((await db.query('SELECT * FROM customers')).rows.length, 0);
  checks++;
  await db.exec("BEGIN; SELECT set_config('app.tenant_id','a',true)");
  assert.deepEqual(
    (await db.query('SELECT id FROM customers')).rows.map((x) => x.id),
    ['ca'],
  );
  checks++;
  assert.deepEqual(
    (await db.query('SELECT "roleId" FROM role_permissions')).rows.map((x) => x.roleId),
    ['ra'],
  );
  checks++;
  assert.equal((await db.query('SELECT * FROM reseller_tenants')).rows.length, 0);
  checks++;
  await db.exec('COMMIT');
  assert.equal((await db.query('SELECT * FROM customers')).rows.length, 0);
  checks++;
  await rejects(
    `BEGIN; SELECT set_config('app.tenant_id','a',true); INSERT INTO customers (id,"tenantId",name) VALUES ('spoof','b','Wrong tenant')`,
  );
  await db.exec('ROLLBACK');
  await rejects(
    `BEGIN; SELECT set_config('app.tenant_id','a',true); INSERT INTO devices (id,"tenantId","customerId",brand,model) VALUES ('bad','a','cb','X','X')`,
  );
  await db.exec('ROLLBACK');
  await rejects(
    `BEGIN; SELECT set_config('app.tenant_id','a',true); UPDATE branch_stock SET "reservedQty"=6 WHERE "partId"='pa'`,
  );
  await db.exec('ROLLBACK');
  await rejects(
    `BEGIN; SELECT set_config('app.tenant_id','a',true); UPDATE branch_stock SET "qtyOnHand"=-1 WHERE "partId"='pa'`,
  );
  await db.exec('ROLLBACK');
  await rejects(
    `BEGIN; SELECT set_config('app.tenant_id','a',true); INSERT INTO role_permissions ("roleId","permissionId") VALUES ('rb','other')`,
  );
  await db.exec('ROLLBACK');
  assert.equal((await db.query('SELECT * FROM memberships')).rows.length, 0);
  checks++;
  assert.equal((await db.query('SELECT * FROM refresh_sessions')).rows.length, 0);
  checks++;
  await db.exec("BEGIN; SELECT set_config('app.auth_user_id','ua',true)");
  assert.deepEqual(
    (await db.query('SELECT id FROM memberships')).rows.map((x) => x.id),
    ['ma'],
  );
  checks++;
  assert.deepEqual(
    (await db.query('SELECT id FROM refresh_sessions')).rows.map((x) => x.id),
    ['sa'],
  );
  checks++;
  await db.exec('COMMIT');
  await db.exec("BEGIN; SELECT set_config('app.refresh_hash','hash-b',true)");
  assert.deepEqual(
    (await db.query('SELECT id FROM refresh_sessions')).rows.map((x) => x.id),
    ['sb'],
  );
  checks++;
  await db.exec('COMMIT');
  assert.equal((await db.query('SELECT * FROM refresh_sessions')).rows.length, 0);
  checks++;
  // Phase 4 (migration 0005): new roles, new statuses, version default,
  // assignment FK, and the inventory CHECK on INSERT as well as UPDATE.
  await db.exec('RESET ROLE');
  await db.exec(`
    INSERT INTO users (id,email,"passwordHash") VALUES ('ur','r@example.test','x'),('uac','ac@example.test','x');
    INSERT INTO memberships (id,"userId","tenantId",role,"branchIds") VALUES ('mr','ur','a','receptionist','{ba}'),('mac','uac','a','accountant','{ba}');
    INSERT INTO devices (id,"tenantId","customerId",brand,model) VALUES ('da','a','ca','Samsung','A54');
    INSERT INTO parts (id,"tenantId",sku,name) VALUES ('pc','a','C','Part C');
    INSERT INTO repair_orders (id,"tenantId","branchId","customerId","deviceId",status) VALUES ('rq','a','ba','ca','da','quality_check'),('ru','a','ba','ca','da','unrepairable');
  `);
  assert.equal(
    (
      await db.query(
        `SELECT count(*)::int AS n FROM memberships WHERE role IN ('receptionist','accountant')`,
      )
    ).rows[0].n,
    2,
  );
  checks++;
  assert.equal(
    (
      await db.query(
        `SELECT count(*)::int AS n FROM repair_orders WHERE status IN ('quality_check','unrepairable')`,
      )
    ).rows[0].n,
    2,
  );
  checks++;
  assert.equal(
    (await db.query(`SELECT version FROM repair_orders WHERE id='rq'`)).rows[0].version,
    0,
  );
  checks++;
  await db.exec('SET ROLE fixflow_test_app');
  await rejects(
    `BEGIN; SELECT set_config('app.tenant_id','a',true); INSERT INTO branch_stock ("tenantId","branchId","partId","qtyOnHand","reservedQty") VALUES ('a','ba','pc',5,6)`,
  );
  await db.exec('ROLLBACK');
  await rejects(
    `BEGIN; SELECT set_config('app.tenant_id','a',true); INSERT INTO repair_orders (id,"tenantId","branchId","customerId","deviceId",status,"assignedTechnicianId") VALUES ('rbad','a','ba','ca','da','received','no-such-user')`,
  );
  await db.exec('ROLLBACK');
  // Phase 5 (migration 0007): repair part lines, partial unique index,
  // stock idempotency ledger, RLS on the new tables. The branch_stock
  // non-negative CHECKs are NOT new here — they already exist in 0001;
  // the reservedQty check below only proves they still hold.
  await db.exec('RESET ROLE');
  await db.exec(`
    INSERT INTO repair_orders (id,"tenantId","branchId","customerId","deviceId",status) VALUES ('ro1','a','ba','ca','da','received');
    INSERT INTO repair_parts (id,"tenantId","orderId","partId","branchId",qty,status) VALUES ('rp1','a','ro1','pa','ba',2,'reserved');
  `);
  assert.equal((await db.query(`SELECT qty FROM repair_parts WHERE id='rp1'`)).rows[0].qty, 2);
  checks++;
  await db.exec('SET ROLE fixflow_test_app');
  await rejects(
    `BEGIN; SELECT set_config('app.tenant_id','a',true); INSERT INTO repair_parts (id,"tenantId","orderId","partId","branchId",qty) VALUES ('rp0','a','ro1','pa','ba',0)`,
  );
  await db.exec('ROLLBACK');
  await rejects(
    `BEGIN; SELECT set_config('app.tenant_id','a',true); INSERT INTO repair_parts (id,"tenantId","orderId","partId","branchId",qty) VALUES ('rp2','a','ro1','pa','ba',1)`,
  );
  await db.exec('ROLLBACK');
  await rejects(
    `BEGIN; SELECT set_config('app.tenant_id','a',true); INSERT INTO repair_parts (id,"tenantId","orderId","partId","branchId",qty) VALUES ('rpx','a','ro1','pb','ba',1)`,
  );
  await db.exec('ROLLBACK');
  await db.exec(
    `BEGIN; SELECT set_config('app.tenant_id','a',true); UPDATE repair_parts SET status='released' WHERE id='rp1'; INSERT INTO repair_parts (id,"tenantId","orderId","partId","branchId",qty) VALUES ('rp2','a','ro1','pa','ba',1); COMMIT`,
  );
  await db.exec('RESET ROLE');
  assert.equal(
    (
      await db.query(
        `SELECT count(*)::int AS n FROM repair_parts WHERE "orderId"='ro1' AND "partId"='pa' AND status='reserved'`,
      )
    ).rows[0].n,
    1,
  );
  checks++;
  await db.exec('SET ROLE fixflow_test_app');
  await db.exec(
    `BEGIN; SELECT set_config('app.tenant_id','a',true); INSERT INTO stock_idempotency (id,"tenantId",scope,"key","entityId","responseJson") VALUES ('sk1','a','repair-part-reserve','key-1','rp1','{"ok":true}'::jsonb); COMMIT`,
  );
  await rejects(
    `BEGIN; SELECT set_config('app.tenant_id','a',true); INSERT INTO stock_idempotency (id,"tenantId",scope,"key","entityId","responseJson") VALUES ('sk2','a','repair-part-reserve','key-1','rp2','{}'::jsonb)`,
  );
  await db.exec('ROLLBACK');
  assert.equal(
    (
      await db.query(
        `SELECT count(*)::int AS n FROM pg_policies WHERE tablename IN ('repair_parts','stock_idempotency')`,
      )
    ).rows[0].n,
    2,
  );
  checks++;
  assert.equal(
    (
      await db.query(
        `SELECT count(*)::int AS n FROM pg_class WHERE relname IN ('repair_parts','stock_idempotency') AND relrowsecurity`,
      )
    ).rows[0].n,
    2,
  );
  checks++;
  await db.exec("BEGIN; SELECT set_config('app.tenant_id','b',true)");
  assert.equal((await db.query('SELECT * FROM repair_parts')).rows.length, 0);
  checks++;
  await db.exec('COMMIT');
  await rejects(
    `BEGIN; SELECT set_config('app.tenant_id','a',true); UPDATE branch_stock SET "reservedQty"=-1 WHERE "partId"='pa'`,
  );
  await db.exec('ROLLBACK');
  // Stock movements are append-only (trigger from 0007, same function as 0006).
  await db.exec('RESET ROLE');
  await db.exec(
    `INSERT INTO stock_movements (id,"tenantId","branchId","partId",qty,reason) VALUES ('mv1','a','ba','pa',5,'adjust')`,
  );
  await db.exec('SET ROLE fixflow_test_app');
  await rejects(
    `BEGIN; SELECT set_config('app.tenant_id','a',true); DELETE FROM stock_movements WHERE "partId"='pa'`,
  );
  await db.exec('ROLLBACK');
  // Phase 6 (migration 0008): movement trace columns, tenant-aware
  // FKs, trace indexes, quantity ceilings. Pre-0008 rows keep NULL
  // references — no backfill.
  await db.exec('RESET ROLE');
  assert.equal(
    (
      await db.query(
        `SELECT count(*)::int AS n FROM information_schema.columns WHERE table_name='stock_movements' AND column_name IN ('repairOrderId','repairPartId','operationKey','actorId') AND is_nullable='YES'`,
      )
    ).rows[0].n,
    4,
  );
  checks++;
  await rejects(
    `INSERT INTO stock_movements (id,"tenantId","branchId","partId",qty,reason,"repairOrderId") VALUES ('mvx','b','ba','pa',1,'adjust','ro1')`,
  );
  await rejects(
    `INSERT INTO stock_movements (id,"tenantId","branchId","partId",qty,reason,"repairPartId") VALUES ('mvx','b','ba','pa',1,'adjust','rp1')`,
  );
  await rejects(
    `INSERT INTO stock_movements (id,"tenantId","branchId","partId",qty,reason,"actorId") VALUES ('mvx','a','ba','pa',1,'adjust','no-such-user')`,
  );
  assert.equal(
    (
      await db.query(
        `SELECT count(*)::int AS n FROM pg_indexes WHERE indexname IN ('stock_movements_order_idx','stock_movements_operation_idx','stock_movements_actor_idx')`,
      )
    ).rows[0].n,
    3,
  );
  checks++;
  await db.exec('SET ROLE fixflow_test_app');
  await rejects(
    `BEGIN; SELECT set_config('app.tenant_id','a',true); UPDATE branch_stock SET "qtyOnHand"=1000000001 WHERE "partId"='pa'`,
  );
  await db.exec('ROLLBACK');
  await rejects(
    `BEGIN; SELECT set_config('app.tenant_id','a',true); INSERT INTO repair_parts (id,"tenantId","orderId","partId","branchId",qty) VALUES ('rpbig','a','ro1','pc','ba',1000000001)`,
  );
  await db.exec('ROLLBACK');
  await rejects(
    `BEGIN; SELECT set_config('app.tenant_id','a',true); INSERT INTO stock_movements (id,"tenantId","branchId","partId",qty,reason) VALUES ('mvbig','a','ba','pa',1000000001,'adjust')`,
  );
  await db.exec('ROLLBACK');
  await db.exec(
    `BEGIN; SELECT set_config('app.tenant_id','a',true); INSERT INTO stock_movements (id,"tenantId","branchId","partId",qty,reason,"repairOrderId","repairPartId","operationKey","actorId") VALUES ('mv2','a','ba','pa',2,'reserve','ro1','rp1','op-1','ua'); COMMIT`,
  );
  await db.exec("BEGIN; SELECT set_config('app.tenant_id','a',true)");
  assert.equal(
    (await db.query(`SELECT "operationKey" FROM stock_movements WHERE id='mv2'`)).rows[0]
      .operationKey,
    'op-1',
  );
  checks++;
  await db.exec('COMMIT');
  // Phase 7: reports run in one REPEATABLE READ transaction so a
  // single response never mixes two snapshots. PGlite must accept
  // the explicit isolation level, and now() (the snapshot label)
  // must be constant inside the transaction.
  await db.exec(
    `BEGIN TRANSACTION ISOLATION LEVEL REPEATABLE READ; SELECT set_config('app.tenant_id','a',true)`,
  );
  assert.equal(
    (await db.query('SHOW transaction_isolation')).rows[0].transaction_isolation,
    'repeatable read',
  );
  const snap1 = (await db.query('SELECT now() AS t')).rows[0].t;
  const snap2 = (await db.query('SELECT now() AS t')).rows[0].t;
  assert.equal(snap1.getTime(), snap2.getTime());
  assert.equal(
    (await db.query(`SELECT "operationKey" FROM stock_movements WHERE id='mv2'`)).rows[0]
      .operationKey,
    'op-1',
  );
  await db.exec('COMMIT');
  checks++;
  // Phase 10 (migration 0009): per-tenant public profile. No private
  // data is copied or backfilled; the table is owner-configured only.
  // RLS: tenant_isolation for owner operations plus a narrow
  // published-only SELECT policy for the unauthenticated public read.
  await db.exec('RESET ROLE');
  assert.equal(
    (
      await db.query(
        `SELECT count(*)::int AS n FROM information_schema.columns WHERE table_name='tenant_public_profiles' AND column_name IN ('tenantId','slug','published','displayName','description','logoUrl','theme','services','contact','hours','createdAt','updatedAt')`,
      )
    ).rows[0].n,
    12,
  );
  checks++;
  assert.equal(
    (await db.query(`SELECT relrowsecurity FROM pg_class WHERE relname='tenant_public_profiles'`))
      .rows[0].relrowsecurity,
    true,
  );
  checks++;
  assert.deepEqual(
    (
      await db.query(
        `SELECT polname FROM pg_policy WHERE polrelid='tenant_public_profiles'::regclass ORDER BY polname`,
      )
    ).rows.map((r) => r.polname),
    ['public_published_read', 'tenant_isolation'],
  );
  checks++;
  assert.equal(
    (
      await db.query(
        `SELECT count(*)::int AS n FROM pg_indexes WHERE indexname='tenant_public_profiles_slug_unique'`,
      )
    ).rows[0].n,
    1,
  );
  checks++;
  assert.equal(
    (
      await db.query(
        `SELECT count(*)::int AS n FROM pg_constraint WHERE conname='tenant_public_profiles_theme_check'`,
      )
    ).rows[0].n,
    1,
  );
  checks++;
  await db.exec(`INSERT INTO tenants (id,name) VALUES ('c','Tenant C'),('d','Tenant D')`);
  // Theme outside the allowed set is rejected by the CHECK constraint.
  await rejects(
    `INSERT INTO tenant_public_profiles ("tenantId",slug,"published",theme) VALUES ('d','shop-d',false,'purple')`,
  );
  // Slug uniqueness is a database rule: RLS can hide another tenant's
  // unpublished slug, so the service must not rely on a pre-check.
  await db.exec(
    `INSERT INTO tenant_public_profiles ("tenantId",slug,"published","displayName",theme) VALUES ('a','shop-a',true,'Shop A','green'),('b','shop-b',true,'Shop B','gold'),('c','shop-c',false,'Shop C','teal')`,
  );
  await rejects(`INSERT INTO tenant_public_profiles ("tenantId",slug) VALUES ('d','shop-a')`);
  await db.exec('SET ROLE fixflow_test_app');
  // No tenant context: only published rows are visible.
  assert.deepEqual(
    (await db.query(`SELECT slug FROM tenant_public_profiles ORDER BY slug`)).rows.map(
      (r) => r.slug,
    ),
    ['shop-a', 'shop-b'],
  );
  checks++;
  // Tenant 'a' sees its own rows plus other tenants' published rows,
  // but not tenant 'c''s unpublished row.
  await db.exec("BEGIN; SELECT set_config('app.tenant_id','a',true)");
  assert.deepEqual(
    (await db.query(`SELECT slug FROM tenant_public_profiles ORDER BY slug`)).rows.map(
      (r) => r.slug,
    ),
    ['shop-a', 'shop-b'],
  );
  checks++;
  await db.exec('COMMIT');
  // Tenant 'c' sees its own unpublished row too.
  await db.exec("BEGIN; SELECT set_config('app.tenant_id','c',true)");
  assert.deepEqual(
    (await db.query(`SELECT slug FROM tenant_public_profiles ORDER BY slug`)).rows.map(
      (r) => r.slug,
    ),
    ['shop-a', 'shop-b', 'shop-c'],
  );
  checks++;
  await db.exec('COMMIT');
  // A write for another tenant is rejected by the WITH CHECK clause.
  await rejects(
    `BEGIN; SELECT set_config('app.tenant_id','a',true); INSERT INTO tenant_public_profiles ("tenantId",slug) VALUES ('b','shop-x')`,
  );
  await db.exec('ROLLBACK');
  // A duplicate slug is rejected even under RLS (tenant 'd' has no
  // profile yet, so the WITH CHECK passes and only the unique index
  // can reject it).
  await rejects(
    `BEGIN; SELECT set_config('app.tenant_id','d',true); INSERT INTO tenant_public_profiles ("tenantId",slug) VALUES ('d','shop-a')`,
  );
  await db.exec('ROLLBACK');
  console.log(`${checks} embedded PostgreSQL migration/RLS/constraint checks passed`);
} finally {
  await db.close();
}
