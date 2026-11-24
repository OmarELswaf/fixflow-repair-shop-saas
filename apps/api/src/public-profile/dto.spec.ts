import { UpsertPublicProfileDto, slugParamSchema } from './dto';

/**
 * Pure validation tests for the public-profile DTOs. No database, no
 * generated Prisma client — these run in this VM (`npm run test:api`).
 * The HTTP harness (scripts/test-public-profile-http.mjs) proves the
 * same rules end-to-end against the real API.
 */
describe('UpsertPublicProfileDto', () => {
  const valid = {
    slug: 'al-noor-repair',
    displayName: 'Al Noor Repair',
    description: 'Phone and laptop repair.',
    logoUrl: 'https://example.com/logo.png',
    theme: 'green' as const,
    services: [{ name: 'Screen replacement', description: 'Same-day.' }],
    contact: { phone: '+20 100 000 0000', website: 'https://example.com' },
    hours: { sat: { open: '09:00', close: '18:00' }, fri: null },
    published: true,
  };

  it('accepts a complete valid profile', () => {
    expect(UpsertPublicProfileDto.safeParse(valid).success).toBe(true);
  });

  it('accepts a minimal profile (slug only, unpublished by default)', () => {
    const parsed = UpsertPublicProfileDto.safeParse({ slug: 'my-shop' });
    expect(parsed.success).toBe(true);
    if (parsed.success) {
      expect(parsed.data.published).toBeUndefined();
      expect(parsed.data.theme).toBeUndefined();
    }
  });

  it('rejects an uppercase slug', () => {
    expect(UpsertPublicProfileDto.safeParse({ ...valid, slug: 'My-Shop' }).success).toBe(false);
  });

  it('rejects a slug that is too short or starts/ends with a hyphen', () => {
    expect(UpsertPublicProfileDto.safeParse({ ...valid, slug: 'ab' }).success).toBe(false);
    expect(UpsertPublicProfileDto.safeParse({ ...valid, slug: '-shop' }).success).toBe(false);
    expect(UpsertPublicProfileDto.safeParse({ ...valid, slug: 'shop-' }).success).toBe(false);
  });

  it('rejects every reserved slug', () => {
    for (const slug of [
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
    ]) {
      expect(UpsertPublicProfileDto.safeParse({ ...valid, slug }).success).toBe(false);
    }
  });

  it('rejects javascript: and data: logo URLs and non-image URLs', () => {
    expect(
      UpsertPublicProfileDto.safeParse({ ...valid, logoUrl: 'javascript:alert(1)' }).success,
    ).toBe(false);
    expect(
      UpsertPublicProfileDto.safeParse({ ...valid, logoUrl: 'data:image/png;base64,aaaa' }).success,
    ).toBe(false);
    expect(
      UpsertPublicProfileDto.safeParse({ ...valid, logoUrl: 'http://example.com/logo.png' })
        .success,
    ).toBe(false);
    expect(
      UpsertPublicProfileDto.safeParse({ ...valid, logoUrl: 'https://example.com/image' }).success,
    ).toBe(false);
  });

  it('accepts an image URL with a query string and an uppercase extension', () => {
    expect(
      UpsertPublicProfileDto.safeParse({ ...valid, logoUrl: 'https://cdn.example.com/l.PNG?v=2' })
        .success,
    ).toBe(true);
  });

  it('rejects HTML in description and display name', () => {
    expect(UpsertPublicProfileDto.safeParse({ ...valid, description: '<b>bold</b>' }).success).toBe(
      false,
    );
    expect(
      UpsertPublicProfileDto.safeParse({ ...valid, displayName: 'Shop <script>' }).success,
    ).toBe(false);
  });

  it('rejects oversized values', () => {
    expect(
      UpsertPublicProfileDto.safeParse({ ...valid, displayName: 'x'.repeat(101) }).success,
    ).toBe(false);
    expect(
      UpsertPublicProfileDto.safeParse({ ...valid, description: 'x'.repeat(1001) }).success,
    ).toBe(false);
  });

  it('rejects more than 20 services', () => {
    const services = Array.from({ length: 21 }, (_, i) => ({ name: `Service ${i}` }));
    expect(UpsertPublicProfileDto.safeParse({ ...valid, services }).success).toBe(false);
  });

  it('rejects a bad website scheme and a bad email', () => {
    expect(
      UpsertPublicProfileDto.safeParse({
        ...valid,
        contact: { website: 'javascript:alert(1)' },
      }).success,
    ).toBe(false);
    expect(
      UpsertPublicProfileDto.safeParse({ ...valid, contact: { email: 'not-an-email' } }).success,
    ).toBe(false);
  });

  it('rejects a closing time before the opening time and a bad time format', () => {
    expect(
      UpsertPublicProfileDto.safeParse({
        ...valid,
        hours: { sat: { open: '18:00', close: '09:00' } },
      }).success,
    ).toBe(false);
    expect(
      UpsertPublicProfileDto.safeParse({
        ...valid,
        hours: { sat: { open: '9:00', close: '18:00' } },
      }).success,
    ).toBe(false);
  });

  it('requires a display name to publish', () => {
    expect(UpsertPublicProfileDto.safeParse({ slug: 'my-shop', published: true }).success).toBe(
      false,
    );
    expect(UpsertPublicProfileDto.safeParse({ slug: 'my-shop', published: false }).success).toBe(
      true,
    );
  });

  it('rejects unknown fields', () => {
    expect(
      UpsertPublicProfileDto.safeParse({ ...valid, customers: [{ name: 'Sara' }] }).success,
    ).toBe(false);
  });
});

it('rejects malformed HTTPS URLs and embedded URL credentials', () => {
  for (const field of ['logoUrl', 'contact'] as const) {
    const value =
      field === 'logoUrl'
        ? { logoUrl: 'https://user:pass@example.com/logo.png' }
        : { contact: { website: 'https://user:pass@example.com' } };
    expect(UpsertPublicProfileDto.safeParse({ slug: 'safe-shop', ...value }).success).toBe(false);
  }
});

describe('slugParamSchema', () => {
  it('accepts a well-formed slug and rejects a malformed one', () => {
    expect(slugParamSchema.safeParse('al-noor-repair').success).toBe(true);
    expect(slugParamSchema.safeParse('Bad_Slug').success).toBe(false);
  });

  it('does not block reserved words (they simply never match a row, so they 404)', () => {
    expect(slugParamSchema.safeParse('admin').success).toBe(true);
  });
});
