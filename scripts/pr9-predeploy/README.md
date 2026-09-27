# PR #9 pre-deploy runbook

PR #9 turns on the credit policy and adds two migrations:

- `20260925120000_customer_credit_limit_check`: a CHECK on `Customer.creditLimit`.
- `20260925130000_customer_credit_limit_request`: the new `CustomerCreditLimitRequest` table.

None of this has been run against production, and every step needs the
owner's go-ahead. This runbook is not approved for execution until it
passes independent review.

## Why the order matters

A merge to `main` deploys to Vercel **Production** straight away, and the
deploy does not migrate:

- The Git integration deployed the merge of #10 (`b1ad449`) to production for
  two projects, recorded as the GitHub deployments `Production – batchline`
  and `Production – batchline-g7p3`.
- The build (`next build`, with `postinstall: prisma generate`) runs no
  migration.
- `prisma migrate deploy` in `.github/workflows/ci.yml` touches only CI's
  throwaway database.

Merging #9 first would therefore ship code that reads `CustomerCreditLimitRequest`
before that table exists. The Customers page and every credit-limit request
would fail.

## Steps

Run them in this order. Step 6 does not start until steps 2 to 5 are complete and signed off.

1. **Identify every production database and back it up.**
   - Fill in the table below from Vercel's project settings and the database
     provider. Use non-secret identifiers only, never passwords or connection
     strings.
   - If the two projects use different databases, every step below is done
     for **each** one. If they share one database, it is migrated **once**.
   - Until this table is filled in, the deploy gate stays closed.
   - Take a backup or snapshot of each database and record its time.

   | Vercel project | Serves real users? | Database (provider / name / id) | Backup taken at |
   |---|---|---|---|
   | `batchline` | ? | ? | ? |
   | `batchline-g7p3` | ? | ? | ? |

2. **Read-only checks on each production database.** Run:

   ```
   psql -X -v ON_ERROR_STOP=1 -f scripts/pr9-predeploy/preflight_readonly.sql "<db>" > preflight-<db>.txt
   echo $?   # must be 0
   ```

   - Everything runs inside a `READ ONLY` transaction that is rolled back. The
     file also sets `ON_ERROR_STOP` itself, so any failed query exits non-zero
     (3) instead of ending in a harmless-looking `ROLLBACK`.
   - The first block prints the database, server and time. Keep that with the
     results.
   - **Q0 is a real blocker.** It lists the limits that stop the first
     migration, and each row needs the owner's decision before step 6.
   - **Q1 to Q5 are candidates to examine, not a list of broken customers or
     rows to fix.** They are deliberately broad:
     - Q1 and Q3 can include a booking that has already been released in
       full, which no longer counts.
     - Q2 can include a price that no booking or ticket uses.
     - Q4 over-reports: it counts settled invoices, which the policy ignores.
     - Q5 includes inactive bookings.

     Step 4 settles which of them the policy would actually hold.
   - Q6 counts the customers at a limit of 0.
   - The output carries ids and codes, not names. Keep it out of public CI logs.

3. **Restore a separate copy of each database, and migrate the copy.**
   - Right after restoring, mark the copy. The report in step 4 refuses to run
     anywhere else:

     ```sql
     CREATE TABLE pr9_restored_copy_marker (database_name text NOT NULL, snapshot_taken_at timestamptz NOT NULL);
     INSERT INTO pr9_restored_copy_marker VALUES (current_database(), '<snapshot time>');
     ```

   - Then run `npx prisma migrate deploy` against the copy.
   - If Q0 found rows, the first migration stops with `P3018` and names them.
     This is the rehearsal of the fix with the real data: apply the owner's
     decision for those rows **on the copy**, run
     `npx prisma migrate resolve --rolled-back 20260925120000_customer_credit_limit_check`,
     and deploy again.

4. **Exposure report on the migrated copy.** Run:

   ```
   DATABASE_URL="<copy>" DIRECT_URL="<copy>" npx tsx scripts/pr9-predeploy/creditExposureReport.ts > exposure-<db>.txt
   echo $?   # must be 0
   ```

   - It flags every customer the policy would hold on day one: `OVER_LIMIT`,
     `AT_LIMIT`, `NO_LIMIT`, `UNPRICED` or `MIXED_CURRENCY`.
   - It writes nothing; every evaluation is rolled back.
   - It does lock `Customer` rows `FOR UPDATE`, like a real decision. That is
     why it exits 1 without touching a row unless the marker names the
     connected database.
   - The report, not Q1 to Q5, says who would be held. For each flagged
     customer, record the owner's decision based on the actual exposure and
     the operational state of the items behind it.
   - A row that appears only in Q1 to Q5, but that the report does not flag
     and that nothing active depends on, needs no change. Do not alter sound
     historical data because a broad query listed it.
   - Never repair prices or limits silently.

5. **Sign-off.** The following are recorded before step 6:
   - the owner's remediation decisions;
   - a GitHub approval of #9's final head by a qualified reviewer, or the
     owner's documented exception with its reason;
   - the time window;
   - the rollback plan below;
   - who runs step 6;
   - who runs the step 7 check, and whether a test customer exists for it.

