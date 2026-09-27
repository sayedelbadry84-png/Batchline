# PR #9 pre-deploy runbook

PR #9 turns on the credit policy and adds two migrations. Nothing here has
been run against production; every step below needs the owner's go-ahead.

## Why the order matters

A merge to `main` deploys to Vercel **Production** straight away. The Git
integration did so for the merge of #10 (`b1ad449`, GitHub deployments
`Production – batchline` and `Production – batchline-g7p3`, 2026-09-27).
The build (`next build`, with `postinstall: prisma generate`) does **not**
run migrations. `prisma migrate deploy` in `.github/workflows/ci.yml` runs
only against CI's throwaway test database.

Merging #9 before its migrations are on production would therefore ship code
that reads `CustomerCreditLimitRequest` while that table does not exist. The
Customers page and every credit-limit request would fail. So:

1. **Read-only checks** (`preflight_readonly.sql`, on production or a fresh copy)
   - Every statement runs inside `BEGIN TRANSACTION READ ONLY … ROLLBACK`.
   - All of them run against the schema as it is on `main` today.
   - The owner decides what happens to each row found. Do not repair prices
     or limits silently.
   - Q0 lists the rows that stop migration `20260925120000`.
2. **Exposure report** (`creditExposureReport.ts`, on a restored **copy** of
   production, after step 3 has been applied to that copy)
   - It shows which customers the policy would hold on day one: over the
     limit, at the limit, at a limit of 0 with exposure, unpriced, or in mixed
     currencies.
   - It writes nothing; every evaluation is rolled back.
   - It does take the `Customer` row `FOR UPDATE`, like every real decision.
     That is why it runs on a copy and not on the live primary.
3. **Migrations on production** (`npx prisma migrate deploy`), **before** the
   merge.
   - Both migrations are expand-only: a CHECK that only rejects invalid
     limits, and a new table.
   - The code currently on `main` keeps working on the migrated schema. The
     rehearsal below shows old-code writes of valid limits still succeed.
4. **Merge #9.** Vercel then deploys the code that uses the new schema.

## Rehearsal (local PostgreSQL 16, 2026-09-27)

The rehearsal database was migrated with `main`'s 51 migrations, then given
customers with limits `5000`, `-1`, `Infinity` and `NaN`.

- `migrate deploy` stopped at `20260925120000` with `P3018`. The error listed
  exactly `c_neg (-1), c_inf (Infinity), c_nan (NaN)`.
  - No constraint was added and no table was created.
  - The migration was recorded as failed.
- The invalid rows were corrected (a stand-in for the owner's decision), and
  `prisma migrate resolve --rolled-back 20260925120000_customer_credit_limit_check`
  was run.
  - `migrate deploy` then applied both migrations.
  - Writing `NaN` to a limit was refused by `Customer_creditLimit_check`.
  - Writing a valid limit, as `main`'s code does, still succeeded.
- The exposure report was run with a SAR 8000.01 issued invoice against a
  7000 limit, and a SAR 10 invoice against a 0 limit.
  - The first printed `OVER_LIMIT` (800001 / 700000 minor units).
  - The second printed `NO_LIMIT`.
- `rollback_pr9.sql` returned the schema to `main`'s state:
  - the table and the constraint were gone;
  - 51 migrations were recorded;
  - `prisma migrate status` on `main` reported "up to date";
  - `migrate deploy` then re-applied both migrations cleanly.

## Rollback

1. Roll the Vercel deployment back to the previous production build.
2. Then run `rollback_pr9.sql`, in that order, because the new code cannot
   run without the table.
   - Dropping `CustomerCreditLimitRequest` discards the request and decision
     history, so export that table first.
   - The `AuditEvent` rows for those decisions remain.
