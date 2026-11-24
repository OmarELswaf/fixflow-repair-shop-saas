import { Injectable, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { PrismaClient, Prisma } from '../generated/prisma/client';
import { PrismaPg } from '@prisma/adapter-pg';

/**
 * Prisma service. withTenant() sets the tenant via a PARAMETERIZED
 * transaction-local configuration on the SAME DB connection as the
 * transaction. Never interpolate a tenant id into SQL text.
 */
@Injectable()
export class PrismaService extends PrismaClient implements OnModuleInit, OnModuleDestroy {
  constructor() {
    const connectionString = process.env.DATABASE_URL;
    if (!connectionString) throw new Error('DATABASE_URL is required');
    super({
      adapter: new PrismaPg({
        connectionString,
        connectionTimeoutMillis: 5000,
        max: Number(process.env.DB_POOL_MAX ?? 10),
      }),
    });
  }

  async onModuleInit(): Promise<void> {
    await this.$connect();
    const rows = await this.$queryRaw<Array<{ unsafe: boolean }>>`
      SELECT (rolsuper OR rolbypassrls OR EXISTS (
        SELECT 1 FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
        WHERE n.nspname = 'public' AND c.relkind = 'r' AND c.relowner = r.oid
      )) AS unsafe FROM pg_roles r WHERE rolname = current_user`;
    if (rows.length !== 1 || rows[0].unsafe) {
      await this.$disconnect();
      throw new Error('Runtime database role must be non-owner, non-superuser and NOBYPASSRLS');
    }
  }

  async onModuleDestroy(): Promise<void> {
    await this.$disconnect();
  }

  async withTenant<T>(
    tenantId: string,
    fn: (tx: Prisma.TransactionClient) => Promise<T>,
  ): Promise<T> {
    return this.$transaction(async (tx: Prisma.TransactionClient) => {
      // Parameterized: $queryRaw with a bound parameter, not interpolation.
      await tx.$queryRaw`SELECT set_config('app.tenant_id', ${tenantId}, true)`;
      return fn(tx);
    });
  }

  /**
   * Same as withTenant(), but the whole callback runs in ONE
   * transaction at REPEATABLE READ isolation: every statement sees
   * the same snapshot, so a report response never mixes two
   * snapshots during concurrent writes. The tenant context is set
   * on the same transaction/connection, parameterized as above.
   * PostgreSQL's now() is constant inside the transaction, so a
   * `SELECT now()` in the callback labels the snapshot exactly.
   * PGlite accepts the explicit isolation level (see the Phase 7
   * check in scripts/test-database.mjs); no fallback is in use.
   */
  async withTenantSnapshot<T>(
    tenantId: string,
    fn: (tx: Prisma.TransactionClient) => Promise<T>,
  ): Promise<T> {
    return this.$transaction(
      async (tx: Prisma.TransactionClient) => {
        await tx.$queryRaw`SELECT set_config('app.tenant_id', ${tenantId}, true)`;
        return fn(tx);
      },
      { isolationLevel: 'RepeatableRead' },
    );
  }
}
