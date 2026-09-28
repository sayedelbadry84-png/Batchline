// Pre-deploy report for PR #9: which customers the new credit policy would
// hold on day one. Prints, per customer, the committed exposure computed by
// the real `evaluateCustomerCredit` against the stored limit, and flags:
//   OVER_LIMIT    exposure already above the limit
//   AT_LIMIT      exposure equal to a positive limit (no further booking fits)
//   NO_LIMIT      limit 0 with any exposure (every booking holds)
//   UNPRICED      an item that cannot be valued (holds the whole customer)
//   MIXED_CURRENCY items in more than one currency (holds)
//
// It changes no data: each evaluation runs in its own transaction, which is
// always rolled back. It is NOT lock-free, though: `readExposure` takes the
// Customer row FOR UPDATE, as every real decision does, so a PostgreSQL
// READ ONLY transaction would refuse it. It therefore runs only against a
// RESTORED COPY of production, never the live primary, and enforces that:
//
// Before any lock is taken, the connected database must hold the marker
// table `pr9_restored_copy_marker` with exactly one row naming this very
// database. The operator creates it on the copy right after restoring it
//   CREATE TABLE pr9_restored_copy_marker (database_name text NOT NULL, snapshot_taken_at timestamptz NOT NULL);
//   INSERT INTO pr9_restored_copy_marker VALUES (current_database(), '<snapshot time>');
// and never on production, so pointing DATABASE_URL at production (or at
// the wrong copy) exits non-zero without touching a row. Any other error
// also exits non-zero.
//
// Output carries customer ids and codes, not names or contact details; keep
// it out of public CI logs all the same.
//
//   DATABASE_URL=<copy> DIRECT_URL=<copy> npx tsx scripts/pr9-predeploy/creditExposureReport.ts
import { prisma } from "@/lib/prisma";
import { evaluateCustomerCredit, type CreditDecision } from "@/lib/creditPolicy";

class Rollback extends Error {}

async function assertRestoredCopy(): Promise<{ database: string; snapshotTakenAt: string }> {
  const [{ database }] = await prisma.$queryRaw<{ database: string }[]>`SELECT current_database() AS database`;
  const [{ present }] = await prisma.$queryRaw<{ present: boolean }[]>`SELECT to_regclass('public.pr9_restored_copy_marker') IS NOT NULL AS present`;
  if (!present) throw new Error(`refusing to run: database "${database}" has no pr9_restored_copy_marker table, so it is not a marked restored copy`);
  const marks = await prisma.$queryRaw<{ database_name: string; snapshot_taken_at: Date }[]>`SELECT database_name, snapshot_taken_at FROM pr9_restored_copy_marker`;
  if (marks.length !== 1 || marks[0].database_name !== database) {
    throw new Error(`refusing to run: pr9_restored_copy_marker must hold exactly one row naming "${database}"`);
  }
  return { database, snapshotTakenAt: marks[0].snapshot_taken_at.toISOString() };
}

async function evaluate(customerId: string): Promise<CreditDecision | null> {
  let decision: CreditDecision | null = null;
  try {
    await prisma.$transaction(async (tx) => {
      decision = await evaluateCustomerCredit(tx, customerId);
      throw new Rollback();
    });
  } catch (err) {
    if (!(err instanceof Rollback)) throw err;
  }
  return decision;
}

function flags(d: CreditDecision): string[] {
  const out: string[] = [];
  if (d.unpriced) out.push("UNPRICED");
  if (d.mixedCurrency) out.push("MIXED_CURRENCY");
  if (d.limitMinor <= 0 && d.exposureMinor > 0) out.push("NO_LIMIT");
  else if (d.exposureMinor > d.limitMinor) out.push("OVER_LIMIT");
  else if (d.limitMinor > 0 && d.exposureMinor === d.limitMinor) out.push("AT_LIMIT");
  return out;
}

async function main() {
  const target = await assertRestoredCopy();
  console.log(`database: ${target.database}  snapshot: ${target.snapshotTakenAt}  run: ${new Date().toISOString()}`);
  const customers = await prisma.customer.findMany({ select: { id: true, code: true }, orderBy: { id: "asc" } });
  const counts = new Map<string, number>();
  console.log(["customerId", "code", "limitMinor", "exposureMinor", "flags"].join("\t"));
  for (const c of customers) {
    const d = await evaluate(c.id);
    if (!d) continue;
    const f = flags(d);
    for (const k of f) counts.set(k, (counts.get(k) ?? 0) + 1);
    if (f.length) console.log([c.id, c.code ?? "", d.limitMinor, d.exposureMinor, f.join(",")].join("\t"));
  }
  console.log(`\ncustomers evaluated: ${customers.length}`);
  for (const [k, n] of [...counts].sort()) console.log(`${k}: ${n}`);
}

main()
  .catch((err) => {
    console.error(err instanceof Error ? err.message : err);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
