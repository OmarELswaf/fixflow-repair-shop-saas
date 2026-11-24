# Auth — FixFlow Phase 3 + Phase 4 workstream A

Prisma generation,
API builds and both actual HTTP harnesses ran successfully in the reviewed
checkpoint. Earlier phase notes describe historical builder limitations.

## What exists

- **Passwords:** Argon2id (`argon2` 0.45.2, memoryCost 19456,
  timeCost 2, parallelism 1). Minimum length 12. Passwords are
  never logged or returned. See `apps/api/src/auth/password.ts`.
- **Access tokens:** short-lived JWTs, 15 minutes by default
  (`JWT_ACCESS_TTL_SECONDS`, default 900). Claims: `sub` (user id),
  `email`, `tenantId` (null until a tenant is selected).
  Secret: `JWT_ACCESS_SECRET` (validated in `env.ts`; production
  refuses placeholder values).
- **Refresh tokens:** opaque random 32-byte tokens. Only their
  sha256 hash is stored, in `refresh_sessions`. Lifetime 7 days by
  default (`JWT_REFRESH_TTL_DAYS`). Refresh tokens are NOT JWTs —
  `JWT_REFRESH_SECRET` is therefore not used for signing in Phase 3;
  it remains a required env var for a future JWT-refresh option.
- **Rotation + reuse detection:** each refresh rotates to a new
  token in the SAME family; the old session is revoked and linked
  to the new one (`replacedById`). Presenting an already-revoked /
  replaced token is treated as theft: the whole family is revoked
  and an `auth.refresh.reuse_detected` audit entry is written.
  See `apps/api/src/auth/refresh-sessions.ts` (pure, unit-tested).
- **Logout:** `POST /auth/logout` revokes one refresh session;
  `POST /auth/logout-all` revokes all of the user's sessions.
- **Owner registration:** `POST /auth/register` creates, in ONE
  transaction, a User, a Tenant, an initial Branch, an owner
  Membership (branch scope = that branch), and an audit entry.
  The tenant id is generated client-side so it can be set as the
  RLS tenant context before inserting tenant-scoped rows.
  Duplicate email → 409. Returns access + refresh tokens scoped
  to the new tenant.
- **Login:** `POST /auth/login`. Wrong password / unknown email
  return the same generic 401 (no user enumeration). One
  membership → tokens scoped to that tenant. Several memberships
  → an unscoped access token and `requiresTenantSelection: true`;
  no refresh token is issued until a tenant is selected via
  `POST /auth/select-tenant`, which checks the tenant is one of
  the user's memberships (a non-member tenant → 403).
- **Tenant switching (Phase 8):** scoped tokens are bound to
  (user, tenant) and do not follow a switch; logout revokes one
  refresh family only. See `docs/TENANCY.md` "Scoped tokens and
  tenant switching (Phase 8)". Covered by
  `scripts/test-auth-http.mjs`.
- **Guards:** `JwtAuthGuard` validates the access JWT, loads
  memberships from the database, and attaches `req.user` and
  `req.tenantContext`. A `tenantId` in the token that is not a
  membership is rejected. `TenantGuard` (`@RequirePermission`,
  `@RequireBranch`) checks permissions and branch scope on the
  resolved context. `GET /auth/me` is the protected example route.
- **Permissions:** `ROLE_PERMISSIONS` in
  `apps/api/src/tenancy/permissions.ts` maps each membership role
  to its permissions (owner gets all). `RolePermission` rows are
  the future per-role override store, not the live check.

## Endpoints

| Method | Path                      | Auth                   | Purpose                                      |
| ------ | ------------------------- | ---------------------- | -------------------------------------------- |
| POST   | `/api/auth/register`      | public                 | Owner registration + initial branch          |
| POST   | `/api/auth/login`         | public                 | Login (scoped tokens, or selection required) |
| POST   | `/api/auth/refresh`       | public (refresh token) | Rotate refresh token                         |
| POST   | `/api/auth/select-tenant` | access token           | Pick a tenant, get scoped tokens             |
| POST   | `/api/auth/logout`        | public (refresh token) | Revoke one refresh session                   |
| POST   | `/api/auth/logout-all`    | access token           | Revoke all refresh sessions                  |
| GET    | `/api/auth/me`            | access token + tenant  | Current user, memberships, tenant context    |

## Browser token design

Two token channels exist, and the client type decides which one it
uses. The rules are the same for both: the refresh token rotates
on every use, and reuse kills the family.

- **Access token:** short-lived JWT, delivered in JSON only
  (`tokens.accessToken`). The web UI keeps it **in memory only**
  (a module-level variable / React state). It is never written to
  `localStorage`, `sessionStorage`, a cookie, or the URL.
