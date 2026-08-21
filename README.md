# Batchline

Ready-mix concrete plant operations platform. Design spec: see the published
Batchline artifact from this project's planning session for the full system
design (all 12 modules, business rules, integrations, RBAC, rollout plan).

This codebase covers all 12 modules from the original system scope plus a
13th (Billing) added to close the commercial gap, across **Phase 1
(Foundation)**, **Phase 2 (Production + Fleet)**, **Phase 3 (Quality &
Compliance + driver mobile app)**, **Phase 4 (Pumps + integration webhooks
+ Reports/KPIs)**, **Phase 5 (real authentication + RBAC enforcement, and
full Arabic/RTL localization across every page)**, **Phase 6 (Billing —
customer pricing, invoicing, and AR)**, **Phase 8 (AI decision layer —
statistical anomaly detection on batch deviations, early-age strength
prediction, best-fit truck ranking for dispatch, estimated embodied
carbon, and a demand outlook from the reservation pipeline)**,
**Material Receiving** (built out of sequence to close a gap in the
original module list), **Phase 9 (features adopted from a live
competitor teardown — a reusable pump-crew roster, tiered driver
incentives, a real max-temperature validation on reservations, liter-based
admixture dosing, material brand tagging, and a derived stock ledger)**,
**Phase 10 (a second competitor teardown, this time of the same
product line's Dynamics 365 ERP module — a minimum pump-reach validation,
a fixed structural-element type list, and return reason/fate tracking on
drum returns)**, **Phase 11 (security & integration hardening —
`requireRole` coverage extended to every mutating Server Action across 8
previously-unguarded modules, login brute-force lockout, and authenticated
SCADA/telematics webhooks)**, **Phase 12 (a mobile-first field view
for plant operators — the same production floor workflow as the desktop
Production module, restyled for a phone at the batching panel, and a
second driver-app-style route tree separate from the main sidebar app)**,
and **Phase 13 (preventive-maintenance flagging for trucks and pumps,
derived from trip history — the sixth AI/decision-layer feature this
codebase has built on the "prove it with data the app already tracks"
approach)** — a real
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

**Phase 6 — Billing (pricing, invoicing, AR)**
- A new 13th module, `/billing`, closes the commercial gap the README used
  to call out explicitly on the Reports page: a customer price list
  (`PriceListEntry`, one price per m³ per customer+mix), invoice generation
  against closed deliveries, and payment tracking through to AR.
- **The delivery ticket is the billing unit, not the reservation** — a
  split reservation dispatched as several truckloads bills as several
  lines, possibly across separate invoices, matching how the split-batch
  dispatch model above already treats a reservation as many independent
  deliveries. `/billing` groups every closed trip that isn't on an invoice
  yet by project, and only offers "Generate invoice" once every mix
  involved has a price on file for that customer — a project short a price
  shows exactly which mix code is missing instead of guessing or silently
  invoicing at zero.
- Invoice status is a plain `DRAFT → SENT → PAID` flow (plus `CANCELLED`).
  "Overdue" is deliberately **not** a stored status — it's computed at
  display time from `dueDate` and the sum of recorded payments, the same
  pattern the app already uses for compliance-certificate expiry, so there
  is no background job required to keep it in sync. A payment that brings
  the paid total to (or past) the invoice total flips it to `PAID`
  automatically; partial payments just reduce the amount due.
- The due date comes from the customer's own `paymentTerms` field (e.g.
  "Net 30") via a small parser that pulls the number out of the free-text
  string, falling back to 30 days for anything that doesn't parse (a term
  like "Due on receipt" typed by hand shouldn't crash invoice generation).
- The Reports page's Billing section is now real, computed from the same
  `Invoice`/`Payment` tables the `/billing` screen writes to: revenue
  invoiced this month, AR outstanding, and AR overdue. The disclaimer box
  is narrowed to what's still genuinely absent — revenue *per m³* and
  material cost variance, which need a cost-accounting layer this phase
  didn't build — rather than the old blanket "no financial metrics" note.
