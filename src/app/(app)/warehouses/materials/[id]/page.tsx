import { notFound } from "next/navigation";
import Link from "next/link";
import { prisma } from "@/lib/prisma";
import { ui } from "@/lib/ui";
import { requirePageAccess } from "@/lib/session";
import { getDictionary } from "@/lib/i18n";
import { buildStockLedger } from "@/lib/stock-ledger";
import { getActiveSiteId } from "@/lib/siteScope";

export default async function MaterialLedgerDetailPage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<{ site?: string; from?: string; to?: string }>;
}) {
  const user = await requirePageAccess("warehouses");
  const { id } = await params;
  const { site: siteParam, from: fromRaw, to: toRaw } = await searchParams;
  const { dict } = await getDictionary();
  const m = dict.modules.stockLedger;
  const restrictedSiteId = await getActiveSiteId(user);
  const filterSiteId = restrictedSiteId ?? (siteParam || null);

  const material = await prisma.material.findUnique({ where: { id } });
  if (!material) notFound();
  const filterSite = filterSiteId ? await prisma.site.findUnique({ where: { id: filterSiteId }, select: { code: true, name: true } }) : null;

  // Defaults to the current month, same convention Reports uses — a
  // material's full receive/consume history only ever grows, so showing
  // it unbounded by default would mean this page's query keeps getting
  // slower for as long as the plant stays in business.
  const todayIso = new Date().toISOString().slice(0, 10);
  const defaultFrom = (() => {
    const d = new Date();
    d.setDate(1);
    return d.toISOString().slice(0, 10);
  })();
  const rangeFrom = fromRaw || defaultFrom;
  const rangeTo = toRaw || todayIso;
  const rangeStart = new Date(`${rangeFrom}T00:00:00`);
  const rangeEnd = new Date(`${rangeTo}T23:59:59`);

  const siteWhere = filterSiteId ? { plant: { siteId: filterSiteId } } : {};
  const batchTicketSiteWhere = filterSiteId ? { plant: { siteId: filterSiteId } } : {};
  // A ticket's ledger date is batchCompletedAt, falling back to
  // releasedAt only when it was never completed — same fallback the
  // ledger events themselves use below, kept in sync here so a row
  // counted in the opening balance is never also counted (or skipped) in
  // the in-range list.
  const beforeRangeTicketDate = { OR: [{ batchCompletedAt: { lt: rangeStart } }, { batchCompletedAt: null, releasedAt: { lt: rangeStart } }] };
  const inRangeTicketDate = {
    OR: [
      { batchCompletedAt: { gte: rangeStart, lte: rangeEnd } },
      { batchCompletedAt: null, releasedAt: { gte: rangeStart, lte: rangeEnd } },
    ],
  };

  const [receipts, actuals, openingReceipts, openingActualWeighed, openingActualUnweighed] = await Promise.all([
    prisma.materialReceipt.findMany({
      where: { materialId: id, postedToInventory: true, receivedAt: { gte: rangeStart, lte: rangeEnd }, ...siteWhere },
      include: { supplier: true },
      orderBy: { receivedAt: "asc" },
    }),
    prisma.batchComponentActual.findMany({
      where: { materialId: id, batchTicket: { status: "COMPLETE", ...batchTicketSiteWhere, ...inRangeTicketDate } },
      include: { batchTicket: true },
    }),
    // Opening balance: everything before the range, summed by Postgres
    // rather than fetched row-by-row — the page never pulls a material's
    // full lifetime history, just this one running total plus whatever's
    // actually in the visible window.
    prisma.materialReceipt.aggregate({
      _sum: { netWeightKg: true },
      where: { materialId: id, postedToInventory: true, receivedAt: { lt: rangeStart }, ...siteWhere },
    }),
    prisma.batchComponentActual.aggregate({
      _sum: { actualMassKg: true },
      where: { materialId: id, actualMassKg: { not: null }, batchTicket: { status: "COMPLETE", ...batchTicketSiteWhere, ...beforeRangeTicketDate } },
    }),
    prisma.batchComponentActual.aggregate({
      _sum: { targetMassKg: true },
      where: { materialId: id, actualMassKg: null, batchTicket: { status: "COMPLETE", ...batchTicketSiteWhere, ...beforeRangeTicketDate } },
    }),
  ]);

  const openingBalanceKg =
    (openingReceipts._sum.netWeightKg ?? 0) - (openingActualWeighed._sum.actualMassKg ?? 0) - (openingActualUnweighed._sum.targetMassKg ?? 0);

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
    openingBalanceKg,
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
        <Link href="/warehouses?tab=rawMaterials&sub=ledger" className="rounded-md border border-border px-4 py-2 text-sm hover:bg-surface-alt">
          {m.back}
        </Link>
      </header>

      <form action={`/warehouses/materials/${id}`} className="flex flex-wrap items-end gap-3">
        {filterSiteId && <input type="hidden" name="site" value={filterSiteId} />}
        <div>
          <label className={ui.label}>{m.detail.dateFrom}</label>
          <input name="from" type="date" defaultValue={rangeFrom} className={`${ui.input} w-40`} />
        </div>
        <div>
          <label className={ui.label}>{m.detail.dateTo}</label>
          <input name="to" type="date" defaultValue={rangeTo} className={`${ui.input} w-40`} />
        </div>
        <button className="rounded-md border border-border px-3 py-1.5 text-xs hover:bg-surface-alt">{m.detail.applyRange}</button>
      </form>

      <div className={ui.card}>
        <div className="font-mono text-xs text-ink-muted uppercase">{m.detail.openingBalance}</div>
        <div className="mt-1 font-mono text-2xl tabular" dir="ltr">{openingBalanceKg.toLocaleString()} kg</div>
        <p className="mt-1 text-xs text-ink-muted">{m.detail.openingBalanceNote(new Date(rangeStart).toLocaleDateString())}</p>
      </div>

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
