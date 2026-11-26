import { MiddlewareConsumer, Module, NestModule } from '@nestjs/common';
import { PrismaModule } from '../prisma/prisma.module';
import { AuthModule } from '../auth/auth.module';
import { TrackingPublicController, TrackingStaffController } from './tracking.controller';
import { TrackingRateLimitMiddleware } from './tracking-rate-limit';
import { TrackingService } from './tracking.service';

@Module({
  imports: [PrismaModule, AuthModule],
  controllers: [TrackingStaffController, TrackingPublicController],
  providers: [TrackingService],
})
export class TrackingModule implements NestModule {
  configure(consumer: MiddlewareConsumer): void {
    consumer.apply(TrackingRateLimitMiddleware).forRoutes(TrackingPublicController);
  }
}