- Verified live end to end: released and delivered a batch, set a price,
  generated an invoice (`INV-2026-0001`, 7 m³ × 2,500 = 17,500, due date
  correctly 30 days out from a "Net 30" customer), marked it sent, recorded
  a partial payment (amount due dropped from 17,500 to 7,500, status
  correctly stayed `SENT`), then a second payment that flipped it to
  `PAID` with amount due at 0. Confirmed the Reports tiles picked up the
  same numbers (17,500 invoiced, 7,500 AR outstanding, 0 overdue since the
  due date hadn't passed) before the final payment. Confirmed in Arabic too.
- **`cancelInvoice`** closes the gap noted above: an invoice can be voided
  from `DRAFT` or `SENT`, but only *before any payment is recorded* — once
  real money has been logged against it, cancelling would orphan that
  payment, and reconciling that is a manual step outside this pass's scope
  (the action just refuses). Cancelling doesn't delete the invoice — the
  header (number, total, dates, `CANCELLED` status) stays on file as the
  audit record of what was generated, while its line items are removed so
  the deliveries they billed become "ready to invoice" again (a trip can
  only carry one `InvoiceLine` — that's how "already billed" is detected).
  There's still no way to *edit* a wrong invoice in place, by design —
  cancel and regenerate is the supported path, not silently rewriting a
  number after the fact. Verified live: cancelled a draft `25,000 EGP`
  invoice, confirmed its one delivery reappeared in "Ready to invoice" and
  the cancelled invoice kept showing its original total in the list, then
  generated a fresh invoice for the same delivery successfully.

**Phase 8 — AI decision layer (first feature: anomaly detection)**
- Per the strategic review's own advice — prove the AI layer with a small,
  data-already-exists win before investing in anything that needs an
  external model or API — Reports now runs two statistical checks over the
  same weighed-component deviation data the existing "avg. batch deviation"
  metric already reads, no new data collection required
  (`src/lib/anomaly.ts`, a pure function, no external calls):
  - **Outlier**: a single reading whose z-score against that material's own
    historical mean/stddev exceeds 2.5, checked only among each material's
    5 most recent readings (an outlier from months ago isn't actionable
    today).
  - **Drift**: the last 3 readings for a material all landing on the same
    side of target past ±1.5%, even when none of them individually looks
    dramatic — closer to what an actual scale-calibration problem produces
    than a one-off spike is.
- Surfaced as an "Anomaly alerts" card on Reports, right under the
  production tiles it's derived from — a chip per flag naming the material,
  the batch ticket, and a plain-language reason, or an explicit empty state
  rather than nothing at all when there's nothing to flag.
- **A real bug surfaced while verifying this**: `recordActuals` treated a
  blank scale-reading field as `Number("") === 0` — recording "weighed at
  0kg" instead of "not weighed yet" for any component the operator hadn't
  gotten to. That silently distorted the pre-existing average-deviation
  metric too, not just the new anomaly check. Fixed by skipping blank
  fields the same way a genuinely absent field is already skipped.
- Verified live: ran three consecutive batches with cement actuals
  deliberately biased +3% over target (other components left unweighed).
  Before the `recordActuals` fix, every component showed a false DRIFT flag
  (blanks were reading as -100% deviation) and the average deviation showed
  an absurd 80.6%; after the fix, only cement was flagged — correctly
  reading "the last 3 batches all ran over target by more than 1.5%" — and
  the average deviation dropped to a realistic 3.00%. Confirmed in Arabic.

**Phase 8 — AI decision layer, second feature: early strength prediction**
- A cylinder break at 28 days is the real answer, but it's known weeks
  after the pour — too late to act on a problem batch. Quality now
  estimates the eventual late-age strength from an early-age reading (age
  3, 7, or 14 days — the ages QC actually samples at), the same "prove it
  with data already on file" approach as the anomaly-detection feature
  above (`src/lib/strength-prediction.ts`, a pure function, no external
  model or call).
- **Two methods, chosen automatically per age**: once there are at least 3
  historical (early-age, 28-day) pairs *for that specific age* on this
  plant's own `LabResult` records, it fits a linear regression (least
  squares) and labels the prediction "based on N of this plant's own
  historical results." Below that threshold it falls back to a widely-cited
  generic strength-gain ratio (≈40%/65%/85% of 28-day strength at 3/7/14
  days for ordinary Portland cement), explicitly labeled as a general
  default rather than passed off as plant-specific. The regression is
  always preferred once there's enough data to trust it more than the
  generic curve.
- The reference target it checks the prediction against is whatever
  `targetStrengthMpa` the QC engineer logged alongside that same early-age
  result — the app has no separate "28-day design target" field to invent
  one from, so this is the most honest reference available rather than a
  guess. A batch only gets a prediction while it lacks a 28-day-or-later
  result of its own; once one is recorded, the prediction disappears in
  favor of the real number.
- Surfaced as an "On track" / "At risk" chip plus the predicted MPa and
  method, directly under a test batch's lab-results table on the Quality
  page — the natural place to look right after logging an early break.
- Verified live: logged a 7-day/20 MPa result against a 30 MPa target with
  no plant history yet — got "On track, predicted 30.8 MPa, using a
  general industry default" (20 ÷ 0.65 ≈ 30.8, correct). Logged a 28-day/32
  MPa result on the same test batch — the prediction correctly disappeared
  once the real result existed. On a second test batch, logged a 7-day/15
  MPa result against the same 30 MPa target and got "At risk, predicted
  23.1 MPa" (15 ÷ 0.65 ≈ 23.1) — correctly flagged as below target.
  Regression math (ordinary least squares) verified independently against
  known sample data outside the app. Confirmed in English and Arabic.

**Fleet double-booking gap fixed; Phase 8's third feature: truck-fit ranking**
- Building the third AI feature surfaced a real bug: the Fleet page's own
  intro text has always claimed "trucks currently on an open trip can't be
  double-booked from Production," but nothing actually enforced it — the
  truck picker on a completed batch ticket, and `startTrip` itself, never
  checked whether a truck was already carrying another open trip. Fixed at
  both layers: the picker's query now excludes any truck with a non-`CLOSED`
  trip (`trips: { none: { status: { not: "CLOSED" } } }`), and `startTrip`
  re-checks the same condition server-side rather than trusting the picker
  only offered free trucks — a second tab or a stale page shouldn't be able
  to double-book one anyway.
- With that gap closed, it was worth ranking the (now genuinely available)
  trucks instead of a plain alphabetical list —
  `src/lib/dispatch.ts`, a pure function, no external data: trucks that can
  carry the ticket's full volume in one load are ranked by smallest leftover
  capacity (least wasted capacity first, tagged "best fit"); trucks too
  small for the load sort separately, largest-first, and are labeled with
  exactly how many m³ short they are rather than silently offered as
  equal — still selectable, since a split delivery across multiple trucks
  is sometimes the real answer, just not silently presented as a good fit.
- Verified live: a 7 m³ ticket correctly ranked the exact-capacity 7 m³
  truck first as "best fit," ahead of an 8 m³ truck; after assigning that
  truck to a trip, a second ticket's picker correctly excluded it (only the
  8 m³ truck remained) — confirming the double-booking fix; a 15 m³ ticket
  against only an 8 m³ truck available correctly showed "8 m³ — 7.0 m³
  short of the load" rather than silently offering it as adequate.
  Confirmed in English and Arabic.

