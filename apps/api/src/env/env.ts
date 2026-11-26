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
  /** Brevo (free tier) transactional email over HTTPS. Both needed to send reset emails. */
  BREVO_API_KEY: z.string().optional(),
  MAIL_FROM: z.string().optional(),
  MAIL_FROM_NAME: z.string().default('FixFlow'),
  /** Public base URL used in reset links. Falls back to the first WEB_ORIGINS entry. */
  PUBLIC_APP_URL: z.string().optional(),
  WHATSAPP_ENABLED: z.string().default('false'),
  EMAIL_ENABLED: z.string().default('false'),
  AI_ENABLED: z.string().default('false'),
  PAYMENT_PROVIDER_ENABLED: z.string().default('false'),
});

function isPlaceholder(value: string | undefined): boolean {
  return !value || value.includes('CHANGE_ME');
}

/**
 * Entropy floor for production JWT secrets: 32 bytes of entropy, not
 * merely 32 characters. 43+ chars covers 32 random bytes in base64
 * (43 chars) or hex (64 chars). 10+ distinct characters rejects
 * padded words and repeated-character patterns while never refusing
 * genuinely random hex/base64 output.
 */
function hasEnoughEntropy(value: string): boolean {
  return value.length >= 43 && new Set(value).size >= 10;
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
  for (const key of ['JWT_ACCESS_SECRET', 'JWT_REFRESH_SECRET'] as const) {
    if (!hasEnoughEntropy(parsed.data[key])) {
      throw new Error(
        `Production ${key} must carry at least 32 bytes of entropy ` +
          '(e.g. `openssl rand -hex 32` or `openssl rand -base64 32`).',
      );
    }
  }
}

export const env = parsed.data;
export type Env = typeof env;
