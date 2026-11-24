# Per-tenant public profile / landing page (Phase 10)

Every shop gets its own public landing page at `/s/:slug`. This
document is the design, data-model and security plan, and the record
of what is implemented. Status: implemented locally, not deployed,
not published anywhere. Default: unpublished/disabled.

## What it is

An owner may configure a small public profile for their shop — name,
description, logo, a theme accent, a list of services, contact
details and opening hours — and publish it at a unique public
address. Visitors see only that profile. Nothing else about the
shop is public.

## Data model

`tenant_public_profiles` (migration 0009; Prisma model
`TenantPublicProfile`):

| Column                                  | Notes                                                                                             |
| --------------------------------------- | ------------------------------------------------------------------------------------------------- |
| `tenantId` (PK, FK → `tenants.id`)      | One profile per tenant.                                                                           |
| `slug` (unique)                         | Lowercase letters/digits/hyphens, 3–64 chars, no leading/trailing hyphen. Reserved words blocked. |
| `published` (default `false`)           | The page is invisible until the owner publishes it.                                               |
| `displayName`, `description`, `logoUrl` | Nullable plain text / https image URL.                                                            |
| `theme` (default `'green'`)             | One of `green`, `gold`, `teal`, `slate` (DB CHECK). No arbitrary CSS.                             |
| `services`, `contact`, `hours`          | Nullable JSONB, validated by zod on write, re-validated on the public read.                       |
| `createdAt`, `updatedAt`                | Server timestamps. Never exposed publicly.                                                        |

No backfill: no profile row exists until the owner creates one via
`PUT /api/tenants/me/public-profile`. `GET` on the settings endpoint
is 404 until then. Nothing is ever copied from private operational
data (no shop name from registration, no branch names, no customer
or repair data) — the owner types every public field explicitly.

`services` is an array of at most 20 `{ name, description? }`.
`contact` is `{ phone?, whatsapp?, email?, address?, website? }`.
`hours` is `{ sat?, sun?, mon?, tue?, wed?, thu?, fri? }` where each
day is `null` (explicitly closed) or `{ open: "HH:MM", close:
"HH:MM" }` (24-hour, close after open). A day that is absent means
"not specified" and is omitted from the public page — it is not
presented as closed. No free-form HTML anywhere.

## The public-vs-private boundary

The public endpoint `GET /api/public/shops/:slug` returns exactly
these eight fields, and only when `published` is true:

`slug`, `displayName`, `description`, `logoUrl`, `theme`,
`services`, `contact`, `hours`.

It never returns `tenantId`, timestamps, or anything else. It never
queries customers, repairs, staff, inventory, branches, invoices or
subscriptions, so none of that data can leak through it — there is
no code path from the public endpoint to a private table. Unpublished
and unknown slugs are both 404: the endpoint never says which one
it was.

Enforcement is layered, not a single check:

1. **RLS.** `tenant_public_profiles` has `tenant_isolation` (owner
   operations, inside `withTenant`) plus a narrow `public_published_read`
   policy (`FOR SELECT USING (published = true)`). The public
   endpoint runs with no tenant context, so without the published
   policy no row is visible at all; unpublished rows are invisible
   to it by default-deny. The table is deliberately RLS-enabled —
   unlike the platform tables (`tenants`, `users`, `plans`), which
   are server-code-only — because the public read must be safe even
   if server code has a bug.
2. **Explicit projection.** The service builds the response field by
   field with a `select` allow-list; the row is never spread.
3. **Re-validation on read.** The three JSON columns are re-validated
   against their zod schemas on the public read; malformed stored
   content is dropped to `null` instead of served.
4. **Slug uniqueness in the database.** RLS can hide another
   tenant's unpublished slug from the service, so the service does
   not rely on a pre-check: a duplicate slug surfaces as a unique
   violation (P2002) mapped to 409.
5. **Owner endpoints are tenant-scoped.** `GET`/`PUT
/api/tenants/me/public-profile` require the `admin` permission
   (owner-only; the admin role does not hold it) and run inside
   `withTenant` with an explicit `tenantId` filter. An owner can
   only ever read or write their own tenant's profile.