6. **Migrate each production database identified in step 1.**
   - First apply any Q0 corrections the owner decided, through a reviewed and
     audited path.
   - Then run `npx prisma migrate deploy`.
   - Verify both migrations are in `_prisma_migrations` with `finished_at` set,
     that `Customer_creditLimit_check` exists, and that the
     `CustomerCreditLimitRequest` table exists.
   - `main`'s code, which is still live at this point, keeps working. See the
     rehearsal below.

7. **Merge #9.**
   - Watch both production deployments until they are ready.
   - Then run a controlled post-deploy check on each project that serves
     users. **Do not create a test booking in production** unless an
     authorized test customer and project have been agreed in step 5 with
     their cleanup: a real booking consumes credit headroom, can reserve
     equipment, and writes audit rows that cannot be deleted.
   - By default the check is read-only or harmless:
     - the Customers page loads;
     - the request queue renders for an ADMIN;
     - a known over-limit customer from the step 4 report shows as held.
   - A real operational booking is then watched with the operations team's
     agreement.
   - Step 5 names who runs this check and how any effect of it is reversed.

## Rollback

**The default rollback is the application only.** Promote the previous
production deployment in Vercel, and keep the table, the CHECK and the
migration records:

- Both migrations are expand-only.
- `main`'s code runs on the migrated schema (rehearsed, below).
- `prisma migrate status` from `main` reports "Database schema is up to
  date!", and `migrate deploy` reports "No pending migrations".
- Redeploying #9 later needs no schema step.

While the application is rolled back:

- The approval-only rule is suspended: `main`'s customer form writes
  `creditLimit` directly again. The CHECK still refuses negative values,
  and Prisma refuses `NaN` and `Infinity`.
- A request left PENDING cannot be decided until #9 is back. When the limit
  was changed in the meantime, deciding it then marks it STALE rather than
  applying a baseline that no longer holds (rehearsed).

`destructive_schema_rollback_pr9.sql` is **not** part of a rollback. It drops
the table and the CHECK, and deletes the two migration records:

- It is for the owner's separate decision only.
- It runs only after **both** Vercel production projects (`batchline` and
  `batchline-g7p3`) are rolled back to a build that does not use the table,
  and no request from #9's build is still in flight.
- It refuses to run while `CustomerCreditLimitRequest` holds any row.
  Dropping real requests and decisions is not a rollback. Keeping them would
  need its own reviewed and rehearsed plan.
- The check and the drop are atomic:
  - it takes `LOCK TABLE … IN ACCESS EXCLUSIVE MODE` before counting, so a
    request inserted concurrently is either counted or kept out until the
    drop has committed;
  - `lock_timeout` is 10 s: rather than queue behind live traffic, it stops
    with exit 3 and changes nothing.

## Rehearsals (local PostgreSQL 16, 2026-09-27)

These ran on synthetic data. They are **not** evidence about production data
or about the databases behind the Vercel projects.

### Migrations with invalid limits

- A database was migrated with `main`'s 51 migrations and given customers
  with limits `5000`, `-1`, `Infinity` and `NaN`.
- `migrate deploy` stopped at `20260925120000` with `P3018`, naming exactly
  the three invalid rows. No constraint and no table were created.
- After correcting the rows and running `migrate resolve --rolled-back`, both
  migrations applied.

### Application-only rollback with real requests

The database had all 53 migrations. Using #9's code:

- one request was APPROVED, raising `c_a` from 1000 to 5000;
- one was left PENDING, for `c_b` from 1000 to 3000.

`main`'s Prisma client, generated from `main`'s schema, then ran:

- the Customers list and a create;
- the old form's direct update of `c_b` to 2000;
- a `-5` limit, refused by `Customer_creditLimit_check`;
- `NaN` and `Infinity` limits, refused by Prisma validation.

Both requests were still there with their statuses unchanged. With #9's code
back, deciding the pending request returned `STALE`, the limit stayed 2000,
and a new request was accepted.

### Guards

- **Exposure report:** it exited 1 with no marker table, and exited 1 with a
  marker naming another database. With a valid marker it flagged `c_b`
  `OVER_LIMIT` (250000 against 200000 minor units) and left no row lock.
- **Preflight:** it exited 0 on `main`'s schema. It exited 3 at Q2 on a
  database whose `pricePerM3` column was renamed, when run **without** the
  `-v ON_ERROR_STOP=1` flag.
- **Destructive rollback:**
  - It exited 3 and dropped nothing while the table held three requests.
  - On an empty table it removed the table and both records, leaving 51
    migrations.
- **Destructive rollback, concurrent insert.** A request `INSERT` was open,
  not yet committed, when the script started, and committed about 2 s later
  while the script ran.
  - The version before the lock (`5f7912d`) counted zero, then its
    `DROP TABLE` waited for the insert and dropped it with the table. The
    request was lost: exit 0, table gone, 51 migrations.
  - The fixed version's `LOCK TABLE` waited for the insert, counted 1 row
    and refused: exit 3, the table and its row kept, 53 migrations.
- **Destructive rollback, table held by live traffic.** A transaction that
  read the table and stayed open for 14 s made the script stop at
  `lock_timeout` with exit 3, changing nothing.
