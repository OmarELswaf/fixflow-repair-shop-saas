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
  // CSP violation reports (Report-Only rollout). Log-only, small body,
  // lightly rate-limited per IP so a flood cannot fill the logs.
  const cspHits = new Map<string, { count: number; resetAt: number }>();
  app.use(
    '/api/csp-report',
    express.json({ limit: '8kb', type: ['application/csp-report', 'application/json'] }),
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (req: any, res: any) => {
      const now = Date.now();
      const key = String(req.ip ?? 'unknown');
      const bucket = cspHits.get(key);
      const state = bucket && bucket.resetAt > now ? bucket : { count: 0, resetAt: now + 60_000 };
      state.count += 1;
      cspHits.set(key, state);
      if (state.count > 30) {
        res.status(429).end();
        return;
      }
      const report = JSON.stringify(req.body ?? {}).slice(0, 1000);
      // eslint-disable-next-line no-console
      console.warn(`csp-report: ${report}`);
      res.status(204).end();
    },
  );
  // Single-origin hosting: serve the built web app and fall back to
  // index.html for client routes. API routes stay under /api.
  if (env.WEB_DIST_DIR && existsSync(join(env.WEB_DIST_DIR, 'index.html'))) {
    const dist = env.WEB_DIST_DIR;
    // Report-Only CSP on the SPA document: browsers report violations
    // to /api/csp-report without blocking anything. Promote to an
    // enforcing Content-Security-Policy after the reports are clean.
    // The header rides the actual frontend response (the index.html
    // document), not just API responses.
    const csp = [
      "default-src 'self'",
      "script-src 'self'",
      "style-src 'self' 'unsafe-inline'",
      "img-src 'self' data:",
      "font-src 'self' data:",
      "connect-src 'self'",
      "object-src 'none'",
      "base-uri 'self'",
      "form-action 'self'",
      "frame-ancestors 'none'",
      'report-uri /api/csp-report',
    ].join('; ');
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    app.use((req: any, res: any, next: any) => {
      if (req.method === 'GET' && !req.path.startsWith('/api/')) {
        res.setHeader('Content-Security-Policy-Report-Only', csp);
      }
      next();
    });
    app.use(express.static(dist, { index: false, maxAge: '1h' }));
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    app.use((req: any, res: any, next: any) => {
      if (req.method !== 'GET' || req.path.startsWith('/api/')) return next();
      res.sendFile(join(dist, 'index.html'));
    });
  }
  await app.listen(env.PORT, '0.0.0.0');
  // Demo hosting: Render's free tier sleeps after 15 min without inbound
  // traffic. Pinging our own public URL counts as traffic and keeps it awake.
  const selfUrl = process.env.RENDER_EXTERNAL_URL;
  if (selfUrl && process.env.KEEP_ALIVE !== 'false') {
    setInterval(
      () => {
        fetch(`${selfUrl}/api/health`).catch(() => undefined);
      },
      10 * 60 * 1000,
    ).unref();
  }
}
// eslint-disable-next-line no-console
bootstrap().catch((e: unknown) => {
  console.error(e);
  process.exitCode = 1;
});
