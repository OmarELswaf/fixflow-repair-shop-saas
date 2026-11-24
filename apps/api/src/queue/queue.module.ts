import { Module } from '@nestjs/common';
import { Queue } from 'bullmq';
import IORedis from 'ioredis';

export interface TenantJobPayload {
  tenantId: string;
  branchId?: string;
  type: string;
  data: Record<string, unknown>;
}

/** BullMQ queue. Every job payload carries tenant_id; workers must re-resolve the tenant. No real jobs in Phase 2. */
@Module({
  providers: [
    {
      provide: 'REDIS_CONNECTION',
      useFactory: () =>
        new IORedis(process.env.REDIS_URL ?? 'redis://localhost:6379', {
          maxRetriesPerRequest: null,
        }),
    },
    {
      provide: 'FIXFLOW_QUEUE',
      useFactory: (connection: IORedis) => new Queue<TenantJobPayload>('fixflow', { connection }),
      inject: ['REDIS_CONNECTION'],
    },
  ],
  exports: ['FIXFLOW_QUEUE', 'REDIS_CONNECTION'],
})
export class QueueModule {}
