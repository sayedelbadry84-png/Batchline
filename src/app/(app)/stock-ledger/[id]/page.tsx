import { notFound } from "next/navigation";
import Link from "next/link";
import { prisma } from "@/lib/prisma";
import { ui } from "@/lib/ui";
import { requirePageAccess } from "@/lib/session";
import { getDictionary } from "@/lib/i18n";
import { buildStockLedger } from "@/lib/stock-ledger";

export default async function StockLedgerDetailPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  await requirePageAccess("stockLedger");
  const { id } = await params;
  const { dict } = await getDictionary();
  const m = dict.modules.stockLedger;

  const material = await prisma.material.findUnique({ where: { id } });
  if (!material) notFound();

  const [receipts, actuals] = await Promise.all([
    prisma.materialReceipt.findMany({
      where: { materialId: id, postedToInventory: true },
      include: { supplier: true },
      orderBy: { receivedAt: "asc" },
    }),
    prisma.batchComponentActual.findMany({
      where: { materialId: id, batchTicket: { status: "COMPLETE" } },
      include: { batchTicket: true },
    }),
  ]);

  const ledger = buildStockLedger(
    receipts.map((r) => ({
      receivedAt: r.receivedAt,
      netWeightKg: r.netWeightKg,
      poNumber: r.poNumber,
      supplierName: r.supplier.name,
    })),
    actuals.map((a) => ({
      date: a.batchTicket.batchCompletedAt ?? a.batchTicket.releasedAt,
      ticketNumber: a.batchTicket.ticketNumber,
      massKg: a.actualMassKg ?? a.targetMassKg,
    })),
  );

  return (
    <div className="flex flex-col gap-8">
      <header className="flex items-start justify-between">
        <div>
          <div className={ui.eyebrow}>{m.eyebrow}</div>
          <h1 className={ui.h1}>
            {material.name}
            {material.brand && <span className="ms-2 text-lg text-ink-muted" dir="ltr">({material.brand})</span>}
          </h1>
          <p className={ui.intro}>
            {dict.materialTypes[material.type as keyof typeof dict.materialTypes] ?? material.type}
          </p>
        </div>
        <Link href="/stock-ledger" className="rounded-md border border-border px-4 py-2 text-sm hover:bg-surface-alt">
          {m.back}
        </Link>
      </header>

      <div className={ui.card}>
        <table className={ui.table}>
          <thead>
            <tr>
              <th className={ui.th}>{m.detail.date}</th>
              <th className={ui.th}>{m.detail.type}</th>
              <th className={ui.th}>{m.detail.reference}</th>
              <th className={ui.th}>{m.detail.quantity}</th>
              <th className={ui.th}>{m.detail.balance}</th>
            </tr>
          </thead>
          <tbody>
            {ledger.map((e, i) => (
              <tr key={i}>
                <td className={`${ui.td} font-mono text-xs`} dir="ltr">{new Date(e.date).toLocaleDateString()}</td>
                <td className={ui.td}>
                  <span className={`${ui.chip} ${e.type === "RECEIPT" ? "bg-good-soft text-good" : "bg-accent-soft text-accent-strong"}`}>
                    {e.type === "RECEIPT" ? m.detail.receipt : m.detail.consumption}
                  </span>
                </td>
                <td className={`${ui.td} text-xs`} dir="ltr">{e.refLabel}</td>
                <td className={`${ui.td} font-mono tabular ${e.quantityKg < 0 ? "text-critical" : "text-good"}`} dir="ltr">
                  {e.quantityKg > 0 ? "+" : ""}
                  {e.quantityKg.toLocaleString()} kg
                </td>
                <td className={`${ui.td} font-mono tabular font-semibold`} dir="ltr">
                  {e.runningBalanceKg.toLocaleString()} kg
                </td>
              </tr>
            ))}
            {ledger.length === 0 && (
              <tr>
                <td className={ui.td} colSpan={5}>
                  <span className="text-ink-muted">{m.detail.empty}</span>
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
}