**Phase 8's fourth feature: estimated embodied carbon**
- The first feature from the strategic review's "customer & sustainability"
  layer, and — like the anomaly detection and strength prediction above —
  built from data the app already has, not a new integration
  (`src/lib/carbon.ts`): a reference table of typical published
  embodied-carbon factors per material type (kg CO₂e per kg — the kind of
  order-of-magnitude figures cited in concrete-industry EPD/ICE-database
  literature), explicitly **not** measured or verified for this plant's
  actual suppliers. Every surface that shows a number derived from it says
  so, the same honesty discipline Reports already applies to metrics it
  can't back with real data.
- **Mix Design** gets a fourth tile alongside computed volume/yield/total
  mass: estimated embodied carbon per m³, computed from the mix's own
  `MixComponent` design masses — a design-time estimate.
- **Reports** gets a new "Sustainability" section: estimated CO₂e over the
  last 7 days and per m³, computed from what was *actually* batched
  (`BatchComponentActual`, actual mass where weighed, target where not) —
  an operational number, not a design-time one, reusing the same
  `completedTickets` data the production and anomaly sections already
  fetch (no new query).
- Verified live: a mix with 340 kg cement + 780 kg sand + 1040 kg coarse
  aggregate + 170 kg water + 3.4 kg superplasticizer per m³ showed
  296 kg CO₂e — matches `340×0.83 + 780×0.005 + 1040×0.007 + 170×0.0003 +
  3.4×0.72 ≈ 295.9`, computed independently to confirm. Confirmed the
  Reports tiles show "—" rather than a fabricated 0 or NaN when there's no
  production in the last 7 days yet. Confirmed in Arabic.
