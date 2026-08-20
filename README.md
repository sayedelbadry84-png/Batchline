# Batchline

Ready-mix concrete plant operations platform. Design spec: see the published
Batchline artifact from this project's planning session for the full system
design (all 12 modules, business rules, integrations, RBAC, rollout plan).

This codebase covers all 12 modules from the original system scope, across
**Phase 1 (Foundation)**, **Phase 2 (Production + Fleet)**, **Phase 3
(Quality & Compliance + driver mobile app)**, **Phase 4 (Pumps + integration
webhooks + Reports/KPIs)**, **Phase 5 (real authentication + RBAC
enforcement, and Arabic/RTL localization)**, and **Material Receiving**
(built out of sequence to close a gap in the original module list) — a real
database, real CRUD, and the batching physics (yield factor, tolerance,
drum timer, return policy, plant KPIs) actually computing from live data,
not placeholders.

## Stack

- Next.js 16 (App Router, Server Actions). Back-office pages live in the
  `src/app/(app)` route group (sidebar layout); the driver app
  (`src/app/driver`) is a separate route tree with its own minimal layout —
  they share only the root `layout.tsx` (fonts, HTML shell).
- Prisma 5 ORM, SQLite for local dev (swap the datasource to PostgreSQL for
  production — one line in `prisma/schema.prisma` plus `DATABASE_URL`)
- Tailwind CSS v4
- Oswald / IBM Plex Sans / IBM Plex Mono, matching the Batchline design system

## Getting started

```bash
npm install
npx prisma db push      # create/sync the local SQLite database
npx prisma db seed      # load a demo plant, mix design, customer, project, fleet
npm run dev
```

