# FixFlow design system (Phase 10 — mobile-first Arabic RTL redesign)

This document records the visual design system introduced in Phase 10,
how the navigation and pages are structured, what the dashboard is allowed
to show, and what was deliberately not done. It is the reference for the
BEFORE/AFTER screenshot workflow in `scripts/review-ui-check.mjs`.

## Principles

- **RTL-first, Arabic primary.** The app is Arabic-first with an English
  adaptation. Layout uses MUI's built-in RTL support and logical
  properties; dates and numbers use the existing bidi-safe `DateTime`
  component (`apps/web/src/components/DateTime.tsx`) — no new date
  formatting was invented. Arabic labels with embedded numbers/dates must
  render with `<bdi>` isolation where they already did.
- **Contemporary polished SaaS, not decoration.** Clean type scale,
  generous line-height, soft surfaces (1px borders, soft shadows,
  generous radius), one primary accent used sparingly. No heavy images,
  no large new assets, no font downloads — the system font stack, so
  Arabic renders well offline.
- **Touch targets ≥ 44px** for every interactive element (buttons 44px
  min-height, icon buttons 44×44, bottom navigation 64px, list item
  buttons 48px min-height). Filter chips are 40px tall (they are not
  primary actions; the 44px rule applies to buttons and links).
- **Contrast is WCAG AA** for body text and chips. Status is never colour
  alone: every status chip carries its text label.
- **Restrained motion.** Small, fast transitions only; a
  `prefers-reduced-motion` media query zeroes transitions and animations.
- **Dark mode: not implemented.** Deliberately skipped — it is not worth
  it at the expense of the core mobile redesign. Revisit only if it can be
  fully tested without weakening the mobile work.

## Tokens (`apps/web/src/theme.ts`)

- Primary (deep green): `#0d3b2e`, light tint `#dcebe2`. Used for the
  brand, active navigation state, primary buttons and links.
- Secondary (gold): `#b98a1d`, used sparingly (accents only).
- Background `#f4f6f3`, paper `#ffffff`, text primary `#182420`,
  text secondary `#54655c`.
- Success / warning / error / info sets are AA-contrast pairs (dark text
  on a light tint) and are shared by chips and alerts.
- Type scale: h1 1.75rem/700 down to caption 0.75rem, body line-height
  1.7. Shape radius 12 (cards 16). Buttons: `textTransform: none`,
  min-height 44px.

## Status chips (`apps/web/src/components/StatusChip.tsx`)

`RepairStatusChip` and `PartLineStatusChip` render the label as text plus
a tinted background, one colour per status (all AA-contrast):

- Repair: received slate, diagnosing indigo, awaiting_approval amber,
  awaiting_parts orange, in_repair blue, quality_check violet, ready
  green, delivered teal, cancelled grey, unrepairable red.
- Part line: reserved amber, consumed green, released grey.

Card links (repair cards, customer cards) carry an explicit `aria-label`
equal to the order ID / customer name, so a screen reader and the browser
review script get a clean link name instead of the whole card's text.
The visible label is contained in the accessible name (WCAG label-in-name).

## Navigation (`apps/web/src/pages/Shell.tsx`)

- **Mobile (< md breakpoint):** one sticky top row — menu button, shop
  name, language text button. Fixed bottom navigation with the 5 primary
  destinations (Home, Repairs, Customers, Stock if `inventory:read`,
  Reports if `report:read`). A temporary drawer (RTL-aware anchor: right
  in Arabic, left in English) holds all destinations, shop context, the
  tenant-switch link, language and logout. The shell never wraps or
  overflows at 320px.
- **Desktop (≥ md):** permanent 272px sidebar with brand/shop context,
  nav list with icons and a selected state, tenant-switch / language /
  logout at the bottom. Active route is marked with `aria-current="page"`
  and the selected state.
- The Phase 9 tenant-switch control is preserved (drawer on mobile,
  sidebar on desktop). The pending-ops banner logic is untouched; only
  its container context changed. PWA service worker / caching rules are
  untouched.

## Pages

- **Dashboard (`HomePage.tsx`)** — shop name as h1, role/branch subtitle.
  Quick-action cards link to real flows only: New repair, New customer,
  Adjust stock (only with `inventory:write`), View reports (only with
  `report:read`). Repairs summary: total, open
  (total − delivered − cancelled − unrepairable), needs attention
  (awaiting_approval + awaiting_parts only — a single count, no
  double-counting), over 30 days; status chips with counts link to
  `/repairs?status=…`; each summary carries an "as of" snapshot label.
  Stock section: the 5 stock-overview stats plus a mismatched-rows
  warning and an "as of" label. Latest repairs as cards with status chips.
  Server health is shown only as a warning alert on error.
  Data sources (all existing endpoints, no fabricated metrics):
  `fetchRepairsSummary({})`, `fetchStockOverview({ limit: 1 })`,
  `listRepairs({ limit: 6 })` (ordered newest first by the API),
  `fetchHealth`. If a datum is not available from the API, it is not shown.
