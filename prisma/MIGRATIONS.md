# Migration runbook

This project uses `prisma migrate` with a real migration history under `prisma/migrations/` — never `prisma db push` against a database anyone depends on. `DATABASE_URL` is the pooled (PgBouncer) Neon connection used at runtime; `DIRECT_URL` is the unpooled connection the Prisma CLI needs for `migrate`/`generate`.

## Clean installation (new, empty database)

```bash
npx prisma migrate deploy
npx prisma generate
```

Applies every migration in `prisma/migrations/` in order, from the baseline forward. No seed step is part of this — `prisma/seed.ts` is a separate, explicit step you run only when you actually want sample data.

## Existing database (deploying a new migration)

1. Write/change `prisma/schema.prisma`.
2. Generate the SQL for just the new change — do **not** hand-write migration.sql, and do not run `prisma migrate dev` here (it needs an interactive shadow-database prompt this environment doesn't have):
   ```bash
   npx prisma migrate diff --from-url "$DIRECT_URL" --to-schema-datamodel prisma/schema.prisma --script > migration.sql 2> migration.stderr.log
   ```
   Redirect stdout and stderr to **separate** files — a combined redirect has previously corrupted the SQL file with an interleaved CLI notice (an "update available" banner) that broke the shadow-database apply. Check `migration.stderr.log` is empty, then review `migration.sql` before doing anything else.
3. Move it into a timestamped folder: `prisma/migrations/<YYYYMMDDHHMMSS>_<short_name>/migration.sql`.
4. Apply it: `npx prisma migrate deploy`, then `npx prisma migrate status` to confirm a clean "up to date," then `npx prisma generate`.
5. If `prisma generate` fails with `EPERM ... query_engine-windows.dll.node`, a running dev server has the engine DLL locked — stop it first, then retry.

## Preflight for migrations that add a constraint to an existing table

CI only ever applies migrations to an **empty** database, so a green CI run is
evidence that a migration *installs*, never that it *upgrades*. Any migration
that adds a `UNIQUE`/`CHECK` constraint to a table that already holds rows can
still abort part-way through `prisma migrate deploy` against a populated
database, with a raw Postgres violation rather than anything actionable.

Before deploying such a migration to a database with real rows:

1. **Rehearse first.** Branch the real database in Neon, apply migrations up to
   (but not including) the constraint migration, insert deliberate duplicates,
   then run steps 2–5 end to end on that branch. Only proceed once the rehearsal
   ends with the constraint built and the data as expected.
2. **Open a maintenance window** that stops the writers which can create the
   conflicting rows, and keep it open until the constraint exists. For
   `PendingAutoRequisition` the only writer is `stageAutoRequisitionIntent`,
   which runs inside batch completion — so no batch may be completed between the
   cleanup and the end of `prisma migrate deploy`. Without this, the application
   can re-create a duplicate in the gap and the index build still fails
   (PL-R13-P1-02).
3. Run the `*_detect.sql` script and **retain its output with the deployment
   record**. It is read-only.
4. If (and only if) it reported conflicts, run the matching `*_remediate.sql`.
   It takes a `SHARE ROW EXCLUSIVE` lock, applies the documented merge policy,
   and **asserts in SQL** that no duplicate group survives — raising and rolling
   back if one does, rather than committing and reporting success.
5. Re-run `*_detect.sql` (expect zero rows), then `npx prisma migrate deploy`,
   then close the window.

Preflight scripts must only reference columns that exist on the schema version
they run against — the version *before* the migration they guard. The first
version of the script below sorted on `requisitionId`/`notificationDeliveredAt`,
which are added by that migration and a later one, so it could not run on the
only database that would ever need it.

Current preflights:

| Migration | Constraint | Detect | Remediate |
|---|---|---|---|
| `20260908060000_harden_production_lifecycle_round10` | `PendingAutoRequisition_batchTicketId_materialId_siteId_key` | `prisma/preflight/pending_auto_requisition_uniqueness_detect.sql` | `prisma/preflight/pending_auto_requisition_uniqueness_remediate.sql` |

The migration itself is deliberately **not** edited to include the preflight:
Prisma checksums applied migrations, so changing one that any database has
already applied breaks `migrate status`/`deploy` for that database (see Hard
rules below). The preflight is a deployment step, not a schema step.

## Staging verification

There is currently only one Postgres database configured for this project (the Neon instance behind `DATABASE_URL`/`DIRECT_URL`) — there is no separate staging database today. Until one exists, treat every migration as going straight to the database real usage depends on: review the generated SQL by hand before applying (step 2 above), and prefer additive changes (new nullable columns, new tables) over anything that rewrites or drops existing data. A genuine staging environment should be a separate Neon branch (or project) with its own `DATABASE_URL`/`DIRECT_URL`, migrated first, before repeating the same `migrate deploy` against the real one.

## Drift detection

```bash
npx prisma migrate status
```

Reports whether the database's applied-migrations table matches what's on disk. If it reports drift (a migration applied out-of-band, or a local migration never applied), stop and investigate before running anything else — do not run `migrate reset` or `db push` to "fix" it; both are destructive or bypass history. `npx prisma migrate diff --from-url "$DIRECT_URL" --to-schema-datamodel prisma/schema.prisma --script` (without applying it) shows exactly what's different.

## Backup and rollback

Neon (the Postgres provider this project uses) keeps continuous point-in-time recovery — the real rollback path for a bad migration is a PITR restore from the Neon console/API to a timestamp just before the migration ran, not a hand-written "down" migration (none are maintained here). Before applying a migration that touches existing data (not just adding a nullable column or a new table), note the current time so a PITR target is easy to pick if needed. For a schema-only mistake with no data impact yet, a corrective forward migration (dropping/renaming back) is simpler and safer than a restore.

## Hard rules

- Never run `prisma migrate reset`, `prisma db push`, or `prisma db seed` against a database this project actually depends on (dev or production) — both `reset` and `push` can silently drop and recreate data.
- Never hand-edit an already-applied migration's `migration.sql` — Prisma checksums it; edit forward with a new migration instead.
- If the deployed database's actual state can't be determined (e.g. `migrate status` reports drift you can't explain), stop and report it rather than guessing a baseline or forcing a migration through.

## Index migrations and `CREATE INDEX CONCURRENTLY`

A plain `CREATE INDEX` takes a `SHARE` lock: reads continue, **writes to
that table block for the whole build**. On `AuditEvent` — which takes a
row for every SCADA reading, every telematics ping and every audited
mutation — that stalls the application, so index builds on it use
`CONCURRENTLY`.

Postgres refuses `CREATE INDEX CONCURRENTLY` inside a transaction block,
which raises the question of whether Prisma wraps a migration in one.
**Neither blanket answer is right.** The reported behaviour is that Prisma
wraps a migration file only when it contains more than one statement; a
single-statement file is sent as-is. That is a behaviour, not a documented
guarantee, and it has changed across versions — so:

- **one statement per migration file** when using `CONCURRENTLY`, with no
  comments in the file, so nothing can be counted as a second statement;
- the four `20260910120000`–`20260910120003` index migrations follow this,
  and CI applies them to a real PostgreSQL 16 on every run. **That CI step
  is the rehearsal**: if this Prisma version wrapped them, the migration
  would fail with `CREATE INDEX CONCURRENTLY cannot run inside a
  transaction block` and the run would go red. A green run is evidence for
  this exact `prisma@5.22.x` + PostgreSQL 16 pairing and nothing broader —
  re-check it after any Prisma upgrade.

Before running these against a large production table:

1. Record row count and table size (`pg_total_relation_size`).
2. Capture `EXPLAIN (ANALYZE, BUFFERS)` for the audit-log list (unfiltered
   and module-filtered) and for session revocation by `userId`, so the
   improvement is measured rather than assumed.
3. Set a `lock_timeout` for the session running the deploy, and agree an
   abort criterion in advance.
4. A failed `CONCURRENTLY` build leaves an **INVALID** index behind, and
   `IF NOT EXISTS` will then happily skip re-creating it. Check for that
   before and after:

   ```sql
   SELECT c.relname, i.indisvalid
   FROM pg_class c JOIN pg_index i ON i.indexrelid = c.oid
   WHERE c.relname IN ('AuditEvent_createdAt_idx', 'AuditEvent_module_createdAt_idx',
                       'Session_userId_idx', 'Session_expiresAt_idx');
   ```

   Drop any row with `indisvalid = false`.

   **Then reconcile Prisma's own history before retrying** (PR4-R5-P2-02).
   A migration that failed mid-deploy is recorded as failed in
   `_prisma_migrations`, and `migrate deploy` refuses to move past it. Do
   not delete the row by hand:

   ```bash
   npx prisma migrate resolve --rolled-back 20260910120000_index_audit_event_created_at
   npx prisma migrate deploy
   ```

   Use the exact directory name of the migration that failed. Confirm
   `npx prisma migrate status` reports no failed migration before
   deploying again, and abort the window if it still does — a half-applied
   index chain is a state to stop and think about, not to retry blindly.

5. Verify all four exist and are valid afterwards with the same query.

## Migration lineage on a persistent database

PR4-R5-P2-01. CI always starts from an empty database, so a green run
proves the chain applies **from zero** — never that it upgrades cleanly
from a database that already has history. Before deploying to any
persistent target (production, staging, a long-lived preview):

```sql
SELECT migration_name, finished_at, rolled_back_at
FROM _prisma_migrations
ORDER BY started_at;
```

Compare that list against `prisma/migrations/`. In particular, this branch
**replaced** `20260910120000_index_audit_and_session_lookups` with four
separately named migrations. If the old name appears in a target's
`_prisma_migrations`, `migrate deploy` will see a name it no longer has
and the four new ones it has never applied, while the indexes themselves
may already exist. Do not run it blind: decide the forward plan
explicitly, rehearse it on a copy of that database, and only then deploy.
If the old name is absent — which is the expected case, since it was only
ever applied in CI — the new chain proceeds normally.
