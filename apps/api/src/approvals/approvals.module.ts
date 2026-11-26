import { MiddlewareConsumer, Module, NestModule } from '@nestjs/common';
import { PrismaModule } from '../prisma/prisma.module';
import { AuthModule } from '../auth/auth.module';
import { ApprovalsPublicController, ApprovalsStaffController } from './approvals.controller';
import { ApprovalsRateLimitMiddleware } from './approvals-rate-limit';
import { ApprovalsService } from './approvals.service';

@Module({
  imports: [PrismaModule, AuthModule],
  controllers: [ApprovalsStaffController, ApprovalsPublicController],
  providers: [ApprovalsService],
  exports: [ApprovalsService],
})
export class ApprovalsModule implements NestModule {
  configure(consumer: MiddlewareConsumer): void {
    consumer.apply(ApprovalsRateLimitMiddleware).forRoutes(ApprovalsPublicController);
  }
}