- **Incidental cleanup**: verifying this surfaced duplicate seed data in
  the local dev database (silos showing twice) — caused by running
  `prisma db seed` a second time against an already-seeded database during
  manual verification, not a bug in the app. Re-seeded from a clean
  `db push` to fix; worth knowing `prisma db seed` isn't idempotent here
  the way `db push` is.

**Phase 8's fifth feature: demand outlook**
- The strategic review's demand-forecasting idea, scoped honestly: the app
  has no order history deep enough yet to fit a real statistical forecast
  the way anomaly detection or strength prediction can (those lean on data
  that accumulates from day one of production; a seasonal or day-of-week
  demand pattern needs months of it). What's reliably knowable today is the
  confirmed reservation pipeline itself — real committed volume, not a
  guess — which is exactly what a plant manager needs to avoid a stockout
  on a day that's already booked.
- **Reports** gets a "Demand outlook" strip: the next 7 days, each showing
  the volume still owed against reservations with a pour window that day
  (`src/lib/demand.ts`, a pure day-bucketing function). Volume already
  released as batch tickets is netted out — a split reservation partway
  through delivery shows what's actually still coming, not its full
  original size, reusing the same accounting the Reservations and
  Production screens already do for split-batch dispatch. A day with
  nothing booked shows "—", not a fabricated zero-looking blank.
- Verified live: a 7 m³ reservation with tomorrow's pour window showed
  correctly under its date with "1 reservation"; releasing a 3 m³ partial
  batch ticket against it dropped the outlook figure to 4.0 immediately,
  confirming the netting. Confirmed in English and Arabic.

**Dashboard rebuilt as a command center**
- The old dashboard was a count grid plus two alert boxes. Rebuilt it as
  the single-pane-of-glass front door the design review called for —
  everything that needs a decision today, in one place, computed live
  from the same records every other module writes to (no new tables, no
  client-side polling).
- **Unified "Needs attention" feed**: every warning that used to live on a
  different screen — silo low-level, drum-timer overrun, expiring/expired
  compliance certificates, credit-hold reservations, overdue invoices, and
  the anomaly-detection flags from Reports — now surfaces in one
  severity-sorted list (critical first), each row linking straight to
  where it needs to be acted on. An empty state reads "clean" rather than
  showing nothing.
- **KPI row with a real sparkline**: production over the last 7 days
  (with a 7-bar daily trend, plain CSS height bars — no charting library),
  AR outstanding, cylinder pass rate, and open trips right now — each
  card links to its module.
- **Live operations**: up to 4 currently-open trips as compact cards
  reusing the same `DrumTimer` client component the Trip Board already
  uses (ticks live client-side, hydration-safe placeholder on first
  paint), with a "+N more" link when there are more.
- **Demand outlook**: the exact same 7-day reservation-pipeline strip from
  Reports, factored into a shared `DemandOutlookStrip` component
  (`src/components/`) so the two views can't quietly drift apart.
- **Role-aware, not just role-gated**: the AR tile and billing/quality
  alerts only render for a role that can actually act on `billing` /
  `quality` per the existing `MODULE_ROLES` map — a Plant Operator gets
  production, fleet, and quality context; an Accountant additionally sees
  AR. The dashboard doesn't show data a role can't otherwise reach just
  because it's convenient to have on one screen.