- **Repairs list (`RepairsPage.tsx`)** — repair cards (order ID, branch,
  received date, status chip). Status filter chips on their own
  horizontally scrollable row (All + 10 statuses, `aria-pressed`), branch
  select on the next row. The list API has no text-search parameter, so no
  fake search box was added — the chips are the real server filter.
  The new-repair form stays inline below the list.
  - **Filters live in the URL (Phase 11).** The status and branch
    filters are derived from `useSearchParams` (`/repairs?status=…`,
    `/repairs?branchId=…`), and changing a filter writes it back to
    the URL with `replace`. Reading the param once on mount used to
    leave the filter stale when a dashboard chip or the bottom
    navigation changed the route without remounting the page; the
    list, the chips and the address bar now agree in both directions
    (regression test in `RepairsPage.test.tsx`, browser check in
    `scripts/review-ui-check.mjs`).
  - **Card identifiers (Phase 11).** The list endpoint returns the
    repair rows only — no customer name and no device brand/model
    (those are joined only by the detail endpoint, and no backend
    change is in scope). The cards therefore show what the list
    actually returns: the order ID (the stable identifier, also the
    link's accessible name), the problem description when present,
    branch and received date. No customer or device name is shown,
    because inventing one would be fake data. The same applies to
    the dashboard's latest-repairs cards.
- **Repair detail (`RepairDetailPage.tsx`)** — separate section cards:
  Summary (order ID, status chip, received date, branch), Customer &
  device (customer name links to the customer page, phone, device,
  assigned technician), Workflow & actions (assign form, transitions,
  note), Parts (lines as cards with part-line status chips and
  release/consume buttons; reserve form), History (timeline), Receipt
  (print button). All logic, labels and permissions unchanged.
- **Reports (`ReportsPage.tsx`)** — filters collapsed in an Accordion by
  default; repairs summary as a stat tile + by-status rows + aging rows +
  an "as of" label; stock as 5 stat tiles + an "as of" label + the
  multi-page snapshot disclosure kept verbatim; stock rows as mobile
  cards + desktop table (dual layout, as before).
- **Other pages** — Customers / Parts lists as cards; Stock keeps its
  single table (no mobile-card duplication, so the exact-text test counts
  are preserved); Team keeps its dual layout; Customer detail, Login,
  Register, Select tenant and Status are wrapped in the shared
  `PageContainer` / `SectionCard` (`apps/web/src/components/SectionCard.tsx`).
  The language toggle keeps `aria-label="language-toggle"`.

## Loading / empty / error states

Every page shows a loading spinner, an explicit empty state, or an error
alert — no blank screens and no raw errors. Forms keep their labels and
44px targets.

## What was deliberately NOT done

- No dark mode (see above).
- No charts (there are no charts; the dashboard shows counts, not graphs).
- No repairs text search — the API has no search parameter; adding a box
  that filters only the loaded page would be fake.
- No fabricated revenue, growth or other metrics on the dashboard.
- No new dependencies, no new framework, no webfont downloads, no chart
  libraries. Icons come from the already-installed `@mui/icons-material`.

## BEFORE/AFTER screenshot workflow

`scripts/review-ui-check.mjs` contains a "MATCHED BEFORE/AFTER
screenshots" section (fixture-driven and deterministic): dashboard,
repairs list, repair detail and reports at 390px; dashboard and repair
detail at 320px; dashboard and reports at desktop 1280px; plus the mobile
drawer when the build has one. Each shot waits for the same stable
heading/text and asserts no horizontal overflow at that width.

1. On the Phase 9 build: `SHOT_TAG=before npm run test:ui:review`
   (the script builds the current tree first, then runs the browser
   checks; it needs real Chrome at `/usr/bin/google-chrome`).
2. On the redesigned build: `SHOT_TAG=after npm run test:ui:review`
   (or omit `SHOT_TAG`; `after` is the default).
3. Compare the matched pairs in `/downloads/fixflow-matched-*-before.png`
   vs `/downloads/fixflow-matched-*-after.png`.

The fixture is identical in both runs (one shop, one customer/device/part,
one repair with a consumed and a released part line, stock adjusted to 10
then 2 consumed). Report "as of" timestamps and repair dates differ
between runs by design — compare layout, hierarchy, navigation and
density, not pixels. The drawer shot is skipped on builds without the new
mobile menu button; every other matched shot exists on both builds.
