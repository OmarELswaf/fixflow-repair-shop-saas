import { existsSync } from 'node:fs';
import { join } from 'node:path';
import express from 'express';
import { NestFactory } from '@nestjs/core';
import { ValidationPipe } from '@nestjs/common';
import { AppModule } from './app.module';
import { env } from './env/env';

async function bootstrap(): Promise<void> {
  const app = await NestFactory.create(AppModule);
  app.setGlobalPrefix('api');
  app.useGlobalPipes(new ValidationPipe({ whitelist: true, forbidNonWhitelisted: true }));
  // Helmet-like headers without adding a new dependency.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  app.use((_req: any, res: any, next: any) => {
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('X-Frame-Options', 'DENY');
    res.setHeader('Referrer-Policy', 'no-referrer');
    next();
  });
  // Behind Render's proxy: trust one hop so rate limits see the client IP.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (app.getHttpAdapter().getInstance() as any).set('trust proxy', 1);
  // Single-origin hosting: serve the built web app and fall back to
  // index.html for client routes. API routes stay under /api.
  if (env.WEB_DIST_DIR && existsSync(join(env.WEB_DIST_DIR, 'index.html'))) {
    const dist = env.WEB_DIST_DIR;
    app.use(express.static(dist, { index: false, maxAge: '1h' }));
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    app.use((req: any, res: any, next: any) => {
      if (req.method !== 'GET' || req.path.startsWith('/api/')) return next();
      res.sendFile(join(dist, 'index.html'));
    });
  }
  await app.listen(env.PORT, '0.0.0.0');
}
// eslint-disable-next-line no-console
bootstrap().catch((e: unknown) => {
  console.error(e);
  process.exitCode = 1;
});