- Verified live: as Admin, the alert feed correctly combined a silo
  warning and a certificate-expiry warning from two different modules
  into one list; releasing and starting a real trip made it appear on
  "Live operations" with a running `DrumTimer` and pushed the day's
  sparkline bar up; the demand-outlook figure correctly dropped to empty
  once its reservation was fully released. Switched to a Plant Operator
  login and confirmed the AR tile disappeared while the quality pass-rate
  tile remained — RBAC gating verified, not assumed. Confirmed the full
  layout in Arabic — sidebar and every card correctly mirror to RTL.

**Phase 9 — features adopted from a competitor teardown**
- Built after a live walkthrough of a competitor ready-mix system
  (RhinoMaster), scoped to the six areas explicitly requested:
  reservations, production, fleet management, mix design, raw materials,
  and stock balances. Each feature below is derived from data the app
  already records wherever possible, rather than adding parallel state
  that could drift out of sync.
- **Reservations** — a pasted maps-share link (`siteLocationUrl`) shown as
  a clickable "map" link next to the project name, simpler and more
  directly actionable for a driver than structured coordinates; a "lab
  technician required on site" flag (`labTechnicianRequired`) shown as a
  badge chip; and the existing `temperatureC` field repurposed from an
  informational figure into a real validation threshold — the Quality
  page now flags a logged `TestBatch.concreteTempC` in red when it
  exceeds the reservation's max, instead of just recording it.
- **Fleet management** — a reusable **Pump Crew roster**
  (`PumpCrewMember`, managed from the Pumps page) replacing free-text
  pump-operator/assistant entry: the trip-start form on a batch ticket
  now offers roster names via an HTML5 `<datalist>` autocomplete, and
  `startTrip` resolves a typed name against the roster case-insensitively
  (scoped to the ticket's plant) to also set `pumpOperatorId` /
  `pumpAssistantId` — while still always storing the plain-text name, so
  a crew member can be typed off-roster without being forced into master
  data first. Also **Driver Incentives** (`/incentives`): a tiered
  per-trip bonus policy per plant (`DriverIncentivePolicy` — free trips,
  then three rate tiers), with payout computed live from each driver's
  closed-trip count for the current month (`src/lib/incentives.ts`, a
  pure function) — nothing precomputed or stored.
- **Mix design + raw materials** — `Material.brand` (e.g. "BASIF PS-201")
  shown in the Suppliers materials table and both its forms; and
  `MixComponent.dosageUnit` (KG / LITER) so a chemical admixture can be
  dosed and displayed in liters on the mix-design detail page, converted
  from the one stored `designMassKgPerM3` via the material's own specific
  gravity (`liters = designMassKgPerM3 / specificGravity`) — the mass
  figure stays the single source of truth for yield/tolerance math either
  way, so there's no second stored quantity that could drift.
- **Stock ledger** (`/stock-ledger`) — a per-material balance with a full
  movement history, derived entirely from existing records: inflows are
  receipts that actually posted to inventory (the same condition
  Material Receiving itself uses before touching a silo/hopper level),
  outflows are completed batch tickets' actual (or target, if never
  weighed) mass — the same fallback `completeBatch` already uses when
  deducting inventory. No new stock-count entry screen, so there's
  nothing to keep in sync by hand.
- Verified live end-to-end: created a pump crew member, then started a
  pump-delivery trip typing the name in a different case than stored —
  confirmed in the database that `pumpOperatorId` resolved correctly
  while `pumpOperatorName` kept the exact text typed. Set a driver
  incentive policy and confirmed it persisted. Set a material's dosage to
  3.5 liters and confirmed the mix-design page displayed "3.50 لتر" (round-
  tripped correctly through the stored kg figure). Set a material brand
  and confirmed it rendered in the Suppliers table. Posted a pending
  material receipt and confirmed its `+29,700 kg` appeared as the first
  entry in that material's stock ledger, netted correctly against two
  batch tickets' consumption. Confirmed in Arabic throughout — new nav
  entries, table columns, and form labels all render RTL with no
  English-only strings.

