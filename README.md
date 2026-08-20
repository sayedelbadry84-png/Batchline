# Batchline

Ready-mix concrete plant operations platform. Design spec: see the published
Batchline artifact from this project's planning session for the full system
design (all 12 modules, business rules, integrations, RBAC, rollout plan).

This codebase covers all 12 modules from the original system scope, across
**Phase 1 (Foundation)**, **Phase 2 (Production + Fleet)**, **Phase 3
(Quality & Compliance + driver mobile app)**, **Phase 4 (Pumps + integration
webhooks + Reports/KPIs)**, **Phase 5 (real authentication + RBAC
enforcement, and full Arabic/RTL localization across every page)**, and
**Material Receiving**
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
- **Split / partial batch loading** — a reservation's requested volume is
  rarely one truckload, so Production releases batch tickets against a
  reservation's *remaining* undispatched volume (`src/lib/reservations.ts`),
  not its full requested volume. The operator enters how much this load
  should carry (defaulted to the full remainder, capped at it); the released
  ticket's mix components are scaled to that partial volume, and the
  reservation only flips from `CONFIRMED`/`IN_PRODUCTION` to `DELIVERED` once
  every released ticket has a closed trip *and* the sum of released volume
  meets the requested volume — a fix from the prior behavior, which marked a
  reservation `DELIVERED` as soon as any one of its trips closed, wrongly
  closing out reservations that still had undispatched volume. The
  Reservations and Production screens both show `released / requested m³`
  instead of a single static volume once a reservation has partial releases.
  Verified live: a 200 m³ reservation released as an 8 m³ ticket correctly
  showed "192 / 200 m³ remaining" and stayed in the ready-to-release list
  (previously it would have disappeared once its status left `CONFIRMED`);
  closing that trip kept the reservation `IN_PRODUCTION` rather than
  `DELIVERED`; a normal single-load 7 m³ reservation still flips to
  `DELIVERED` on its one trip closing, confirming no regression on the
  common case.

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
- **The entire app is localized**, not just the highest-traffic surfaces:
  login, the sidebar/nav, the dashboard, the driver app, and all 16
  back-office pages (every module from Mix Design through Reports) — every
  heading, table column, form label, button, and empty-state message reads
  from `src/lib/i18n/dictionaries/{ar,en}.ts`. Status/role/material-type
  enum values (e.g. `APPROVED`, `QUALITY_SUPERVISOR`, `COARSE_AGGREGATE`)
  translate through one shared map (`dict.status`, `dict.roles`,
  `dict.materialTypes`) reused everywhere that value appears, so a status
  chip means the same thing in Arabic on every screen it's rendered on.
  User-entered data (names, codes, addresses) is deliberately left
  untranslated — only UI chrome is localized.
- Directional details, not just text: the sidebar's active-link indicator
  and its border against the main content use logical properties
  (`border-s-2`, `border-e`) so they land on the correct side automatically,
  every table header uses `text-start` (fixed once in the shared `ui.ts`
  pattern, not per page), codes/emails/GPS coordinates/currency values get
  an explicit `dir="ltr"` island so they don't reverse inside RTL text, and
  the driver app's back arrow flips (`←`/`→`) with direction.
- Verified live, not just visually: logged in as Plant Operator in Arabic
  and walked Mix Design (yield-factor math still correct at 0.961 m³),
  released a real batch ticket (targets computed correctly, status showed
  "تم الإصدار"), and checked Silos, Trips, Quality (certificate expiry
  showed "متبقٍ 45 يوم"), and Reports — zero console/server errors on any
  of them. Separately switched back to English on the same pages to confirm
  no regression. Logged in as a driver, switched to Arabic, and completed a
  full delivery confirmation — RTL layout, Arabic labels, and the Arabic
  signed-by name (`م. أحمد سمير`) all the way through to the database.
  Confirmed page-level RBAC (`/access-denied`) still enforces correctly
  under localization — an Accountant hitting a Plant-Operator-only page in
  Arabic gets the same block as in English.
- One real bug found and fixed along the way: the dictionary object holds
  formatter functions for a few messages (e.g. `delivered(m3) => "Delivered
  ${m3} m³"`, since the volume has to be interpolated) — passing the *whole*
  dictionary as a prop
  to the Sidebar (a Client Component) crashed, because React can't
  serialize functions across that boundary, even ones the component never
  reads. Fixed by passing only the plain-string slices (`nav`, `common`)
  each Client Component actually needs.

