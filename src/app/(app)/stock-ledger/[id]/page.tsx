import { notFound } from "next/navigation";
import Link from "next/link";
import { prisma } from "@/lib/prisma";
import { ui } from "@/lib/ui";
import { requirePageAccess } from "@/lib/session";
import { getDictionary } from "@/lib/i18n";
import { buildStockLedger } from "@/lib/stock-ledger";
import { effectiveSiteId } from "@/lib/siteScope";

export default async function StockLedgerDetailPage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<{ site?: string }>;
}) {
  const user = await requirePageAccess("stockLedger");
  const { id } = await params;
  const { site: siteParam } = await searchParams;
  const { dict } = await getDictionary();
  const m = dict.modules.stockLedger;
  // A restricted (non-ADMIN) caller always sees their own plant only,
  // regardless of what's in the URL — the ?site= param exists purely for
  // ADMIN, who has more than one to choose between. The stock-ledger list
  // page always links here with it already set (per its own material+plant
  // row); reaching this page without it falls back to every plant blended
  // together, same as before this page understood plants at all.
  const restrictedSiteId = effectiveSiteId(user);
  const filterSiteId = restrictedSiteId ?? (siteParam || null);

  const material = await prisma.material.findUnique({ where: { id } });
  if (!material) notFound();
  const filterSite = filterSiteId ? await prisma.site.findUnique({ where: { id: filterSiteId }, select: { code: true, name: true } }) : null;

  const siteWhere = filterSiteId ? { plant: { siteId: filterSiteId } } : {};
  const [receipts, actuals] = await Promise.all([
    prisma.materialReceipt.findMany({
      where: { materialId: id, postedToInventory: true, ...siteWhere },
      include: { supplier: true },
      orderBy: { receivedAt: "asc" },
    }),
    prisma.batchComponentActual.findMany({
      where: { materialId: id, batchTicket: { status: "COMPLETE", ...(filterSiteId ? { plant: { siteId: filterSiteId } } : {}) } },
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
            {" — "}
            {filterSite ? `${filterSite.code} · ${filterSite.name}` : m.detail.allPlants}
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
