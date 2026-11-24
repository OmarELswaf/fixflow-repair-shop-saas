import { z } from 'zod';

/**
 * Public-profile DTOs (Phase 10). `.strict()` rejects unknown fields.
 *
 * Validation policy (see docs/PUBLIC_PROFILE.md):
 * - All free text is plain text: `<` and `>` are rejected with 400.
 *   Nothing is stripped silently, and no HTML or script is ever stored.
 * - URLs must be `https://`. `javascript:` and `data:` URLs are
 *   rejected by the scheme check, not by a blocklist.
 * - The logo must look like an image URL: https + an image extension
 *   (`.png`, `.jpg`, `.jpeg`, `.webp`, `.gif`, optional query string).
 *   No allow-listed hosts: any host is fine as long as the URL ends
 *   in a known image extension.
 * - Slugs are lowercase letters/digits/hyphens, 3–64 chars, and must
 *   not start or end with a hyphen. Reserved words are blocked.
 *   Uppercase slugs are rejected, not lowercased: the owner sees the
 *   error and picks a valid slug.
 * - Publishing requires a display name, so an empty page can never
 *   go live by accident.
 */

export const PUBLIC_PROFILE_THEMES = ['green', 'gold', 'teal', 'slate'] as const;
export type PublicProfileTheme = (typeof PUBLIC_PROFILE_THEMES)[number];

/** Words that must never become a public slug. */
export const RESERVED_SLUGS = [
  'admin',
  'api',
  'login',
  'auth',
  'app',
  'fixflow',
  'support',
  'settings',
  'dashboard',
  'shop',
  'shops',
  'public',
] as const;

/** Plain text: no markup. Reject, never strip. */
const plainText = (min: number, max: number) =>
  z
    .string()
    .trim()
    .min(min)
    .max(max)
    .refine((s) => !/[<>]/.test(s), 'Text must not contain < or >.');
/** Slug: lowercase letters/digits/hyphens, 3–64 chars, no leading or trailing hyphen. */
export const slugSchema = z
  .string()
  .trim()
  .min(3)
  .max(64)
  .regex(
    /^[a-z0-9]([a-z0-9-]{1,62}[a-z0-9])?$/,
    'Slug must be 3–64 lowercase letters, digits or hyphens, and must not start or end with a hyphen.',
  )
  .refine((s) => !(RESERVED_SLUGS as readonly string[]).includes(s), 'This address is reserved.');
/** Slug shape only (public path param): reserved words simply never match a row, so they 404. */
export const slugParamSchema = z
  .string()
  .trim()
  .min(3)
  .max(64)
  .regex(
    /^[a-z0-9]([a-z0-9-]{1,62}[a-z0-9])?$/,
    'Slug must be 3–64 lowercase letters, digits or hyphens, and must not start or end with a hyphen.',
  );
/** Params for GET /api/public/shops/:slug (object form, so parse() infers the shape). */
export const PublicShopParamsSchema = z.object({ slug: slugParamSchema }).strict();
function isSafeHttpsUrl(value: string): boolean {
  try {
    const url = new URL(value);
    return url.protocol === 'https:' && Boolean(url.hostname) && !url.username && !url.password;
  } catch {
    return false;
  }
}
const imageUrlSchema = z
  .string()
  .trim()
  .max(500)
  .regex(
    /^https:\/\/[^\s]+?\.(png|jpg|jpeg|webp|gif)(\?[^\s]*)?$/i,
    'Logo must be an https image URL ending in .png, .jpg, .jpeg, .webp or .gif.',
  )
  .refine(isSafeHttpsUrl, 'A valid https URL without embedded credentials is required.');
const websiteSchema = z
  .string()
  .trim()
  .max(500)
  .regex(/^https:\/\/[^\s/$.?#].[^\s]*$/, 'Website must be an https URL.')
  .refine(isSafeHttpsUrl, 'A valid https URL without embedded credentials is required.');
const phoneSchema = z
  .string()
  .trim()
  .min(3)
  .max(30)
  .regex(/^[+0-9][0-9\s\-()]*$/, 'Phone must contain only digits, spaces, +, - or ().');

const timeOfDay = z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/, 'Time must be HH:MM (24-hour).');
const dayHoursSchema = z
  .object({ open: timeOfDay, close: timeOfDay })
  .strict()
  .refine((d) => d.open < d.close, 'Closing time must be after opening time.');

const serviceItemSchema = z
  .object({
    name: plainText(1, 100),
    description: plainText(1, 300).optional(),
  })
  .strict();

const contactSchema = z
  .object({
    phone: phoneSchema.optional(),
    whatsapp: phoneSchema.optional(),
    email: z.string().trim().max(200).email().optional(),
    address: plainText(1, 300).optional(),
    website: websiteSchema.optional(),
  })
  .strict();

const hoursSchema = z
  .object({
    sat: dayHoursSchema.nullable().optional(),
    sun: dayHoursSchema.nullable().optional(),
    mon: dayHoursSchema.nullable().optional(),
    tue: dayHoursSchema.nullable().optional(),
    wed: dayHoursSchema.nullable().optional(),
    thu: dayHoursSchema.nullable().optional(),
    fri: dayHoursSchema.nullable().optional(),
  })
  .strict();

export const PublicProfileServicesSchema = z
  .array(serviceItemSchema)
  .max(20, 'At most 20 services.');
export const PublicProfileContactSchema = contactSchema;
export const PublicProfileHoursSchema = hoursSchema;

/**
 * PUT /api/tenants/me/public-profile — a FULL replace of the profile.
 * Omitted optional fields are cleared (stored as NULL). `slug` is
 * always required; `published` defaults to false when omitted.
 */
export const UpsertPublicProfileDto = z
  .object({
    slug: slugSchema,
    displayName: plainText(1, 100).optional(),
    description: plainText(1, 1000).optional(),
    logoUrl: imageUrlSchema.optional(),
    theme: z.enum(PUBLIC_PROFILE_THEMES).optional(),
    services: PublicProfileServicesSchema.optional(),
    contact: PublicProfileContactSchema.optional(),
    hours: PublicProfileHoursSchema.optional(),
    published: z.boolean().optional(),
  })
  .strict()
  .refine((d) => !d.published || (d.displayName !== undefined && d.displayName.length > 0), {
    message: 'A display name is required to publish.',
  });

export type UpsertPublicProfileInput = z.infer<typeof UpsertPublicProfileDto>;
export type PublicProfileServiceItem = z.infer<typeof serviceItemSchema>;
export type PublicProfileContact = z.infer<typeof contactSchema>;
export type PublicProfileHours = z.infer<typeof hoursSchema>;