**Edit everywhere (master data)**
- Every master-data screen — Plants, Customers, Suppliers (+ their Material
  catalog), Projects, Employees, Fleet (truck core fields, alongside the
  existing quick status form), Pumps (core fields, alongside assignment
  status), Silos (core fields, alongside the existing level reading form),
  Mix Design (header fields + per-component mass/tolerance, reusing the
  existing upsert), Reservations (pre-production fields only — see below),
  and Compliance Certificates — now has an **Edit** action next to every row,
  not just Create. The pattern is consistent everywhere: click Edit
  (`?edit=<id>` in the URL), the row becomes an inline form pre-filled with
  its current values, Save posts to an `updateX` Server Action and
  re-renders the row, Cancel discards and returns to the plain list — no
  client state, matching the rest of the app's server-first design.
- **Reservations are only editable before any volume has shipped.** Once a
  batch ticket has been released against a reservation — even a single
  partial one — its mix, volume, and project become read-only (no Edit link
  shown, and `updateReservation` re-checks this server-side rather than
  trusting the UI) because retargeting a reservation after tickets already
  exist against it would silently invalidate volumes and tolerances that
  were already computed and possibly delivered.
- **Deliberately still not editable** — audit-sensitive records where "the
  history is the point": Material Receiving once captured (weighbridge
  gross/tare/net), Test Batches and Lab Results, Trip transactional fields
  (only status advances), Drum Returns, and Batch Ticket component actuals
  after a batch reaches COMPLETE. Opening these up would let someone quietly
  rewrite a measurement after the fact, which defeats the audit trail this
  app is built around.

**Pour-order details on Reservations**
- A reservation now captures the details a real delivery ticket needs beyond
  project/mix/volume/window: requested slump (mm, independent of the mix
  design's own slump target — site conditions can call for an on-the-day
  adjustment, e.g. a pump mix run wetter than the design), expected
  temperature, the specific pour location on site (distinct from the
  project's site address), a site contact name and phone number, delivery
  method (pump or chute), and the structural element being poured (e.g.
  "Column C12" / "Slab L3"). All optional, all editable via the same
  Edit-everywhere pattern above.
- The Reservations table surfaces them compactly rather than adding a wall
  of columns: pour location/contact/phone sit under the project name,
  slump/temperature sit under the volume, and structural element and
  delivery method get their own columns since dispatch actually needs them
  at a glance.

**Pump crew on trip start**
- Starting a trip from a completed batch ticket (Production → "Assign truck
  & start trip") already picked a truck and driver; it now also picks the
  pump unit and crew — but only when the reservation behind the ticket was
  booked for pump delivery. A chute-delivery reservation still shows just
  Truck/Driver, unchanged.
- Added `pumpId` (→ `Pump`), `pumpOperatorName`, and `pumpAssistantName` to
  `Trip`, deliberately separate from `PumpAssignment` (the pump booking
  calendar on the Pumps screen) — that model schedules a pump against a
  reservation for billing hours, this records who actually ran which pump
  on a specific delivery. `startTrip` ignores any pump fields submitted for
  a chute delivery rather than trusting the form, so a stray value can't
  attach a pump to a trip that never used one.
- Verified live: started a trip on a pump-delivery reservation and
  confirmed the pump code, operator, and assistant all round-tripped onto
  the ticket's trip summary ("MX-08 · Hassan Zaki · PMP-1 · Eng. Sameh ·
  Youssef"); confirmed a chute-delivery ticket's assign form has no pump
  section at all — no regression on the common case.

## Not yet implemented (see the rollout plan)

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
the data level (`Plant.currency`) but nothing converts or displays it yet.

A few simplifications worth knowing about: batch completion picks the
*first* matching silo/hopper for a material type rather than an
operator-chosen one (Reports' silo days-of-cover inherits the same
limitation when two silos share a material type); delivered volume before a
return is the reservation's requested volume rather than a measured
unit-weight test; and the delivery photo is stored as a base64 data URL in
the database (fine for demo volumes — swap for real object storage, e.g.
S3-compatible, before production traffic).
