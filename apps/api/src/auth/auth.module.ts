import { MiddlewareConsumer, Module, NestModule } from '@nestjs/common';
import { JwtModule } from '@nestjs/jwt';
import { AuthController } from './auth.controller';
import { PasswordResetController } from './password-reset.controller';
import { AuthService } from './auth.service';
import { PrismaAuthDb, PrismaRefreshSessionStore } from './prisma-auth.db';
import { Argon2PasswordHasher } from './password';
import { JwtAuthGuard } from './jwt-auth.guard';
import { TenantGuard } from './tenant.guard';
import { AUTH_DB, AUTH_OPTIONS, PASSWORD_HASHER, REFRESH_SESSION_STORE } from './ports';
import { AuthRateLimitMiddleware } from './rate-limit';
import { CookieOriginMiddleware, parseWebOrigins, WEB_ORIGINS } from './origin-check';
import { env } from '../env/env';
import { PrismaModule } from '../prisma/prisma.module';

/**
 * Phase 3 auth module. Refresh tokens are opaque random strings whose
 * sha256 hashes are stored in refresh_sessions — they are NOT JWTs, so
 * JWT_REFRESH_SECRET is not used for signing in Phase 3 (it remains a
 * required env var for a future JWT-refresh option; see docs/AUTH.md).
 */
@Module({
  imports: [
    PrismaModule,
    JwtModule.register({
      secret: env.JWT_ACCESS_SECRET,
      signOptions: {
        expiresIn: env.JWT_ACCESS_TTL_SECONDS,
        algorithm: 'HS256',
        issuer: 'fixflow',
        audience: 'fixflow-api',
      },
      verifyOptions: { algorithms: ['HS256'], issuer: 'fixflow', audience: 'fixflow-api' },
    }),
  ],
  controllers: [AuthController, PasswordResetController],
  providers: [
    AuthService,
    JwtAuthGuard,
    TenantGuard,
    { provide: AUTH_DB, useClass: PrismaAuthDb },
    { provide: PASSWORD_HASHER, useClass: Argon2PasswordHasher },
    { provide: REFRESH_SESSION_STORE, useClass: PrismaRefreshSessionStore },
    {
      provide: AUTH_OPTIONS,
      useValue: {
        accessTtlSeconds: env.JWT_ACCESS_TTL_SECONDS,
        refreshTtlDays: env.JWT_REFRESH_TTL_DAYS,
      },
    },
    { provide: WEB_ORIGINS, useValue: parseWebOrigins(env.WEB_ORIGINS) },
  ],
  exports: [AuthService, JwtAuthGuard, TenantGuard, JwtModule, AUTH_DB],
})
export class AuthModule implements NestModule {
  configure(consumer: MiddlewareConsumer): void {
    // Rate limiting first, then the cookie Origin check. Both are
    // scoped to the auth controller; each middleware decides by path
    // whether it applies (see rate-limit.ts and origin-check.ts).
    consumer.apply(AuthRateLimitMiddleware, CookieOriginMiddleware).forRoutes(AuthController);
  }
}
