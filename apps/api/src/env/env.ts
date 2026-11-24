import { z } from 'zod';

const EnvSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  PORT: z.coerce.number().int().min(1).max(65535).default(3000),
  DATABASE_URL: z.string().min(1),
  REDIS_URL: z.string().min(1).default('redis://localhost:6379'),
  JWT_ACCESS_SECRET: z.string().min(16),
  JWT_REFRESH_SECRET: z.string().min(16),
  JWT_ACCESS_TTL_SECONDS: z.coerce.number().int().positive().default(900),
  JWT_REFRESH_TTL_DAYS: z.coerce.number().int().positive().default(7),
  /** Comma-separated allowlist for the cookie CSRF/Origin check. */
  WEB_ORIGINS: z.string().default('http://localhost:5173'),
  /** 'false' disables POST /auth/register (public demo). Default true. */
  REGISTRATION_ENABLED: z.string().default('true'),
  /** Directory of the built web app; when set the API also serves it (single-origin hosting). */
  WEB_DIST_DIR: z.string().optional(),
  WHATSAPP_ENABLED: z.string().default('false'),
  EMAIL_ENABLED: z.string().default('false'),
  AI_ENABLED: z.string().default('false'),
  PAYMENT_PROVIDER_ENABLED: z.string().default('false'),
});

function isPlaceholder(value: string | undefined): boolean {
  return !value || value.includes('CHANGE_ME');
}

const parsed = EnvSchema.safeParse(process.env);
if (!parsed.success) {
  throw new Error(`Invalid environment: ${parsed.error.message}`);
}
if (parsed.data.NODE_ENV === 'production') {
  for (const key of ['JWT_ACCESS_SECRET', 'JWT_REFRESH_SECRET', 'DATABASE_URL'] as const) {
    if (isPlaceholder(parsed.data[key])) {
      throw new Error(`Production requires a real value for ${key}, not a placeholder.`);
    }
  }
}

export const env = parsed.data;
export type Env = typeof env;