**Phase 10 — a second competitor teardown (Dynamics 365 ERP module)**
- Same product line as the Phase 9 teardown, found running as a
  `ReadyMix Management` module inside a real customer's Microsoft Dynamics
  365 Finance & Operations instance — a deeper, read-only look at the same
  underlying data model from a different deployment. Three concrete gaps
  it surfaced were closed; a fourth (a separate operations-approval gate
  distinct from reservation status) and a fifth (two-step cancellation)
  were flagged as needing their own design pass rather than built blind.
- **Minimum pump reach** — `Reservation.minPumpReachM`, an optional
  required boom/line reach for a pump delivery. The trip-start form on a
  completed batch ticket labels any pump whose `reachM` falls short
  ("reach too short") right in the `<select>`, and `startTrip` re-checks
  it server-side and refuses to start the trip if a short pump is
  submitted anyway — the same defense-in-depth pattern already used for
  the truck-busy check on that same form.
- **Structural element type** — `Reservation.structureType`, a fixed list
  (Foundation, Slab, Column, Column neck, Beam, Roof, Raft, Other) that
  now sits alongside the existing free-text `structuralElement` field
  rather than replacing it: the type is what makes "how much concrete
  went into columns this month" a real query instead of a free-text
  guess, while the free-text field keeps its job as an optional specific
  label ("Column C12").
- **Return reason and fate** — `DrumReturn.reasonCode` (why the load came
  back: customer cancelled, site not ready, over-ordered, access blocked,
  quality rejected, traffic delay, other) and `DrumReturn.fate` (dumped or
  reclaimed), both new and both orthogonal to the existing `disposition`
  field, which stays exactly what it was — the time/volume-driven
  financial outcome (no charge / partial credit / full waste). Captured
  right on the Trip Board's existing "log return & close" form.
- Verified live: created a pump-delivery reservation with a 50 m minimum
  reach, confirmed the trip-start form flagged the plant's 37 m pump as
  "reach too short" while leaving the 60 m pump clean, then confirmed
  `startTrip` actually refused the short pump when submitted directly
  (no trip created, form redisplayed) and succeeded with the long one.
  Confirmed the structural-element type dropdown and its chip render
  correctly on the Reservations table. Closed a trip with a return,
  reason "site not ready," and fate "reclaimed" — both showed correctly
  on the Trip Board's closed-trips row. Confirmed in Arabic throughout.

**Phase 11 — security & integration hardening**
- **`requireRole` now covers every mutating Server Action**, not just the
  highest-value ones — an audit found 8 modules (customers, fleet,
  projects, pumps, reservations, silos, suppliers, trips — 29 functions)
  with no server-side role check at all, relying only on
  `requirePageAccess` at the page level. Every one now enforces the same
  role list `MODULE_ROLES` already declares for that module, so the
  Sidebar hiding a link and the ability to actually invoke the action
  behind it can no longer drift apart. The one deliberate nuance: the
  three shared trip-lifecycle actions (`advanceTrip`, `closeTripFull`,
  `closeTripWithReturn`) accept `DRIVER` alongside `PLANT_OPERATOR` /
  `ADMIN`, because the driver app's own wrappers
  (`src/app/driver/actions.ts`) call straight into them after already
  verifying the trip belongs to that driver (`requireOwnTrip`) — narrowing
  those three to exclude `DRIVER` would have silently broken delivery
  confirmation from the driver app.
- **Login brute-force lockout** — `User.failedLoginAttempts` /
  `lockedUntil`: 5 wrong passwords locks the account for 15 minutes.
  A locked account fails with the *exact same* generic "email or password
  incorrect" message as a wrong password, deliberately not a distinct
  "account locked" error — that would let an attacker use the lockout
  itself to fingerprint which emails have real accounts. Resets to zero
  on the next successful login.
- **Authenticated integration webhooks** — `/api/scada/silo-reading` and
  `/api/telematics/ping` were open to any anonymous POST from the
  internet; both now require `Authorization: Bearer <INTEGRATION_API_KEY>`
  (`src/lib/integration-auth.ts`), checked with a constant-time compare
  rather than `===` so a timing side-channel can't leak the key one byte
  at a time. Fails closed: with no key configured, every request is
  rejected rather than silently accepted.
