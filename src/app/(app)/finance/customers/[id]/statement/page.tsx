import { notFound } from "next/navigation";
import Link from "next/link";
import { prisma } from "@/lib/prisma";
import { ui } from "@/lib/ui";
import { requirePageAccess } from "@/lib/session";
import { getDictionary } from "@/lib/i18n";
import { PrintButton } from "@/components/PrintButton";

type LedgerEntry = {
  date: Date;
  type: "INVOICE" | "PAYMENT" | "CREDIT_NOTE";
  reference: string;
  debit: number;
  credit: number;
};

function fmtDate(d: Date): string {
  return new Date(d).toLocaleDateString("en-GB", { day: "2-digit", month: "2-digit", year: "numeric" });
}

// A statement is meant to be handed straight to the customer (or used for
// collections) — it has to be the complete, real picture of what they owe
// across every plant, never filtered down to whichever plant the caller
// happens to be viewing. Same reasoning as getCustomerOutstandingBalance
// (the credit-limit gate) already being company-wide, not site-scoped.
export default async function CustomerStatementPage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<{ from?: string; to?: string }>;
}) {
  await requirePageAccess("finance");
  const { id } = await params;
  const { from: fromRaw, to: toRaw } = await searchParams;
  const { dict } = await getDictionary();
  const m = dict.modules.finance;
  const s = m.statement;

  const customer = await prisma.customer.findUnique({ where: { id } });
  if (!customer) notFound();

  // Real receivables only — DRAFT never went out, CANCELLED never was one
  // (same filter getCustomerOutstandingBalance uses).
  const invoices = await prisma.invoice.findMany({
    where: { customerId: id, status: { notIn: ["DRAFT", "CANCELLED"] } },
    include: { payments: true, creditNotes: true },
    orderBy: { issueDate: "asc" },
  });

  const allEntries: LedgerEntry[] = [];
  for (const inv of invoices) {
    allEntries.push({ date: inv.issueDate, type: "INVOICE", reference: inv.invoiceNumber, debit: inv.total, credit: 0 });
    for (const p of inv.payments) {
      allEntries.push({ date: p.paidAt, type: "PAYMENT", reference: inv.invoiceNumber, debit: 0, credit: p.amount });
    }
    for (const c of inv.creditNotes) {
      allEntries.push({ date: c.createdAt, type: "CREDIT_NOTE", reference: c.creditNoteNumber, debit: 0, credit: c.amount });
    }
  }
  allEntries.sort((a, b) => a.date.getTime() - b.date.getTime());

  const from = fromRaw ? new Date(`${fromRaw}T00:00:00`) : null;
  const to = toRaw ? new Date(`${toRaw}T23:59:59`) : null;

  // Everything before the filter's start collapses into one opening
  // balance, same shape a real bank/account statement uses — the visible
  // rows below only ever cover the requested window, but the running
  // balance column still means the actual account balance at each point.
  const openingBalance = from
    ? allEntries.filter((e) => e.date < from).reduce((sum, e) => sum + e.debit - e.credit, 0)
    : 0;
  const visibleEntries = allEntries.filter((e) => (!from || e.date >= from) && (!to || e.date <= to));

  let running = openingBalance;
  const rows = visibleEntries.map((e) => {
    running += e.debit - e.credit;
    return { ...e, balance: running };
  });

  const currentBalance = allEntries.reduce((sum, e) => sum + e.debit - e.credit, 0);
  const totalInvoiced = visibleEntries.filter((e) => e.type === "INVOICE").reduce((sum, e) => sum + e.debit, 0);
  const totalPaid = visibleEntries.filter((e) => e.type === "PAYMENT").reduce((sum, e) => sum + e.credit, 0);
  const totalCredited = visibleEntries.filter((e) => e.type === "CREDIT_NOTE").reduce((sum, e) => sum + e.credit, 0);
  const currency = invoices[0]?.currency ?? "";

  const typeChip: Record<string, string> = {
    INVOICE: "bg-accent-soft text-accent-strong",
    PAYMENT: "bg-good-soft text-good",
    CREDIT_NOTE: "bg-warn-soft text-warn",
  };

  return (
    <div className="flex flex-col gap-8">
      <header className="flex items-start justify-between gap-4">
        <div>
          <div className={ui.eyebrow}>{s.eyebrow}</div>
          <h1 className={ui.h1}>{customer.legalName}</h1>
          <p className={ui.intro}>
            {customer.code ? `${customer.code} · ` : ""}{customer.paymentTerms}
          </p>
        </div>
        <div className="no-print">
          <PrintButton label={s.print} />
        </div>
      </header>

      <form action={`/finance/customers/${id}/statement`} className="no-print flex flex-wrap items-end gap-3">
        <div>
          <label className={ui.label}>{s.filterFrom}</label>
          <input name="from" type="date" defaultValue={fromRaw ?? ""} className={`${ui.input} w-40`} />
        </div>
        <div>
          <label className={ui.label}>{s.filterTo}</label>
          <input name="to" type="date" defaultValue={toRaw ?? ""} className={`${ui.input} w-40`} />
        </div>
        <button className="rounded-md border border-border px-3 py-2 text-sm hover:bg-surface-alt">{s.apply}</button>
      </form>

      <div className="grid grid-cols-2 gap-4 md:grid-cols-4">
        {from && (
          <div className={ui.card}>
            <div className="text-xs text-ink-muted">{s.openingBalance}</div>
            <div className="mt-1 font-mono text-2xl font-semibold" dir="ltr">{openingBalance.toLocaleString()} {currency}</div>
          </div>
        )}
        <div className={ui.card}>
          <div className="text-xs text-ink-muted">{s.totalInvoiced}</div>
          <div className="mt-1 font-mono text-2xl font-semibold" dir="ltr">{totalInvoiced.toLocaleString()} {currency}</div>
        </div>
        <div className={ui.card}>
          <div className="text-xs text-ink-muted">{s.totalPaid}</div>
          <div className="mt-1 font-mono text-2xl font-semibold text-good" dir="ltr">{totalPaid.toLocaleString()} {currency}</div>
        </div>
        <div className={ui.card}>
          <div className="text-xs text-ink-muted">{s.totalCredited}</div>
          <div className="mt-1 font-mono text-2xl font-semibold text-warn" dir="ltr">{totalCredited.toLocaleString()} {currency}</div>
        </div>
        <div className={ui.card}>
          <div className="text-xs text-ink-muted">{s.currentBalance}</div>
          <div className={`mt-1 font-mono text-2xl font-semibold ${currentBalance > 0 ? "text-critical" : ""}`} dir="ltr">
            {currentBalance.toLocaleString()} {currency}
          </div>
        </div>
      </div>

      <div className={ui.card}>
        <table className={ui.table}>
          <thead>
            <tr>
              <th className={ui.th}>{s.col.date}</th>
              <th className={ui.th}>{s.col.type}</th>
              <th className={ui.th}>{s.col.reference}</th>
              <th className={ui.th}>{s.col.debit}</th>
              <th className={ui.th}>{s.col.credit}</th>
              <th className={ui.th}>{s.col.balance}</th>
            </tr>
          </thead>
          <tbody>
            {from && (
              <tr>
                <td className={ui.td} colSpan={5}>
                  <span className="text-ink-muted">{s.openingBalance}</span>
                </td>
                <td className={`${ui.td} font-mono tabular font-semibold`} dir="ltr">{openingBalance.toLocaleString()}</td>
              </tr>
            )}
            {rows.map((r, i) => (
              <tr key={i}>
                <td className={`${ui.td} font-mono text-xs tabular`}>{fmtDate(r.date)}</td>
                <td className={ui.td}>
                  <span className={`${ui.chip} ${typeChip[r.type]}`}>{s.typeLabel[r.type]}</span>
                </td>
                <td className={`${ui.td} font-mono text-xs`} dir="ltr">{r.reference}</td>
                <td className={`${ui.td} font-mono tabular`} dir="ltr">{r.debit ? r.debit.toLocaleString() : "—"}</td>
                <td className={`${ui.td} font-mono tabular`} dir="ltr">{r.credit ? r.credit.toLocaleString() : "—"}</td>
                <td className={`${ui.td} font-mono tabular font-semibold`} dir="ltr">{r.balance.toLocaleString()}</td>
              </tr>
            ))}
            {rows.length === 0 && (
              <tr>
                <td className={ui.td} colSpan={6}>
                  <span className="text-ink-muted">{s.empty}</span>
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>

      <Link href="/customers" className="no-print text-sm font-medium text-accent-strong hover:underline">
        {s.back}
      </Link>
    </div>
  );
}
