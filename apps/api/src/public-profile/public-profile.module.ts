import { MiddlewareConsumer, Module, NestModule } from '@nestjs/common';
import { PublicProfileController } from './public-profile.controller';
import { PublicShopController } from './public-shop.controller';
import { PublicShopRateLimitMiddleware } from './public-shop-rate-limit';
import { PublicProfileService } from './public-profile.service';
import { PrismaModule } from '../prisma/prisma.module';
import { AuthModule } from '../auth/auth.module';

@Module({
  imports: [PrismaModule, AuthModule],
  controllers: [PublicProfileController, PublicShopController],
  providers: [PublicProfileService],
  exports: [PublicProfileService],
})
export class PublicProfileModule implements NestModule {
  configure(consumer: MiddlewareConsumer): void {
    // Per-IP rate limiting on the unauthenticated public shop page
    // only (100/min per IP, in-memory per process — see
    // public-shop-rate-limit.ts and docs/PUBLIC_PROFILE.md
    // "Rate limiting" for the memory bound and the multi-instance
    // limit). Scoped to PublicShopController: the owner settings
    // endpoints in this module are NOT rate-limited here.
    consumer.apply(PublicShopRateLimitMiddleware).forRoutes(PublicShopController);
  }
}
