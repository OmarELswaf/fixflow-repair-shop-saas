# PWA — FixFlow Phase 2

Status: **untested**. No PWA or speed verification is claimed.
All of it must be verified by the parent in a real browser / build.

## What the PWA is

- Manifest: `apps/web/public/manifest.webmanifest`
  (name FixFlow, lang `ar`, dir `rtl`, standalone, theme `#0f3d2e`).
- Icons: deterministic PNGs generated locally with PIL
  (`public/icons/icon-192.png`, `icon-512.png`) plus an SVG source
  (`public/icons/icon.svg`). No AI generation, no copied branding.
- Service worker: hand-written `apps/web/public/sw.js`. No
  vite-plugin-pwa, no Workbox, no new dependency.
- Offline shell: `apps/web/public/offline.html`.

## Service worker behaviour

- Precaches / version-caches the static shell and static assets
  ONLY, under a versioned cache name (`fixflow-shell-v1`).
- **Explicit allowlist** (Phase 3): only the exact paths `/`,
  `/offline.html`, `/manifest.webmanifest`,
  `/icons/icon-192.png`, `/icons/icon-512.png`, `/icons/icon.svg`,
  plus hashed build output under `/assets/` ending in `.js`,
  `.css`, `.woff` or `.woff2`. The old extension-based rule (any
  `.png/.svg/.webp` anywhere) was too broad and is gone. Arbitrary
  images, `/api`, invoices, customer photos and uploads are never
  cached. The same rule is in `apps/web/src/pwa/pwa.ts`
  (`shouldCache`, `STATIC_ALLOWLIST`) and is unit-tested; the
  worker is the hand-written copy and must stay in sync with it.
- Navigation requests: network first, fall back to
  `offline.html` when the network fails.
- Updates: a new worker installs in the background and does NOT
  activate silently. The app shows a real “Update available”
  prompt; only after the user confirms does it call
  `skipWaiting` + reload. See `src/pwa/pwa.ts` update-flow logic.

## No silent offline mutations

There is **no offline mutation queue**. Offline, the app shows a
real offline indicator (based on `navigator.onLine` and
online/offline events) and refuses payment / stock actions
instead of queuing them silently. This is deliberate: a payment
or stock mutation queued offline could double-apply, apply to
the wrong tenant/branch, or apply after a price or stock change.
Any future offline queue would need idempotency keys, tenant
re-resolution on reconnect, and explicit user confirmation —
none of which is in Phase 2.

## After logout / tenant switch

- The static shell is tenant-agnostic and contains no tenant
  data, so **no shell purge is needed** on logout or tenant switch.
- In-memory tenant state is cleared, and TanStack Query caches
  are cleared (see `src/api/client.ts` / `App.tsx` logout handling
  — the query client is invalidated and cleared on switch).
- Because API responses are never cached by the service worker,
  a switched tenant cannot see the previous tenant's data from
  cache.
- The service worker must be unregistered / cleared on logout
  **only if a future version ever caches tenant data** — currently
  it does not, so logout does not unregister it. If a future
  version adds any tenant-data caching, that decision must be
  revisited and the logout path must clear it.

## Registration

The service worker is registered only in production builds
(`import.meta.env.PROD` in `App.tsx`). It is not registered in
development, so dev reloads are not masked by a stale shell.