- Verified live: 5 wrong-password attempts locked the account, and the
  *correct* password was then rejected with the identical generic error
  while locked. Both webhooks returned 401 with no/wrong key and 200 with
  the right one. Full driver flow re-verified end to end after the
  `requireRole` audit — advance, arrive, discharge, confirm delivery — to
  confirm the `DRIVER`-inclusive guard didn't regress it. A new customer
  create still worked for `ADMIN` under its new guard.

**Phase 12 — mobile field view for plant operators**
- The first of three large investments identified in a strategic
  five-pillar review (gaps, UX, integration, AI, security) — the user
  picked this one first. Same idea as the existing driver app
  (`src/app/driver`): a separate route tree (`src/app/operator`) sharing
  only the root layout, no sidebar, single-column, large touch targets —
  but for `PLANT_OPERATOR` (and `ADMIN`) instead of `DRIVER`. Not a forced
  redirect like the driver app, since plant operators still need the full
  desktop app for every other module — reachable via an "Open field view"
  link on the Dashboard, visible only to those two roles.
- **`/operator`** — two lists: reservations ready to release (a
  one-tap release form, volume pre-filled to what's remaining) and batch
  tickets needing action right now (released/batching, or complete but
  not yet dispatched) — both scoped to the operator's own plant.
- **`/operator/ticket/[id]`** — the exact same actions as the desktop
  Production detail page (`recordActuals`, `completeBatch`, `startTrip`,
  reused directly, not duplicated), but the five-column actuals table
  becomes a stacked card per material — name, target, one or two large
  inputs, deviation shown once entered — since a wide table doesn't work
  on a phone screen.
- **Redirects now context-aware, not duplicated actions**: `startTrip`
  and `releaseBatchTicket` used to hard-code where they sent the user
  next (`/trips`, `/production/:id`). Forking them into
  operator-specific copies would have meant two places to keep the
  business logic in sync forever. Instead each now reads an optional
  hidden field (`returnTo`, `returnPrefix`) defaulting to the exact
  desktop behavior when absent, so the field view's forms just add one
  hidden input to land back on `/operator` instead.
- Also closed while in this area: `releaseBatchTicket`, `recordActuals`,
  and `startTrip` had no `requireRole` guard at all (missed by the Phase
  11 audit, which only checked whole `actions.ts` files with *zero*
  guarded exports — this one had one guarded export out of four and got
  skipped). All three now require `PLANT_OPERATOR`/`ADMIN`, matching
  `completeBatch`'s existing guard.
- Verified live: released a reservation from `/operator`, landed back on
  `/operator/ticket/:id` (not the desktop page); entered actuals and
  confirmed deviations computed correctly; completed the batch; assigned
  a truck and started the trip, landing back on `/operator` with the
  ticket correctly gone from the action list. Confirmed the mobile
  (375px) layout renders correctly via screenshot — card-per-material,
  no horizontal scroll, RTL intact.
  **Known tooling limitation, not an app bug:** the browser-automation
  harness's touch-emulation for viewports under 768px did not reliably
  deliver click events to Server Action submit buttons during this
  session (consistent timeouts); every action above was therefore
  exercised at desktop width against the identical, unmodified component
  — the same JSX renders at both sizes, so this validates the code path,
  not just the layout. A real touchscreen wasn't available to re-check the
  actual tap gesture end-to-end.

**Phase 13 — preventive maintenance for trucks and pumps**
- The second of three large investments from the five-pillar strategic
  review (the first was Phase 12's field view). Same "derive it from data
  the app already tracks" approach as the five earlier AI features —
  `src/lib/maintenance.ts` computes trips since a vehicle's last service
  from its own `Trip.batchTime` history, no new telemetry or sensor feed.
- **`Plant.maintenanceIntervalTrips`** (default 150) — one threshold per
  plant, editable alongside the existing drum-timer and return-absorption
  thresholds on the Plants page, since a low-volume and a high-volume
  plant wear equipment at genuinely different rates.
- **`Truck.lastMaintenanceAt` / `Pump.lastMaintenanceAt`** — reset by a
  new "Mark serviced" action, deliberately separate from the existing
  `status` field (`ACTIVE`/`MAINTENANCE`/`OUT_OF_SERVICE`): "serviced"
  and "currently available" are different facts, since a vehicle can be
  serviced during idle time without ever being pulled to `MAINTENANCE`
  status.
- Fleet and Pumps pages both show a maintenance column: last-serviced
  date (or "never recorded"), trip count since, and a "due for
  inspection" badge once that count reaches the plant's threshold.
  Trucks/pumps overdue also surface in the Dashboard's unified "needs
  attention" feed alongside the existing silo/drum/cert/credit/invoice
  alerts, gated to roles that can see Fleet.
- Also closed in passing: `releaseBatchTicket`, `recordActuals`, and
  `startTrip` in `production/actions.ts` had no `requireRole` guard —
  missed by the Phase 11 audit for the same reason as the Phase 12
  finding (that file had one guarded export out of four and the audit
  only flagged files with *zero*). All three now require
  `PLANT_OPERATOR`/`ADMIN`.
- Verified live: released → completed → started a trip for MX-08 with
  the plant's interval temporarily set to 1, confirmed it correctly
  flagged "due for inspection" with the right trip count on both the
  Fleet page and the Dashboard alert feed, while untouched trucks stayed
  clean. Confirmed the "mark serviced" reset via a direct database check
  (`lastMaintenanceAt` updated, count returned to 0) after the same
  browser-automation click-delivery issue as Phase 12 prevented an
  interactive click-through on this specific button — the read-side
  (flag computation, badge, alert, per-plant threshold) was fully
  verified live in the browser; only this one write action's literal
  click had to be cross-checked outside it. Confirmed the new threshold
  field renders on the Plants page and the maintenance column renders on
  both Fleet and Pumps. Confirmed in Arabic throughout.

**Go-live hardening — secure session cookie**
- The session cookie now sets `secure: true` whenever `NODE_ENV` is
  `"production"` (what `next build`/`next start` runs — i.e. any real
  deployment), so it's never sent over a plain-HTTP fallback once the app
  is reachable beyond localhost. Off for local `next dev`, where there's
  no HTTPS to require. Prompted by walking through what's actually needed
  to put Batchline on the public internet (see the deployment guide
  referenced in this session) rather than a standalone finding.

## Not yet implemented (see the rollout plan)

Coverage gaps beyond what Phase 11 closed: rate limiting exists for login
specifically, not for Server Actions in general (a scripted client could
still hammer, say, `createReservation`); the integration API key is a
single shared secret rather than one per gateway/device, so it can't be
revoked for one sensor feed without rotating it for all of them; and
there's no TLS termination, WAF, or dependency-vulnerability scanning
configured at this layer — those are deployment-infrastructure decisions
(hosting provider, reverse proxy, CI) rather than application code.

The PLC/batching-scale and weighbridge integrations are still simulated
through manual entry (Production's "record actuals" form stands in for a
real scale readout). Financial reporting now covers invoiced revenue and AR
aging (Phase 6, above); revenue *per m³* and material cost variance still
need a cost-accounting layer (standard vs. actual material cost per batch)
that hasn't been built — the Reports page says so explicitly rather than
showing a fabricated number. Invoices also have no cancel/edit path yet
(see Phase 6's known limitation). Multi-currency exists at the data level
(`Plant.currency`, and invoices inherit their project's plant currency) but
nothing converts between currencies or displays a consolidated multi-plant
total yet.

A few simplifications worth knowing about: batch completion picks the
*first* matching silo/hopper for a material type rather than an
operator-chosen one (Reports' silo days-of-cover inherits the same
limitation when two silos share a material type); delivered volume before a
return is the reservation's requested volume rather than a measured
unit-weight test; and the delivery photo is stored as a base64 data URL in
the database (fine for demo volumes — swap for real object storage, e.g.
S3-compatible, before production traffic).
