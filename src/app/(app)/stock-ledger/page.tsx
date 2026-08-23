import Link from "next/link";
import { prisma } from "@/lib/prisma";
import { ui } from "@/lib/ui";
import { requirePageAccess } from "@/lib/session";
import { getDictionary } from "@/lib/i18n";
import { effectiveSiteId, plantScopeWhere } from "@/lib/siteScope";

export default async function StockLedgerPage() {
  const user = await requirePageAccess("stockLedger");
  const { dict } = await getDictionary();
  const m = dict.modules.stockLedger;
  const siteId = effectiveSiteId(user);

  const [materials, receipts, actuals] = await Promise.all([
    // Material is a global catalog (like MixDesign) — only the stock
    // movements (receipts/consumption) are site-specific.
    prisma.material.findMany({ orderBy: [{ type: "asc" }, { name: "asc" }] }),
    prisma.materialReceipt.findMany({
      where: { postedToInventory: true, ...plantScopeWhere(siteId) },
      select: { materialId: true, netWeightKg: true },
    }),
    prisma.batchComponentActual.findMany({
      where: { batchTicket: { status: "COMPLETE", ...plantScopeWhere(siteId) } },
      select: { materialId: true, actualMassKg: true, targetMassKg: true },
    }),
  ]);

  const inKg = new Map<string, number>();
  for (const r of receipts) inKg.set(r.materialId, (inKg.get(r.materialId) ?? 0) + r.netWeightKg);

  const outKg = new Map<string, number>();
  for (const a of actuals) {
    const mass = a.actualMassKg ?? a.targetMassKg;
    outKg.set(a.materialId, (outKg.get(a.materialId) ?? 0) + mass);
  }

  return (
    <div className="flex flex-col gap-8">
      <header>
        <div className={ui.eyebrow}>{m.eyebrow}</div>
        <h1 className={ui.h1}>{m.title}</h1>
        <p className={ui.intro}>{m.intro}</p>
      </header>

      <div className={ui.card}>
        <table className={ui.table}>
          <thead>
            <tr>
              <th className={ui.th}>{m.col.material}</th>
              <th className={ui.th}>{m.col.type}</th>
              <th className={ui.th}>{m.col.received}</th>
              <th className={ui.th}>{m.col.consumed}</th>
              <th className={ui.th}>{m.col.balance}</th>
              <th className={ui.th}>{dict.field.actions}</th>
            </tr>
          </thead>
          <tbody>
            {materials.map((mat) => {
              const received = inKg.get(mat.id) ?? 0;
              const consumed = outKg.get(mat.id) ?? 0;
              const balance = received - consumed;
              return (
                <tr key={mat.id}>
                  <td className={`${ui.td} font-medium`}>
                    {mat.name}
                    {mat.brand && <span className="ms-2 text-xs text-ink-muted" dir="ltr">({mat.brand})</span>}
                  </td>
                  <td className={ui.td}>{dict.materialTypes[mat.type as keyof typeof dict.materialTypes] ?? mat.type}</td>
                  <td className={`${ui.td} font-mono tabular`} dir="ltr">{received.toLocaleString()} kg</td>
                  <td className={`${ui.td} font-mono tabular`} dir="ltr">{consumed.toLocaleString()} kg</td>
                  <td className={`${ui.td} font-mono tabular font-semibold ${balance < 0 ? "text-critical" : ""}`} dir="ltr">
                    {balance.toLocaleString()} kg
                  </td>
                  <td className={ui.td}>
                    <Link href={`/stock-ledger/${mat.id}`} className="text-xs font-medium text-accent-strong hover:underline">
                      {m.viewLedger}
                    </Link>
                  </td>
                </tr>
              );
            })}
            {materials.length === 0 && (
              <tr>
                <td className={ui.td} colSpan={6}>
                  <span className="text-ink-muted">{m.empty}</span>
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
}
