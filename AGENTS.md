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

**2. Site scoping → the predicate goes INSIDE the query (`src/lib/siteScope.ts`)**

Every Server Action that accepts an id or a `siteId` from `FormData`, and every page
that loads a record by route parameter, must scope it against `effectiveSiteId(user)`.
The page's own dropdown only lists the caller's site, but a crafted POST or URL can
name any of them. `ADMIN` passes automatically (`effectiveSiteId` returns `null`);
every other role is pinned to one site.

Reads use `findFirst` with `plantScopeWhere` / `siteScopeWhere` / `reservationSiteScopeWhere`
folded into the `where`, never `findUnique` by raw id — so an out-of-scope record is
indistinguishable from a nonexistent one. Writes put the same predicate in a conditional
`updateMany` and check `count`, never a read-then-`update`: a separate pre-read is both
a race and, if it produces a distinguishable refusal, a confirmation that the record
exists. `isSiteInScope`/`isPlantInScope` remain the right tool for a `siteId` submitted
in a form, not for authorizing a record id.

The offline queue is partitioned by signed-in identity (`queueFor` in
`src/lib/offlineQueue.ts`) for the same reason on the client: a shared tablet must never
replay one operator's unsent readings under the next one's session.

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

**7. Dates are formatted through `src/lib/datetime.ts` — never `toLocale*`**

`new Date(x).toLocaleString()` formats in the *runtime's* zone: UTC in a Server
Component on Vercel, the operator's device in a Client Component. Cairo and Riyadh
are UTC+2/+3, so every server-rendered timestamp read two or three hours early, and
a night-shift load was dated to the wrong day.

The right zone is the **plant's**, not the viewer's — a load discharged at 14:30
plant time is 14:30 on the delivery note wherever it is read. `Plant.timezone`
already existed and was already audited; nothing rendered it until now.

- Server Component: `const dt = await getDateFormatters();` (`@/lib/displayTimeZone`,
  memoized per request), then `dt.date` / `dt.dateTime` / `dt.time` / `dt.dayTime`,
  or `dt.with(value, options)` for a one-off shape.
- Client Component: take `timeZone: string` as a prop and call
  `createDateFormatters(timeZone)`. Never pass the `dt` bundle across the boundary —
  its fields are functions, which are not serializable (see commit 5776765).
- Nullish and unparseable values already render as `—`; don't re-add a guard.

Locale is pinned to `en-GB` (day-first, 24h) rather than the UI language: these
values sit in `font-mono tabular` cells marked `dir="ltr"`, which the Arabic
locale's Arabic-Indic digits break. `tests/datetime.test.ts` fails the build if any
`src/` file formats a date with `toLocale*` directly.

`Number.prototype.toLocaleString` is a different method that shares the name — it
formats money and is deliberately out of scope here (see the `Float` rule above).

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
When you touch a model whose rows are queried by date range plus scope, add the
composite index — and put the equality columns first and the range column last, or
the range stops the columns after it being usable as index quals.

Every `@@index` is asserted to exist with the declared columns, in order, by
`tests/indexCoverage.test.ts`. That test also EXPLAINs the report layer's real query
shapes against seeded volume and fails if the planner does not choose the intended
index — add a case there when you add an index, rather than assuming one helps.

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

Verified against the code on 2026-09-12. **Re-verify before acting on any
entry** — four of the nine previously listed here had already been fixed
by other branches, and an agent that trusts this list instead of the code
will re-investigate closed work or "re-fix" something that is already
right.

1. All money columns are `Float` (see the money rule above). `parseMoneyInput`
   in `src/lib/money.ts` bounds what can enter the ledger; the `Decimal`
   migration is still the durable fix.
2. Foreign keys are still largely unindexed (~178 relations), by choice.
   The reporting layer's own shapes are now covered: fourteen composite
   indexes added 2026-09-12 from the queries in `src/lib/reportQueries.ts`
   and the driver screen, each with a planner assertion in
   `tests/indexCoverage.test.ts`. What remains uncovered is the long tail
   of FKs no measured query filters on — add those the same way, from a
   real shape with `EXPLAIN` evidence, never 178 single-column ones blindly.
3. SCADA/telematics payloads carry no device timestamp, sequence or
   idempotency key, so a delayed old reading can overwrite a newer one,
   and neither route is rate limited. `lastUsedAt` is no longer written
   per request.
4. No `script-src`/`style-src` CSP — it needs a per-request nonce and
   there is no middleware; the root layout's inline accent `<style>` is
   the specific blocker. See the comment in `next.config.ts`.
5. ~~`reports/page.tsx` is one ~2,600-line page function.~~ Split
   2026-09-12: the page is now 315 lines that parse the filters, fetch
   the open tab's data and dispatch to `./tabs/<Name>Tab.tsx` (one file
   per tab, twenty-five of them). Data layers went to `./overviewReport.ts`
   and `./incentivesReport.ts`, shared vocabulary to `./reportUi.tsx`.
   Add a tab by adding a file there, not by growing the page.
6. The printable delivery note, purchase order and quotation are editable
   working copies, declared as such on the page and the print-out; they
   are NOT controlled documents backed by a versioned record.
7. No browser E2E suite, so the shared-tablet sign-in/sign-out scenario is
   proved only at the unit level. A `playwright-testing` skill is installed.
8. The push-subscription button reconciles a failed server registration,
   but on mount a pre-existing local subscription still reports "enabled"
   without asking the server whether it is registered.

Fixed since earlier revisions of this list — **do not re-report**: ZATCA
chain generation (now Serializable with a site row lock), invoice
numbering (now uses `withSequentialNumber`), `getClientIp` (see
`src/lib/clientIp.ts`), `parseNetDays`, `anomaly.ts` detection,
`incentives/actions.ts` and `employees/actions.ts` site scoping, and TOTP
replay within a window.
