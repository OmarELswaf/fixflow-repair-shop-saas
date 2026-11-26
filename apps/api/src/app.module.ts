import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { HealthController } from './health/health.controller';
import { PrismaModule } from './prisma/prisma.module';
import { AuthModule } from './auth/auth.module';
import { CustomersModule } from './customers/customers.module';
import { RepairsModule } from './repairs/repairs.module';
import { InventoryModule } from './inventory/inventory.module';
import { ReportsModule } from './reports/reports.module';
import { AdminModule } from './admin/admin.module';
import { PublicProfileModule } from './public-profile/public-profile.module';
import { ApprovalsModule } from './approvals/approvals.module';
import { TrackingModule } from './tracking/tracking.module';
import { QueueModule } from './queue/queue.module';

@Module({
  imports: [
    ConfigModule.forRoot({ isGlobal: true }),
    PrismaModule,
    AuthModule,
    CustomersModule,
    RepairsModule,
    InventoryModule,
    ReportsModule,
    AdminModule,
    PublicProfileModule,
    TrackingModule,
    ApprovalsModule,
    QueueModule,
  ],
  controllers: [HealthController],
})
export class AppModule {}