Open [http://localhost:3000](http://localhost:3000) and sign in — the seed
prints a list of demo accounts (one per role) to the console, all with
password `batchline123`. A `DRIVER`-role login lands on the phone-first
driver app (`/driver`) automatically instead of the back office.

> Windows + PowerShell: if `npm run dev` fails with "running scripts is
> disabled on this system", either run it from Command Prompt instead, or
> run `Set-ExecutionPolicy -Scope CurrentUser -ExecutionPolicy RemoteSigned`
> once in a regular PowerShell window.

## What's implemented

**Phase 1 — Foundation**
- **Plants** — registry, currency/timezone, plus batching tolerance and
  alert-threshold configuration (drum timer limit, return absorption
  threshold)
- **Silos** — live level tracking, low-threshold alert surfaced on both the
  Silos screen and the dashboard
- **Mix Design** — recipe library with a component editor; design volume is
  computed from real specific-gravity data via the absolute-volume method
  (ACI 211.1 style)
- **Suppliers** — vendor master + material catalog (specific gravity,
  absorption — feeds the Mix Design and moisture-correction calculations)
- **Customers, Projects, Employees, Reservations** — CRUD with the credit-hold
  rule from the design spec

**Phase 2 — Production + Fleet**
- **Production** — release a confirmed reservation as a batch ticket (targets
  snapshotted from the mix design, scaled to the requested volume); record
  actual scale weights and aggregate moisture readings; out-of-tolerance
  components are flagged automatically against each material's configured
  tolerance
- Completing a batch **deducts real mass from the matching silo/hopper
  inventory** — the same numbers the Silos screen and dashboard alerts read
- **Fleet** — truck registry (drum capacity, agitation spec, GPS device ID,
  status) and the driver roster
- **Trips** — live trip board with a real-time drum-rotation timer against
  the plant's configured limit; status flow from loading through discharge;
  closing with a return applies the design spec's return & discount policy
  (no charge under the absorption threshold, partial credit above it, full
  waste past the drum-timer window)

**Phase 3 — Quality & Compliance + driver mobile app**
- **Test Batches & Lab Results** — sample a trip (slump, air content, temp),
  record cylinder breaks at any age, pass/fail computed against the target
  strength; every result traces back through its trip to a specific truck,
  driver, and batch ticket
- **Compliance Certificates** — per mix design, with an expiry warning chip
  inside 60 days and an expired flag past it
- **Driver mobile app** (`/driver`) — a phone-first surface with no
  back-office chrome: logging in as a `DRIVER`-role account resolves your
  own assigned trips (via a real `User → Employee` link, not a picker), with
  a live drum-timer countdown, status advance through the delivery, photo
  capture, and a signed-by confirmation — closes full or with a return
  through the same policy logic as the dispatcher trip board. Every driver
  action checks the trip actually belongs to your own Employee record.
- **Audit trail** — every write across all three phases logs
  actor/role/module/record/reason to `AuditEvent`

**Phase 4 — Pumps, integration webhooks, Reports & KPIs**
- **Pumps** — pump registry (boom/line/stationary, reach, hourly + standby
  rate) and a booking calendar that schedules a pump against a reservation
- **Integration webhooks** — `POST /api/telematics/ping` (GPS provider →
  truck location, identified by `gpsDeviceId`) and `POST
  /api/scada/silo-reading` (sensor-fed silo level, distinct from the manual
  dashboard override) — real endpoints, tested directly with `curl`, not
  mocked UI. Results surface on the Fleet and Silos screens (last position,
  "sensor 9:47 PM" vs "no sensor feed").
- **Reports & KPIs** (`/reports`) — daily/7-day production volume, average
  batch deviation, cylinder pass rate, slump conformance, return rate,
  average truck cycle time, and silo days-of-cover, all computed live from
  the same tables every other screen writes to. Verified against
  hand-calculated expected values. Revenue/cost/AR metrics are deliberately
  absent — see below.

**Material Receiving**
- Weighbridge-style capture (gross/tare weight, net computed — never entered
  directly) against a supplier PO, with a variance-vs-PO flag beyond ±2%
- A QC gate: a receipt sits at `PENDING` until Quality passes, holds, or
  rejects it — **nothing reaches silo or hopper inventory until QC passes
  it**, mirroring the same posting pattern as completing a production batch

**Phase 5 — Authentication & RBAC**
- Real login: `bcryptjs`-hashed passwords, database-backed sessions
  (`Session` table + an `httpOnly` cookie — no external auth library). Any
  route under the back-office `(app)` group or the driver app redirects to
  `/login` without a valid, unexpired session.
- Sidebar navigation is filtered by role so a user only sees the modules
  their role can act on (not itself a security boundary — see below).
- Sensitive Server Actions enforce their role server-side via a
  `requireRole()` guard, independent of what the UI shows: mix design
  approval (Quality/Admin), completing a production batch (Plant
  Operator/Admin), Material Receiving QC pass/hold/reject
  (Quality/Admin), all three Quality actions, plant tolerance
  configuration (Plant Operator/Admin), and employee creation (Admin only).
  Verified directly: logged in as Accountant, navigated straight to a Mix
  Design URL the nav hides, and had the approval attempt correctly rejected
  server-side with "Role ACCOUNTANT is not permitted..." — not just hidden
  in the UI.
- The audit trail now records the *real* actor: `logAudit` pulls
  actor id/name/role from the session automatically (previously every call
  site had to pass a role string by hand, which meant "who did this" wasn't
  actually verified — only asserted per call site).
- **Page-level read authorization**, not just action gating: `src/lib/permissions.ts`
  is a single `MODULE_ROLES` map that both the sidebar (hides links) and
  every page (`requirePageAccess()`, redirecting to `/access-denied`)
  enforce — one source of truth, so the menu can't drift from what's
  actually allowed. Closes the gap an earlier version of this README called
  out: an Accountant navigating straight to a Mix Design URL the sidebar
  hides now gets redirected to `/access-denied` instead of being able to
  view (only not act on) the page.

**Arabic/RTL localization**
- Arabic is the **default locale** on first visit (no cookie set), per the
  system design spec — not a token toggle bolted onto an English-only app.
  A `batchline_locale` cookie persists the choice; a switcher on the login
  page, the back-office sidebar, and the driver app flips between `ar`/`en`
  without leaving the page.
- `<html lang dir>` is set server-side from the cookie on every request
  (`src/app/layout.tsx`), so RTL/LTR is correct on first paint — no
  client-side flash of the wrong direction.
- Typography: IBM Plex Sans (Latin) and its official IBM Plex Sans Arabic
  companion sit in the *same* font-family stack, so Arabic and Latin glyphs
  both render correctly in one string — a batch ticket mixing Arabic labels
  with Latin-numeral measurements (e.g. "7 m³") doesn't need a script
  switch, matching how these tickets actually look in practice.
- Fully localized as one complete, verified slice: login, the back-office
  sidebar/nav, the dashboard, and the entire driver app (trip list, trip
  detail, delivery confirmation) — including the directional details, not
  just text: the sidebar's active-link indicator and its border against the
  main content use logical properties (`border-s-2`, `border-e`) so they
  land on the correct side automatically, table headers use `text-start`,
  and the driver app's back arrow flips (`←`/`→`) with direction. Verified
  live: logged in as a driver, switched to Arabic, and completed a full
  delivery confirmation — RTL layout, Arabic labels, and the Arabic
  signed-by name (`م. أحمد سمير`) all the way through to the database.
- One real bug found and fixed along the way: the dictionary object holds
  formatter functions for a few messages (e.g. `delivered(m3) => "Delivered
  ${m3} m³"`, since the volume has to be interpolated) — passing the *whole*
  dictionary as a prop
  to the Sidebar (a Client Component) crashed, because React can't
  serialize functions across that boundary, even ones the component never
  reads. Fixed by passing only the plain-string slices (`nav`, `common`)
  each Client Component actually needs.

## Not yet implemented (see the rollout plan)

Arabic/RTL covers the highest-traffic surfaces (login, nav, dashboard,
driver app) as a complete, tested slice — the back-office data-entry pages
(Mix Design, Production, Silos, and the rest of the 12-module list) are not
translated yet and still render in English/LTR regardless of locale. Adding
them is mechanical (the `dict`/`requirePageAccess` pattern is already
established) rather than a new design problem.

`requireRole` covers the highest-value mutating actions per module (see
above), not literally every Server Action in the app — a role that can
*view* a module (per `MODULE_ROLES`) can currently perform any write on it
unless that specific action has its own guard. Extending coverage action by
action is the natural next increment.

The PLC/batching-scale and weighbridge integrations are still simulated
through manual entry (Production's "record actuals" form stands in for a
real scale readout). Financial reporting (revenue per m³, material cost
variance, AR aging) needs a pricing/invoicing data model (customer price
lists, invoices, payments) that doesn't exist yet — the Reports page says so
explicitly rather than showing a fabricated number. Multi-currency exists at
the data level (`Plant.currency`) but nothing converts or displays it yet;
Arabic/RTL localization hasn't been started.

A few simplifications worth knowing about: batch completion picks the
*first* matching silo/hopper for a material type rather than an
operator-chosen one (Reports' silo days-of-cover inherits the same
limitation when two silos share a material type); delivered volume before a
return is the reservation's requested volume rather than a measured
unit-weight test; and the delivery photo is stored as a base64 data URL in
the database (fine for demo volumes — swap for real object storage, e.g.
S3-compatible, before production traffic).
