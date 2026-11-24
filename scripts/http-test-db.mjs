/* global console, process, URL */
import { PGlite } from '@electric-sql/pglite';
import { PGLiteSocketServer } from '@electric-sql/pglite-socket';
import { readFileSync, readdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { checkContentionGate } from './contention-gate.mjs';

/**
 * Shared database bootstrap for the four HTTP harnesses
 * (test-auth-http, test-repairs-http, test-inventory-http,
 * test-reports-http). Call it before requiring the built API modules
 * — it sets process.env.DATABASE_URL, which PrismaService reads when
 * the testing module is created.
 *
 * Modes:
 * - Default (FIXFLOW_HTTP_DATABASE_URL unset): embedded PGlite over a
 *   TCP socket on 127.0.0.1:<port>, exactly as before. The database
 *   starts empty, migrations are applied from the SQL files, and the
 *   fixflow_test_app role is created.
 * - Normal PostgreSQL 16 (FIXFLOW_HTTP_DATABASE_URL set): the harness
 *   runs against that real database instead. The URL is gated with
 *   the same gate as the contention suite (localhost/127.0.0.1/::1
 *   only, database name must contain 'test', FIXFLOW_TEST_DB_CONFIRM
 *   must be 'test'); anything else is refused with exit code 2 and
 *   the URL is never printed. The database must already be migrated
 *   and have the app role — the supported path is
 *   `npm run test:pg16`, which creates the throwaway database,
 *   creates the roles and runs `prisma migrate deploy` first.
 *   Nothing is created or dropped here.
 *
 * The returned handle's stop() undoes whatever setup did: in PGlite
 * mode it stops the socket server and closes the embedded database;
 * in normal-PG16 mode it is a no-op (the database belongs to the
 * caller — `npm run test:pg16` tears it down).
 */
export async function setupHttpTestDb({ port }) {
  const pg16Url = process.env.FIXFLOW_HTTP_DATABASE_URL;
  if (pg16Url) {
    const gate = checkContentionGate({
      FIXFLOW_TEST_DATABASE_URL: pg16Url,
      FIXFLOW_TEST_DB_CONFIRM: process.env.FIXFLOW_TEST_DB_CONFIRM,
    });
    if (!gate.ok) {
      console.error(`REFUSED: ${gate.reason}`);
      console.error(
        'Set FIXFLOW_HTTP_DATABASE_URL to a localhost TEST database and FIXFLOW_TEST_DB_CONFIRM=test.',
      );
      process.exit(2);
    }
    process.env.DATABASE_URL = pg16Url;
    // The URL may carry a password: never print it, only the port.
    console.log(
      `HTTP harness database: normal PostgreSQL 16 on 127.0.0.1:${new URL(pg16Url).port || '5432'} (database name withheld)`,
    );
    return { mode: 'pg16', stop: async () => {} };
  }

  const db = new PGlite();
  const migrations = resolve('apps/api/prisma/migrations');
  for (const dir of readdirSync(migrations)
    .filter((x) => /^\d/.test(x))
    .sort()) {
    await db.exec(readFileSync(resolve(migrations, dir, 'migration.sql'), 'utf8'));
  }
  await db.exec(`CREATE ROLE fixflow_test_app LOGIN NOSUPERUSER NOBYPASSRLS;
    GRANT USAGE ON SCHEMA public TO fixflow_test_app;
    GRANT SELECT,INSERT,UPDATE,DELETE ON ALL TABLES IN SCHEMA public TO fixflow_test_app;
    SET ROLE fixflow_test_app;`);
  const server = new PGLiteSocketServer({ db, port, host: '127.0.0.1' });
  await server.start();
  process.env.DATABASE_URL = `postgresql://fixflow_test_app@127.0.0.1:${port}/postgres?connection_limit=1`;
  return {
    mode: 'pglite',
    stop: async () => {
      await server.stop();
      await db.close();
    },
  };
}