- **Refresh token, browser flow:** delivered as an HttpOnly cookie
  only, not in browser JSON. Cookie: name `ff_refresh`, `HttpOnly`,
  `SameSite=Lax`, `Path=/api/auth`, `Max-Age` = refresh TTL in
  seconds (7 days by default), `Secure` only when
  `NODE_ENV=production` (so plain-HTTP local development works).
  The cookie is set on register, login, refresh (rotation sets
  the new value) and select-tenant, and cleared (`Max-Age=0`) on
  logout and logout-all. Helpers: `apps/api/src/auth/cookies.ts`
  (`parseCookies`, `refreshCookieHeader`,
  `clearRefreshCookieHeader`).
- **Refresh token, non-browser flow:** only requests without Origin,
  Referer or cookies also receive refresh tokens in JSON. API clients
  can send the JSON
  `tokens.refreshToken` in the request body. The controller
  resolves the token **cookie-first, else body** (`/auth/refresh`
  and `/auth/logout`), so both flows work against the same
  endpoints.
- **The web UI never reads or stores the JSON refresh token.**
  It relies on the cookie (sent automatically by the browser)
  plus the in-memory access token. It must not copy
  `tokens.refreshToken` into any storage.
- **Why HttpOnly + SameSite=Lax:** the cookie cannot be read by
  JavaScript (XSS cannot steal it), and Lax means it is not sent
  on cross-site POSTs from a top-level navigation… in practice
  Lax still sends the cookie on top-level GET navigations, which
  is why the CSRF Origin check below exists as a second line of
  defence for cookie-authenticated mutations.

## CSRF

Cookie-authenticated requests carry an ambient credential, so a
malicious site could otherwise trigger them cross-origin. The
defence is layered:

1. `SameSite=Lax` on the `ff_refresh` cookie (see above).
2. **Origin check:** GET/HEAD/OPTIONS pass through. Every auth mutation
   rejects a supplied Origin outside WEB_ORIGINS, including login/register
   without a prior cookie. A mutation with a refresh cookie requires an
   allowed Origin or Referer. Non-browser JSON-token requests without
   cookies or Origin can proceed. Matching is exact, with no wildcard.
3. Pure function `isAllowedOrigin(origin, allowedOrigins)` is
   unit-tested (`origin-check.spec.ts`); the middleware is wired
   in `AuthModule.configure()`.

## Rate limits

Hand-written sliding-window limiter
(`apps/api/src/auth/rate-limit.ts`, `createRateLimiter`), no new
dependency. Wired in `AuthModule.configure()` via
`AuthRateLimitMiddleware`. Exact limits:

| Route                 | Limit                | Key                   |
| --------------------- | -------------------- | --------------------- |
| POST `/auth/login`    | 5 attempts / 15 min  | IP + normalized email |
| POST `/auth/login`    | 20 attempts / 15 min | IP                    |
| POST `/auth/register` | 5 attempts / hour    | IP                    |
| POST `/auth/refresh`  | 30 attempts / min    | IP                    |

The unauthenticated public shop page is limited separately, not
by this middleware: GET `/api/public/shops/:slug` is 100 requests
/ min per IP (see `docs/PUBLIC_PROFILE.md` "Rate limiting" and
`apps/api/src/public-profile/public-shop-rate-limit.ts`).

Exceeding a limit returns 429 with a `Retry-After` header (seconds
until the oldest attempt in the window expires) and JSON
`{ statusCode: 429, message: 'Too many requests.' }`. The limiter
is **in-memory only, per process** — it is not distributed. With
several API instances each enforces its own budget, so the
effective limit is `max × instances`. A multi-instance deployment
must move this to Redis before relying on the limits. Unit tests:
`rate-limit.spec.ts` (window expiry, per-key isolation, 429
boundary at the middleware).

## Bootstrap reads (RLS)

Login and refresh happen BEFORE any tenant is known, so two
lookups cannot use the tenant policy:

- `memberships`: login lists a user's memberships by `userId`.
- `refresh_sessions`: refresh looks a session up by its token
  hash (a 256-bit secret — the lookup key IS the credential).

Migration 0004 supersedes the broad no-tenant bootstrap policies from 0003. Membership bootstrap reads use transaction-local `app.auth_user_id`.
Refresh reads use transaction-local token-hash, session-id or user-id
context. Runtime uses a non-owner, non-superuser NOBYPASSRLS role.
Users remain a platform table without RLS; tenant tables retain RLS.

## Gaps — NOT implemented, NOT faked

- **Email verification:** `User.emailVerifiedAt` stays NULL on
  registration. No verification email is sent and no verification
  endpoint exists. Do not present an account as verified.
- **Password reset:** no reset endpoint, no reset email, no reset
  token. A user who forgets a password has no self-service path
  in Phase 3.
- **Billing onboarding:** registration does NOT create a
  subscription or plan version. SaaS billing onboarding is a
  later phase; a registered tenant has no subscription row.
- **Entitlements in TenantContext:** `entitlements` is `[]` until
  subscriptions exist. Permission checks work; quota checks do not
  exist yet.
- **External adapters:** WhatsApp, email, AI and payment-provider
  adapters remain disabled (`*_ENABLED=false`). Nothing in auth
  sends a message or email.
