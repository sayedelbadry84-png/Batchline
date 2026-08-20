# Batchline

Ready-mix concrete plant operations platform. Design spec: see the published
Batchline artifact from this project's planning session for the full system
design (all 12 modules, business rules, integrations, RBAC, rollout plan).

This codebase covers **Phase 1 (Foundation)**, **Phase 2 (Production +
Fleet)**, and **Phase 3 (Quality & Compliance + driver mobile app)** of that
rollout — a real database, real CRUD, and the batching physics (yield
factor, tolerance, drum timer, return policy) actually computing from live
data, not placeholders.

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

Open [http://localhost:3000](http://localhost:3000) for the back office, or
[http://localhost:3000/driver](http://localhost:3000/driver) for the driver
app (pick "Karim Adel" or "Hassan Zaki" — there's no login yet, see below).

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
  back-office chrome: pick yourself (no auth yet, see below), see your
  assigned trips with a live drum-timer countdown, advance status through
  the delivery, capture a photo, and confirm with a signed-by name — closes
  full or with a return through the same policy logic as the dispatcher
  trip board
- **Audit trail** — every write across all three phases logs
  actor/role/module/record/reason to `AuditEvent`

## Not yet implemented (see the rollout plan)

Pumps and the PLC/SCADA/GPS/weighbridge hardware integrations are Phase 4+
and not built yet. Auth/session-based RBAC is also not wired up — the driver
app uses a cookie-based "pick yourself" flow standing in for a real login,
and back-office routes are open. A few simplifications worth knowing about:
batch completion picks the *first* matching silo/hopper for a material type
rather than an operator-chosen one; delivered volume before a return is the
reservation's requested volume rather than a measured unit-weight test; and
the delivery photo is stored as a base64 data URL in the database (fine for
demo volumes — swap for real object storage, e.g. S3-compatible, before
production traffic).