## Validation rules (write path)

Implemented in `apps/api/src/public-profile/dto.ts` (zod, `.strict()`):

- **Plain text:** `<` and `>` are rejected with 400 in every free-text
  field. Nothing is stripped silently; no HTML or script is stored.
  React also escapes text on render (defense in depth).
- **URLs:** must be `https://`. `javascript:` and `data:` URLs are
  rejected by the scheme check.
- **Logo:** https URL ending in `.png`, `.jpg`, `.jpeg`, `.webp` or
  `.gif` (optional query string). Any host is fine. No `.svg` (kept
  out to avoid any ambiguity). The web page renders it in an `<img>`
  with an `onerror` fallback, never as injected markup.
- **Website:** https URL. **Email:** valid email format.
  **Phone/whatsapp:** digits, spaces, `+`, `-`, `()` only, 3–30 chars.
- **Slug:** 3–64 chars, lowercase letters/digits/hyphens, no leading
  or trailing hyphen; uppercase is rejected, not lowercased.
  Reserved: `admin`, `api`, `login`, `auth`, `app`, `fixflow`,
  `support`, `settings`, `dashboard`, `shop`, `shops`, `public`.
- **Services:** at most 20 items, each name 1–100 chars, description
  1–300 chars.
- **Hours:** each day `null` or `{ open, close }` in `HH:MM`
  24-hour format with close after open.
- **Publishing requires a display name**, so an empty page can never
  go live by accident.
- **PUT is a full replace.** Omitted optional fields are cleared
  (stored as NULL). `slug` is always required; `published` defaults
  to `false`; `theme` defaults to `'green'`.

## Owner settings UI

`/settings/public-profile` in the app (owner-only nav item, `admin`
permission). The owner edits every field, toggles publish/unpublish,
and sees a **preview** of the saved profile with a clear
"preview — not published" banner while unpublished. The preview
renders the owner's own saved profile — never invented content. A
field that is empty is omitted from the preview rather than filled
in. The public page itself (`/s/:slug`) has no app navigation and
no auth: it renders the same view with a small "public page" label.

### Settings validation and accessibility (Phase 11)

The settings form validates inline before saving, mirroring the
server rules in `apps/api/src/public-profile/dto.ts` (same slug
pattern and reserved words, https/image checks, phone shape, hours
order, publish-requires-a-display-name). The server still validates
on write — the inline checks are guidance, not the boundary. A
failed submit shows a summary alert and an inline message on each
invalid field, wired through the field's helper text (MUI sets
`aria-invalid` and `aria-describedby` from it), and focus moves to
the first invalid field in display order. The save button is no
longer disabled for an empty slug: a disabled button gives no
feedback, so the empty slug is reported the same inline way.

International values render left-to-right: the phone, WhatsApp,
email, website and logo-URL inputs carry `dir="ltr"` (plus
`inputMode`/`autoComplete`), and the public view renders every
contact value inside `<bdi>` with `dir="ltr"` on the link, so a
leading `+` or a long URL cannot reorder the surrounding Arabic
text. Long display names, descriptions, service names and URLs use
`overflowWrap: 'anywhere'` and are never silently truncated — the
full value stays visible and accessible. The settings and public
pages have no horizontal overflow at 320px (the public page is
asserted at 320px in `scripts/review-ui-check.mjs`).

The shell hides the "Public page" nav item from non-owners, and
the settings route itself shows a no-access message (the API
enforces it too). Tenant/account form isolation is preserved by
the reviewed Phase 10 fix — the shell keys the routed outlet on
the tenant id, so unsaved values cannot carry across a tenant
switch — and is covered by a regression test in
`Shell.test.tsx`. Publish/unpublish, default-unpublished, and the
loading/error states of both pages are covered by
`PublicProfileSettingsPage.test.tsx` and
`PublicShopPage.test.tsx`.

## Rate limiting (Phase 11)

