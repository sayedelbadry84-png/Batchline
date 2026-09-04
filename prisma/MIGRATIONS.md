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
