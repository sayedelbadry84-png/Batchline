<!-- BEGIN:nextjs-agent-rules -->

# This is NOT the Next.js you know

This version has breaking changes — APIs, conventions, and file structure may all differ from your training data. Read the relevant guide in `node_modules/next/dist/docs/` (resolved from this file's directory; in monorepos the `next` package may not be visible from the repo root) before writing any code. Heed deprecation notices.

This block is written and re-added by `next dev` — verify at `node_modules/next/dist/server/lib/generate-agent-files.js`. Removing it from a diff only re-creates the uncommitted change; committing it with your work keeps the tree clean.

<!-- END:nextjs-agent-rules -->

# Batchline

Ready-mix concrete plant operations platform. Next.js 16 (App Router) · React 19 ·
Prisma 5 · PostgreSQL · Tailwind 4. ~51k lines, 205 TS/TSX files, 96 Prisma models,
13 business modules. Arabic/English with full RTL.

Deployed on Vercel. Storage is Vercel Blob (private). There is no external message
broker or worker fleet (no Redis, no SQS, no BullMQ) — but there ARE two durable,
database-backed retry queues, `PendingAutoRequisition` and `PendingBlobDeletion`,
drained by Vercel Cron hitting `/api/cron/cleanup`. Both use the same claim/backoff/
dead-letter policy (`src/lib/retryBackoff.ts`, `src/lib/queueSweep.ts`); work that
must survive a crash goes in one of them, not in a fire-and-forget promise.

## Verify before claiming done

```bash
npm run lint          # must be clean — it currently is, keep it that way
npm run typecheck     # NOTE: needs `npx next typegen` first, or LayoutProps/PageProps fail
npm test              # most cases need TEST_DATABASE_URL (real PostgreSQL)
```

`npm test` runs every `tests/**/*.test.ts` and `tests/**/*.test.tsx`. The
database-backed suites (`batchCompletion`, `productionLifecycle`,
`reservationMixRevision`, `blob`) refuse to run at all unless
`TEST_DATABASE_URL` is set AND differs from `DATABASE_URL`; the rest
(`offlineQueue`, `releaseRouting`, and the jsdom-rendered `AutoSaveField`/
`RecordActualsForm` suites) run anywhere. Deliberately no test counts here —
they change every round and a stale number is worse than none.

Pure-logic and component changes must still ship a test that runs without a
database.

CI (`.github/workflows/ci.yml`) runs lint → typegen → typecheck → build → migrate →
test **twice against the same database** (proves teardown leaves zero residue).
Don't break the second run.

## Architecture map

| Path | What lives there |
|---|---|
| `src/app/(app)/*/page.tsx` | Server Components. Must call `requirePageAccess(moduleKey)` |
| `src/app/(app)/*/actions.ts` | Server Actions — every mutation in the app |
| `src/app/driver`, `/pump-crew`, `/operator` | Phone-first surfaces, outside the sidebar |
| `src/app/api/*` | Machine-to-machine only (SCADA, telematics, reports, cron, files, push) |
| `src/lib/*` | Domain logic. Business rules live here, not in components |
| `prisma/schema.prisma` | 3,120 lines, heavily commented — read the model comment before changing a model |

UI terminology differs from the schema on purpose: **Site** is shown as "Plant",
**Plant** is shown as "Station". Never rename the Prisma models to match the UI.

## Non-negotiable patterns

These exist already and are used consistently. Reusing them is not optional —
every place that skipped one turned out to be a real bug.

**1. Sequential numbers → `withSequentialNumber` (`src/lib/sequence.ts`)**

Never write `` `PREFIX-${year}-${count+1}` `` by hand. The helper scopes the count to
the calendar year and retries on `P2002`. A plain unscoped `count()` breaks silently
at year rollover. The target column must be `@unique` or the retry never fires.

**2. Site scoping → `isSiteInScope` / `isPlantInScope` (`src/lib/siteScope.ts`)**

Every Server Action that accepts an id or a `siteId` from `FormData` must verify it
against `effectiveSiteId(user)`. The page's own dropdown only lists the caller's site,
but a crafted POST can name any site. `ADMIN` passes automatically (`effectiveSiteId`
returns `null`); every other role is pinned to one site.

**3. Permissions → two layers, both required**

- Page: `await requirePageAccess("moduleKey")` at the top of every Server Component page
- Action: `await requireActionPermission(user, "moduleKey", "actionKey")` first line of every Server Action

New actions need a matching entry in `ACTION_ROLES` (`src/lib/permissions.ts`) or they
silently fall back to `ASSIGNABLE_ROLES`.

**4. Inventory movements → `postSiloMovement` / `postHopperMovement` / `postChemicalTankMovement`**

Never `UPDATE` a silo/hopper/tank level directly. `src/lib/inventoryLedger.ts` does
`SELECT ... FOR UPDATE` → clamped `UPDATE` → `INSERT ... ON CONFLICT DO NOTHING` as an
atomic claim. It also handles shortage authorization and reversal. Bypassing it loses
the ledger row and the concurrency guarantee.

**5. Audit → `writeAudit` inside the transaction, `logAudit` only outside one**

Every write to a priced, weighed, or certified record is audited. Which helper
you use is not a style choice:

- `writeAudit(tx, actor, event)` for any business mutation that must never
  commit without its audit row. It writes through the SAME transaction client,
  so the audit and the mutation succeed or roll back together, and it takes the
  actor explicitly rather than reading the session itself.
- `logAudit(event)` only for standalone/post-commit events where atomicity is
  deliberately not required. It uses the singleton client, so it cannot join a
  caller's transaction — using it for a transactional mutation silently
  reintroduces the "audit row missing for a committed write" class this branch
  spent several rounds removing.

Both resolve a machine write to `SYSTEM`; `logAudit` resolves the actor from the
session, `writeAudit` never does.

**6. Money is currently `Float` — round at write time**

All 153 monetary columns are `Float` (a known defect). Until they become `Decimal`,
round to 2 decimals **when persisting**, never only at display. Unrounded subtotals
break ZATCA XML validation, and residual float dust keeps fully-paid invoices out of
`PAID` forever.

Physical quantities (`volumeM3`, `currentLevelTons`, `actualMassKg`) stay `Float` —
`inventoryLedger.ts` depends on epsilon comparisons. **Money → Decimal, physics → Float.**

## Financial paths need transactions

Anything touching invoices, payments, journal entries, payroll, or ZATCA must run in
`prisma.$transaction` with `isolationLevel: "Serializable"`, and claim its target with
a conditional `updateMany` rather than a read-then-`update`.

The ZATCA hash chain (ICV + PIH) is shared across invoices **and** credit notes per
site, in issuance order. Two documents generated concurrently must never receive the
same ICV — that forks the chain and ZATCA rejects everything after it.

## Database

PostgreSQL does **not** auto-index foreign keys, and Prisma only indexes `@id` and
`@unique`. Any column you filter, join, or sort on needs an explicit `@@index`.
The schema currently has 8 indexes for 96 models — when you touch a model whose rows
are queried by date range plus scope, add the composite index.

Prefer real database constraints (`CHECK`, `ON DELETE RESTRICT`, `@@unique`) over
application-level validation — see `InventoryMovement` in the migrations for the
established style. Hand-write the migration when you need `CHECK` or
`CREATE INDEX CONCURRENTLY`; `prisma migrate diff` won't generate them.

## Style

- Comments explain **why**, not what — including alternatives rejected and bugs found.
  This is the repo's strongest asset. Match it; don't strip it.
- No `any`. `strict` is on.
- Arabic and English dictionaries (`src/lib/i18n/dictionaries/`) must stay key-identical.
- Server Actions used by interactive mutations return a typed action state
  whenever the UI must distinguish success, validation, conflict, terminal,
  authorization-safe not-found, or retryable failure — consumed with
  `useActionState` (see `CompleteBatchForm`, `RecordActualsForm`). Plain
  `void` + `revalidatePath` actions are acceptable only where a failure
  cannot be silently mistaken for success. Returning `void` from an action
  whose refusal the operator needs to see is the exact false-success class
  several review rounds were spent removing.
- Validate `typeof x === "number"` **plus** `Number.isFinite(x)` plus a range —
  `typeof` alone accepts `Infinity` and out-of-range values.

## Known open defects

Documented in the code review; don't reintroduce, and prefer fixing when you're already
in the file:

1. ZATCA chain generation has no transaction or lock — concurrent generation forks the chain
2. Invoice numbering (`billing/actions.ts`) bypasses `withSequentialNumber`
3. All money columns are `Float`
4. `incentives/actions.ts` — all 6 actions lack site-scope checks
5. `employees/actions.ts` — attendance and leave actions lack site-scope checks
6. TOTP codes can be replayed within their window (no used-step tracking)
7. `getClientIp` trusts client-supplied `x-forwarded-for`
8. `anomaly.ts` outlier detection cannot fire below 9 samples (population σ vs 2.5 threshold)
9. `parseNetDays` reads "2/10 Net 30" as 2 days