`GET /api/public/shops/:slug` is unauthenticated, so it is rate
limited per IP: **100 requests per minute per IP** (60-second
sliding window), enforced by `PublicShopRateLimitMiddleware`
(`apps/api/src/public-profile/public-shop-rate-limit.ts`), wired in
`PublicProfileModule.configure()` and scoped to the public
controller only — the owner settings endpoints are not limited by
it. The middleware reuses the existing `createRateLimiter` helper
from `apps/api/src/auth/rate-limit.ts` (no new limiter built, no new
dependency). The constants are `PUBLIC_SHOP_WINDOW_MS` (60,000 ms)
and `PUBLIC_SHOP_MAX_PER_IP` (100) in that helper file. The budget
is generous on purpose: a human visitor loads the page once, and
even repeated refreshes stay far below 100/min, while the limit
still bounds scraping at 6,000 requests/hour per IP.

Exceeding the limit returns **429** with a `Retry-After` header
(seconds until the oldest attempt in the window expires) and JSON
`{ statusCode: 429, message: 'Too many requests.' }`, the same
shape as the auth limiter. The limit counts every request to the
endpoint, including 404s for unpublished/unknown slugs and 400s
for malformed slugs — the middleware runs before the controller,
so an attacker cannot dodge the budget by requesting unknown slugs.

**Memory is bounded.** `createRateLimiter` keeps one timestamp
array per IP key, sweeps expired entries at most once per window,
and hard-caps the map at **10,000 keys**: a new key past the cap is
denied (fail-closed) instead of growing the map. The bound is per
limiter instance; the public-shop middleware owns its own instance.

**Multi-instance limit — read this before scaling.** The limiter
is **in-memory and per process**: it is NOT distributed. With
several API instances (or several workers) each instance enforces
its own 100/min budget, so the effective limit is `100 ×
instances` — it is **not a global limit**. A multi-instance
deployment that needs a global limit must move this to a shared
store (e.g. Redis, a shared token bucket). That integration is
deliberately NOT built here: no Redis client, no shared-store code,
no deployment change. A single-instance deployment is covered as
is.

## What is NOT included

- **No customer / repair / staff / inventory data** on the public
  page, in any form. No counts, no lists, no "recent repairs".
- **No metrics, no testimonials, no invented hours, contact details
  or services.** Every public field is owner-entered or omitted.
- **No public repair-status lookup.** See the proposal below —
  plan only, no endpoint, no repair-ID or phone search.
- **No dark mode, no custom CSS themes.** The theme is one accent
  colour from a fixed set of four.
- **No SEO/social meta, no custom domain.** The page is served at
  the app's own `/s/:slug` route. A custom domain would need DNS
  and hosting decisions that are out of scope.

## Public repair-status lookup — proposal only (NOT implemented)

Omar did not request this. It is recorded here as a privacy-reviewed
optional design, not built: no endpoint, no UI, no repair-ID or
customer-phone search exists.

If it is ever wanted, the shape would have to be:

- **Lookup key:** something the customer already has that is not
  guessable and not personal data in the URL — e.g. a random
  per-repair public token printed on the receipt (not the repair ID,
  not the phone number). Phone-number search is rejected: phone
  numbers are enumerable and would let anyone probe whether a
  number is a customer.
- **Response:** status label only (and at most a coarse progress
  step). No customer name, no phone, no device serial, no price, no
  notes, no history, no branch internals.
- **Abuse controls:** per-IP rate limiting, a constant-time
  not-found response (unknown token and real token must be
  indistinguishable in timing and status), and no listing or
  enumeration endpoint.
- **Opt-in per repair, owner-controlled**, default off. A token must
  be revocable (regenerating it invalidates the old one).
- **Risks to decide first:** status labels leak business state
  (e.g. `awaiting_approval` tells a stranger a repair is stuck);
  a leaked receipt photo exposes the token; support load from
  customers misreading statuses. Until those are decided, the
  lookup stays a proposal.

## Tests

- `apps/api/src/public-profile/dto.spec.ts` — pure validation tests
  (16 cases): valid profile, minimal profile, uppercase/short/
  hyphen-edge slugs, every reserved slug, `javascript:`/`data:`/
  non-image logo URLs, image URL with query string, HTML in text,
  oversized values, >20 services, bad website/email, bad hours,
  publish-requires-name, unknown fields, slug-param shape.
