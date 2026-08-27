import { Fragment } from "react";
import Link from "next/link";
import { prisma } from "@/lib/prisma";
import { ui } from "@/lib/ui";
import { requirePageAccess } from "@/lib/session";
import { getDictionary } from "@/lib/i18n";
import { generateInvoiceForProject, savePriceListEntry } from "./actions";
import { getActiveSiteId, plantScopeWhere, tripPlantScopeWhere } from "@/lib/siteScope";

const statusChip: Record<string, string> = {
  DRAFT: "bg-surface-alt text-ink-muted",
  SENT: "bg-info-soft text-ink",
  PAID: "bg-good-soft text-good",
  CANCELLED: "bg-critical-soft text-critical",
};

export default async function BillingPage({
  searchParams,
}: {
  searchParams: Promise<{ editPrice?: string }>;
}) {
  const user = await requirePageAccess("billing");
  const { dict } = await getDictionary();
  const m = dict.modules.billing;
  const { editPrice: editPriceId } = await searchParams;
  // eslint-disable-next-line react-hooks/purity
  const nowMs = Date.now();
  const siteId = await getActiveSiteId(user);

  const [uninvoicedTrips, invoicesRaw, customers, mixes, priceEntries] = await Promise.all([
    prisma.trip.findMany({
      where: { status: "CLOSED", invoiceLine: null, ...tripPlantScopeWhere(siteId) },
      include: {
        batchTicket: {
          include: {
            mix: true,
            reservation: { include: { project: { include: { customer: true } }, mix: true } },
          },
        },
      },
    }),
    prisma.invoice.findMany({
      // Invoice.plantId is set at generation time from whichever line
      // produced its trips (see generateInvoiceForProject) — an invoice
      // with no plant (predates this, or had no in-scope trips) only ever
      // shows to ADMIN once restricted, same as any other unassignable
      // record.
      where: { ...plantScopeWhere(siteId) },
      orderBy: { issueDate: "desc" },
      include: { customer: true, project: true, payments: true },
      take: 30,
    }),
    prisma.customer.findMany({ orderBy: { legalName: "asc" } }),
    prisma.mixDesign.findMany({ where: { status: "APPROVED" }, orderBy: { code: "asc" } }),
    prisma.priceListEntry.findMany({ include: { customer: true, mix: true }, orderBy: { createdAt: "asc" } }),
  ]);

  const priceByCustomerMix = new Map(priceEntries.map((p) => [`${p.customerId}:${p.mixId}`, p.pricePerM3]));

  type TripRow = {
    id: string;
    ticketNumber: string;
    reservationNumber: string;
    mixCode: string;
    mixGrade: string;
    siteLocation: string | null;
    volumeM3: number;
    loadedAt: Date | null;
  };
  type ProjectGroup = {
    projectId: string;
    projectName: string;
    customerName: string;
    customerCode: string | null;
    count: number;
    volumeM3: number;
    missingMixCodes: Set<string>;
    trips: TripRow[];
  };
  const byProject = new Map<string, ProjectGroup>();
  for (const trip of uninvoicedTrips) {
    const reservation = trip.batchTicket.reservation;
    const project = reservation.project;
    const group = byProject.get(project.id) ?? {
      projectId: project.id,
      projectName: project.name,
      customerName: project.customer.legalName,
      customerCode: project.customer.code,
      count: 0,
      volumeM3: 0,
      missingMixCodes: new Set<string>(),
      trips: [],
    };
    const deliveredM3 = trip.volumeDeliveredM3 ?? trip.batchTicket.volumeM3;
    group.count += 1;
    group.volumeM3 += deliveredM3;
    if (!priceByCustomerMix.has(`${project.customerId}:${reservation.mixId}`)) {
      group.missingMixCodes.add(reservation.mix.code);
    }
    group.trips.push({
      id: trip.id,
      ticketNumber: trip.batchTicket.ticketNumber,
      reservationNumber: reservation.reservationNumber,
      mixCode: trip.batchTicket.mix.code,
      mixGrade: trip.batchTicket.mix.grade,
      siteLocation: reservation.siteLocation,
      volumeM3: deliveredM3,
      loadedAt: trip.batchTicket.batchCompletedAt,
    });
    byProject.set(project.id, group);
  }
  const projectGroups = [...byProject.values()];

  const invoices = invoicesRaw.map((inv) => {
    const paid = inv.payments.reduce((sum, p) => sum + p.amount, 0);
    const due = inv.total - paid;
    const isOverdue = inv.status === "SENT" && due > 0.01 && inv.dueDate.getTime() < nowMs;
    const daysOverdue = isOverdue ? Math.floor((nowMs - inv.dueDate.getTime()) / 86400000) : 0;
    return { ...inv, isOverdue, daysOverdue };
  });

  return (
    <div className="flex flex-col gap-8">
      <header>
        <div className={ui.eyebrow}>{m.eyebrow}</div>
        <h1 className={ui.h1}>{m.title}</h1>
        <p className={ui.intro}>{m.intro}</p>
      </header>

      <div className={ui.card}>
        <h2 className="mb-3 font-display text-lg font-semibold">{m.readyTitle}</h2>
        <table className={ui.table}>
          <thead>
            <tr>
              <th className={ui.th}>{m.col.project}</th>
              <th className={ui.th}>{m.col.customer}</th>
              <th className={ui.th}>{m.col.ticket}</th>
              <th className={ui.th}>{m.col.reservation}</th>
              <th className={ui.th}>{m.col.mix}</th>
              <th className={ui.th}>{m.col.pourLocation}</th>
              <th className={ui.th}>{m.col.loadTime}</th>
              <th className={ui.th}>{m.col.deliveries}</th>
              <th className={ui.th}>{m.col.volume}</th>
              <th className={ui.th}></th>
            </tr>
          </thead>
          <tbody>
            {projectGroups.map((g) => (
              <Fragment key={g.projectId}>
                <tr className="bg-surface-alt">
                  <td className={`${ui.td} font-medium`}>{g.projectName}</td>
                  <td className={ui.td}>
                    {g.customerName}
                    {g.customerCode ? ` (${g.customerCode})` : ""}
                  </td>
                  <td className={ui.td}></td>
                  <td className={ui.td}></td>
                  <td className={ui.td}></td>
                  <td className={ui.td}></td>
                  <td className={ui.td}></td>
                  <td className={`${ui.td} font-mono tabular`}>{g.count}</td>
                  <td className={`${ui.td} font-mono tabular`}>{g.volumeM3} m³</td>
                  <td className={ui.td}>
                    {g.missingMixCodes.size === 0 ? (
                      <form action={generateInvoiceForProject}>
                        <input type="hidden" name="projectId" value={g.projectId} />
                        <button className={ui.button}>{m.generate}</button>
                      </form>
                    ) : (
                      <span className="text-xs text-warn">{m.needsPricing([...g.missingMixCodes].join(", "))}</span>
                    )}
                  </td>
                </tr>
                {g.trips.map((t) => (
                  <tr key={t.id}>
                    <td className={ui.td}></td>
                    <td className={ui.td}></td>
                    <td className={`${ui.td} font-mono text-xs`} dir="ltr">
                      <span className="text-ink-faint">↳</span> {t.ticketNumber}
                    </td>
                    <td className={`${ui.td} font-mono text-xs`} dir="ltr">{t.reservationNumber}</td>
                    <td className={ui.td}>
                      <span className="font-mono text-xs" dir="ltr">{t.mixCode}</span>
                      <div className="text-xs text-ink-muted">{t.mixGrade}</div>
                    </td>
                    <td className={`${ui.td} text-xs`}>{t.siteLocation ?? "—"}</td>
                    <td className={`${ui.td} font-mono text-xs tabular`}>{t.loadedAt ? new Date(t.loadedAt).toLocaleString() : "—"}</td>
                    <td className={ui.td}></td>
                    <td className={`${ui.td} font-mono tabular`}>{t.volumeM3} m³</td>
                    <td className={ui.td}></td>
                  </tr>
                ))}
              </Fragment>
            ))}
            {projectGroups.length === 0 && (
              <tr>
                <td className={ui.td} colSpan={10}>
                  <span className="text-ink-muted">{m.empty}</span>
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>

      <div className={ui.card}>
        <h2 className="mb-3 font-display text-lg font-semibold">{m.invoicesTitle}</h2>
        <table className={ui.table}>
          <thead>
            <tr>
              <th className={ui.th}>{m.colInvoice.number}</th>
              <th className={ui.th}>{m.colInvoice.customer}</th>
              <th className={ui.th}>{m.colInvoice.project}</th>
              <th className={ui.th}>{m.colInvoice.issued}</th>
              <th className={ui.th}>{m.colInvoice.due}</th>
              <th className={ui.th}>{m.colInvoice.total}</th>
              <th className={ui.th}>{m.colInvoice.status}</th>
            </tr>
          </thead>
          <tbody>
            {invoices.map((inv) => (
              <tr key={inv.id}>
                <td className={ui.td}>
                  <Link href={`/billing/${inv.id}`} className="font-mono text-xs font-medium text-accent-strong hover:underline" dir="ltr">
                    {inv.invoiceNumber}
                  </Link>
                </td>
                <td className={ui.td}>{inv.customer.legalName}</td>
                <td className={ui.td}>{inv.project?.name ?? "—"}</td>
                <td className={`${ui.td} font-mono text-xs tabular`}>{new Date(inv.issueDate).toLocaleDateString()}</td>
                <td className={`${ui.td} font-mono text-xs tabular`}>{new Date(inv.dueDate).toLocaleDateString()}</td>
                <td className={`${ui.td} font-mono tabular`} dir="ltr">{inv.total.toLocaleString()} {inv.currency}</td>
                <td className={ui.td}>
                  <span className={`${ui.chip} ${statusChip[inv.status] ?? ""}`}>{dict.status[inv.status as keyof typeof dict.status] ?? inv.status}</span>
                  {inv.isOverdue && (
                    <span className={`${ui.chip} bg-critical-soft text-critical ms-2`}>{m.overdue(inv.daysOverdue)}</span>
                  )}
                </td>
              </tr>
            ))}
            {invoices.length === 0 && (
              <tr>
                <td className={ui.td} colSpan={7}>
                  <span className="text-ink-muted">{m.emptyInvoices}</span>
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>

      <div className="grid grid-cols-[1fr_320px] gap-6">
        <div className={ui.card}>
          <h2 className="mb-3 font-display text-lg font-semibold">{m.pricingTitle}</h2>
          <table className={ui.table}>
            <thead>
              <tr>
                <th className={ui.th}>{m.colPrice.customer}</th>
                <th className={ui.th}>{m.colPrice.mix}</th>
                <th className={ui.th}>{m.colPrice.price}</th>
                <th className={ui.th}>{dict.field.actions}</th>
              </tr>
            </thead>
            <tbody>
              {priceEntries.map((p) =>
                editPriceId === p.id ? (
                  <tr key={p.id}>
                    <td className={ui.td} colSpan={4}>
                      <form action={savePriceListEntry} className="flex flex-wrap items-end gap-2">
                        <input type="hidden" name="id" value={p.id} />
                        <div className="text-sm">
                          {p.customer.legalName} <span className="text-ink-muted">·</span> <span dir="ltr">{p.mix.code}</span>
                        </div>
                        <div>
                          <label className={ui.label}>{m.fPrice.price}</label>
                          <input name="pricePerM3" type="number" step="0.01" defaultValue={p.pricePerM3} required className={`${ui.input} w-28`} />
                        </div>
                        <button className={ui.button}>{dict.field.save}</button>
                        <Link href="/billing" className="rounded-md border border-border px-3 py-2 text-sm hover:bg-surface-alt">
                          {dict.field.cancel}
                        </Link>
                      </form>
                    </td>
                  </tr>
                ) : (
                  <tr key={p.id}>
                    <td className={ui.td}>{p.customer.legalName}</td>
                    <td className={`${ui.td} font-mono text-xs`} dir="ltr">{p.mix.code}</td>
                    <td className={`${ui.td} font-mono tabular`} dir="ltr">{p.pricePerM3.toLocaleString()}</td>
                    <td className={ui.td}>
                      <Link href={`/billing?editPrice=${p.id}`} className="text-xs font-medium text-accent-strong hover:underline">
                        {dict.field.edit}
                      </Link>
                    </td>
                  </tr>
                )
              )}
              {priceEntries.length === 0 && (
                <tr>
                  <td className={ui.td} colSpan={4}>
                    <span className="text-ink-muted">{m.emptyPricing}</span>
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>

        <form action={savePriceListEntry} className={`${ui.card} flex flex-col gap-3`}>
          <h2 className="font-display text-lg font-semibold">{m.newPriceTitle}</h2>
          <div>
            <label className={ui.label}>{m.fPrice.customer}</label>
            <select name="customerId" required className={ui.select}>
              <option value="">{dict.field.selectCustomer}</option>
              {customers.map((c) => (
                <option key={c.id} value={c.id}>{c.legalName}</option>
              ))}
            </select>
          </div>
          <div>
            <label className={ui.label}>{m.fPrice.mix}</label>
            <select name="mixId" required className={ui.select}>
              <option value="">{dict.field.selectMix}</option>
              {mixes.map((mx) => (
                <option key={mx.id} value={mx.id}>{mx.code} — {mx.grade}</option>
              ))}
            </select>
          </div>
          <div>
            <label className={ui.label}>{m.fPrice.price}</label>
            <input name="pricePerM3" type="number" step="0.01" required className={ui.input} />
          </div>
          <button type="submit" className={`${ui.button} mt-2`}>
            {m.savePrice}
          </button>
        </form>
      </div>
    </div>
  );
}
