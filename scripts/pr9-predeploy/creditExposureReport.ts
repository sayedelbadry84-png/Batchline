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
// READ ONLY transaction would refuse it. Run it against a restored copy of
// production, not the live primary, so no customer write ever waits on it.
//
//   DATABASE_URL=<copy> DIRECT_URL=<copy> npx tsx scripts/pr9-predeploy/creditExposureReport.ts
import { prisma } from "@/lib/prisma";
import { evaluateCustomerCredit, type CreditDecision } from "@/lib/creditPolicy";

class Rollback extends Error {}

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
  const customers = await prisma.customer.findMany({ select: { id: true, code: true, legalName: true }, orderBy: { id: "asc" } });
  const counts = new Map<string, number>();
  console.log(["customerId", "code", "legalName", "limitMinor", "exposureMinor", "flags"].join("\t"));
  for (const c of customers) {
    const d = await evaluate(c.id);
    if (!d) continue;
    const f = flags(d);
    for (const k of f) counts.set(k, (counts.get(k) ?? 0) + 1);
    if (f.length) console.log([c.id, c.code ?? "", c.legalName, d.limitMinor, d.exposureMinor, f.join(",")].join("\t"));
  }
  console.log(`\ncustomers evaluated: ${customers.length}`);
  for (const [k, n] of [...counts].sort()) console.log(`${k}: ${n}`);
}

main()
  .catch((err) => {
    console.error(err);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
