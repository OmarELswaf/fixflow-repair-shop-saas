# Performance — FixFlow Phase 2

Status: **targets to measure, not claims**. Nothing below has
been measured. All budgets are untested until the parent runs
them in a real browser / build.

## Budgets (targets)

- Initial JS (web, production build, gzipped, per route):
  target ≤ 200 KB for the initial route chunk. Lazy routes are
  excluded from the initial chunk by design (React.lazy).
- Total production build size: target ≤ 1.5 MB uncompressed
  `dist/` assets, excluding source maps. Measure with
  `npm run build` output and `du -sh apps/web/dist`.
- LCP (home route, local production build, desktop): target
  ≤ 2.5 s. Mobile / throttled targets must be set separately
  before any claim.
- Service worker: static shell must load offline from cache;
  no `/api` response may be served from cache (see PWA tests).
- No budget is a guarantee. A budget that is missed is a
  finding, not a reason to edit the budget.

## How to measure

- Vite build output: `npm run build --workspace=@fixflow/web`
  and read the chunk sizes it prints. Compare the initial
  chunk against the 200 KB gzipped target.
- Lighthouse in a real browser: run against the production
  build served locally, not the Vite dev server. Record LCP,
  total JS, and PWA checks. Do not report Lighthouse numbers
  from a dev server as production numbers.
- Playwright: `apps/web/e2e/pwa.spec.ts` covers manifest,
  service-worker registration, offline shell, and no `/api`
  caching. It requires a real browser / build and is labelled
  as such in the file.

## What is NOT claimed

No speed, LCP, bundle-size, or PWA verification is claimed in
this delivery. The parent must run the tests and record the
measured numbers before any performance statement is made.