- `scripts/test-public-profile-http.mjs` — HTTP harness (reviewer-run;
  needs the generated client + built API): anonymous GET of a
  published profile returns exactly the eight public fields;
  unpublished → 404; unknown slug → 404; cross-tenant isolation
  (tenant B's profile and private data never appear under tenant A);
  owner-only settings (non-owner 403, unauthenticated 401);
  validation 400s; duplicate slug 409; and a tenant with customers,
  repairs, staff and inventory whose public response contains none
  of that data. **Rate limiting (Phase 11, same harness, last
  section):** the six earlier public GETs in the harness already
  consumed budget from the single loopback IP, so 94 more GETs of
  the re-published page return 200 and the next is 429 with a
  `Retry-After` header of 1–60 seconds and the standard 429 body; a
  further GET in the same window is still 429. The window-reset
  behaviour itself is unit-tested with a fake clock (see below),
  not by waiting 60 seconds in the harness; the `Retry-After`
  bound (≤ 60 s) is asserted in the harness as the observable
  window evidence. The under-limit 200 and the unpublished/unknown
  404s are the harness's earlier cases — they run under the limit
  and prove the limiter does not break normal reads.
- `apps/api/src/public-profile/public-shop-rate-limit.spec.ts` —
  unit tests for the limiter (5 cases, no generated client needed):
  100 GETs allowed per IP then 429 with `Retry-After` 1–60 s and
  the standard 429 body; per-IP isolation; non-GET passthrough;
  window sliding (attempts expire after the configured 60 s window,
  tested with a fake clock via `createRateLimiter`); fail-closed
  10,000-key store cap.
- `scripts/test-database.mjs` — Phase 10 checks (12): table columns,
  RLS enabled, both policies present, slug unique index, theme CHECK,
  theme violation rejected, duplicate slug rejected, published rows
  visible without a tenant context, unpublished rows invisible
  without one, tenant 'c' seeing its own unpublished row, cross-
  tenant write rejected, duplicate slug rejected under RLS.
- `apps/web/src/components/PublicShopView.test.tsx` — the shared
  public view: renders a fixture profile, omits empty fields, logo
  `onerror` fallback, closed vs not-specified hours.

## Files

- `apps/api/prisma/migrations/0009_public_profile/migration.sql`
- `apps/api/prisma/schema.prisma` (`TenantPublicProfile`, `Tenant.publicProfile`)
- `apps/api/src/public-profile/` — `dto.ts`, `dto.spec.ts`,
  `public-profile.service.ts`, `public-profile.controller.ts`
  (owner settings), `public-shop.controller.ts` (public projection),
  `public-shop-rate-limit.ts` (Phase 11: per-IP limiter middleware),
  `public-shop-rate-limit.spec.ts` (Phase 11: unit tests),
  `public-profile.module.ts` (Phase 11: middleware wired in
  `configure()`)
- `apps/api/src/auth/rate-limit.ts` (Phase 11: `PUBLIC_SHOP_WINDOW_MS`
  / `PUBLIC_SHOP_MAX_PER_IP` constants)
- `apps/api/src/app.module.ts` (module registered)
- `scripts/test-public-profile-http.mjs`, `scripts/test-database.mjs`
  (Phase 10 checks), `package.json` (`test:public-profile:http`)
- `apps/web/src/api/client.ts` (types + `fetchOwnPublicProfile`,
  `saveOwnPublicProfile`, `fetchPublicShop`)
- `apps/web/src/components/PublicShopView.tsx` (+ test),
  `apps/web/src/pages/PublicShopPage.tsx`,
  `apps/web/src/pages/PublicProfileSettingsPage.tsx`
- `apps/web/src/App.tsx` (`/s/:slug` + `settings/public-profile`
  routes), `apps/web/src/pages/Shell.tsx` (owner-only nav item),
  `apps/web/src/i18n.ts` (Arabic + English strings)
