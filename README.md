# Batchline

Ready-mix concrete plant operations platform. Design spec: see the published
Batchline artifact from this project's planning session for the full system
design (all 12 modules, business rules, integrations, RBAC, rollout plan).

This codebase is **Phase 1 (Foundation)** of that rollout: Plant, Silo, Mix
Design, Customers, Suppliers, Projects, Employees, and a first cut of
Reservations — with a real database, real CRUD, and the yield-factor formula
computing live from mix component data.

## Stack

- Next.js 16 (App Router, Server Actions)
- Prisma 5 ORM, SQLite for local dev (swap the datasource to PostgreSQL for
  production — one line in `prisma/schema.prisma` plus `DATABASE_URL`)
- Tailwind CSS v4
- Oswald / IBM Plex Sans / IBM Plex Mono, matching the Batchline design system

## Getting started

```bash
npm install
npx prisma db push      # create/sync the local SQLite database
npx prisma db seed      # load a demo plant, mix design, customer, project
npm run dev
```

Open [http://localhost:3000](http://localhost:3000).

## What's implemented

- **Plants** — plant registry, currency/timezone
- **Silos** — live level tracking, low-threshold alert surfaced on both the
  Silos screen and the dashboard
- **Mix Design** — recipe library with a component editor; design volume is
  computed from real specific-gravity data via the absolute-volume method
  (ACI 211.1 style), not a placeholder number
- **Suppliers** — vendor master + material catalog (specific gravity,
  absorption — feeds the Mix Design calculation)
- **Customers, Projects, Employees, Reservations** — CRUD with the credit-hold
  rule from the design spec (a reservation against a customer with no credit
  limit set is flagged, not silently confirmed)
- **Audit trail** — every write logs actor/role/module/record/reason to
  `AuditEvent`

## Not yet implemented (see the rollout plan)

Production batching against real weighing hardware, Fleet/Trips, drum-return
tracking, Test Batches/Lab Results/Compliance Certificates, Pumps, the driver
mobile app, and the PLC/SCADA/GPS/weighbridge integrations are Phase 2+ and
not built yet. Auth/session-based RBAC is also not wired up — routes are open
in this phase.
