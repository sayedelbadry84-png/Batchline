import { Fragment } from "react";
import Link from "next/link";
import { prisma } from "@/lib/prisma";
import { ui } from "@/lib/ui";
import { requirePageAccess } from "@/lib/session";
import { getDictionary } from "@/lib/i18n";
import { getActiveSiteId, reservationSiteScopeWhere, plantScopeWhere, tripPlantScopeWhere } from "@/lib/siteScope";
import { invoiceAmountDue } from "@/lib/billing";
import { Modal } from "@/components/Modal";
import {
  createSupplierBill,
  recordSupplierPayment,
  cancelSupplierBill,
  createCashTransaction,
  reconcileMovement,
} from "./actions";
import { generateInvoiceForProject } from "../billing/actions";

const FINANCE_TABS = ["overview", "billing", "payable", "cash", "aging", "reconciliation", "ledger"] as const;
const AGING_BUCKETS = [
  { key: "current", max: 0 },
  { key: "d30", max: 30 },
  { key: "d60", max: 60 },
  { key: "d90", max: 90 },
  { key: "over90", max: Infinity },
] as const;

// Which bucket a balance falls into, by days past its due date — not due
// yet (or due today) is "current"; everything else buckets by how many
// days overdue, same boundaries every AR/AP aging report in the industry
// uses (30/60/90).
function agingBucket(dueDate: Date, now: Date): (typeof AGING_BUCKETS)[number]["key"] {
  const daysOverdue = Math.floor((now.getTime() - dueDate.getTime()) / 86400000);
  if (daysOverdue <= 0) return "current";
  if (daysOverdue <= 30) return "d30";
  if (daysOverdue <= 60) return "d60";
  if (daysOverdue <= 90) return "d90";
  return "over90";
}
type FinanceTab = (typeof FINANCE_TABS)[number];
const CASH_CATEGORIES = ["OPERATING_EXPENSE", "PAYROLL", "UTILITIES", "FUEL", "MAINTENANCE", "OTHER_INCOME", "OWNER_CONTRIBUTION", "OTHER"] as const;

const billStatusChip: Record<string, string> = {
  UNPAID: "bg-warn-soft text-warn",
  PARTIALLY_PAID: "bg-accent-soft text-accent-strong",
  PAID: "bg-good-soft text-good",
  CANCELLED: "bg-critical-soft text-critical",
};

const invoiceStatusChip: Record<string, string> = {
  DRAFT: "bg-surface-alt text-ink-muted",
  SENT: "bg-info-soft text-ink",
  PAID: "bg-good-soft text-good",
  CANCELLED: "bg-critical-soft text-critical",
};

function fmtDate(d: Date | null): string {
  if (!d) return "—";
  return new Date(d).toLocaleDateString("en-GB", { day: "2-digit", month: "2-digit", year: "numeric" });
}

export default async function FinancePage({
  searchParams,
}: {
  searchParams: Promise<{ tab?: string; newBill?: string; pay?: string; newCash?: string }>;
}) {
  const user = await requirePageAccess("finance");
  const { dict } = await getDictionary();
  const m = dict.modules.finance;
  const { tab: tabRaw, newBill: newBillFlag, pay: payId, newCash: newCashFlag } = await searchParams;
  const tab: FinanceTab = FINANCE_TABS.includes(tabRaw as FinanceTab) ? (tabRaw as FinanceTab) : "overview";
  const siteId = await getActiveSiteId(user);
  const siteScope = reservationSiteScopeWhere(siteId);

  const [sites, suppliers] = await Promise.all([
    prisma.site.findMany({ where: siteId ? { id: siteId } : {}, orderBy: { code: "asc" }, select: { id: true, code: true, name: true } }),
    prisma.supplier.findMany({ orderBy: { name: "asc" } }),
  ]);

  const baseUrl = `/finance?tab=${tab}`;

  return (
    <div className="flex flex-col gap-8">
      <header>
        <div className={ui.eyebrow}>{m.eyebrow}</div>
        <h1 className={ui.h1}>{m.title}</h1>
        <p className={ui.intro}>{m.intro}</p>
      </header>

      <div className="no-print flex flex-wrap gap-1 border-b border-border">
        {FINANCE_TABS.map((t) => (
          <Link
            key={t}
            href={`/finance?tab=${t}`}
            className={`rounded-t-md px-3 py-2 text-sm ${tab === t ? "border-b-2 border-accent font-medium text-ink" : "text-ink-muted hover:text-ink"}`}
          >
            {m.tabs[t]}
          </Link>
        ))}
      </div>

      {tab === "overview" && <OverviewTab m={m} siteScope={siteScope} />}

      {tab === "billing" && <BillingTab dict={dict} siteId={siteId} />}

      {tab === "payable" && (
        <PayableTab m={m} dict={dict} siteScope={siteScope} sites={sites} suppliers={suppliers} newBillFlag={newBillFlag} payId={payId} baseUrl={baseUrl} />
      )}

      {tab === "cash" && <CashTab m={m} siteScope={siteScope} sites={sites} newCashFlag={newCashFlag} baseUrl={baseUrl} />}

      {tab === "aging" && <AgingTab m={m} siteScope={siteScope} />}

      {tab === "reconciliation" && <ReconciliationTab m={m} dict={dict} siteScope={siteScope} />}

      {tab === "ledger" && <LedgerTab m={m} siteScope={siteScope} />}
    </div>
  );
}

async function OverviewTab({
  m,
  siteScope,
}: {
  m: Awaited<ReturnType<typeof getDictionary>>["dict"]["modules"]["finance"];
  siteScope: Record<string, unknown>;
}) {
  const monthStart = new Date();
  monthStart.setDate(1);
  monthStart.setHours(0, 0, 0, 0);

  const [invoices, bills, cashThisMonth, paymentsThisMonth, supplierPaymentsThisMonth] = await Promise.all([
    prisma.invoice.findMany({ where: { status: { notIn: ["DRAFT", "CANCELLED"] }, ...(siteScope.siteId ? { plant: { siteId: (siteScope as { siteId: string }).siteId } } : {}) }, select: { total: true, payments: { select: { amount: true } }, creditNotes: { select: { amount: true } } } }),
    prisma.supplierBill.findMany({ where: { status: { notIn: ["CANCELLED"] }, ...siteScope }, select: { total: true, payments: { select: { amount: true } } } }),
    prisma.cashTransaction.findMany({ where: { occurredAt: { gte: monthStart }, ...siteScope }, select: { direction: true, amount: true } }),
    prisma.payment.findMany({ where: { paidAt: { gte: monthStart } }, select: { amount: true } }),
    prisma.supplierPayment.findMany({ where: { paidAt: { gte: monthStart } }, select: { amount: true } }),
  ]);

  const arOutstanding = invoices.reduce((sum, inv) => sum + invoiceAmountDue(inv), 0);
  const apOutstanding = bills.reduce((sum, b) => sum + Math.max(0, b.total - b.payments.reduce((s, p) => s + p.amount, 0)), 0);
  const cashIn = cashThisMonth.filter((t) => t.direction === "IN").reduce((s, t) => s + t.amount, 0) + paymentsThisMonth.reduce((s, p) => s + p.amount, 0);
  const cashOut = cashThisMonth.filter((t) => t.direction === "OUT").reduce((s, t) => s + t.amount, 0) + supplierPaymentsThisMonth.reduce((s, p) => s + p.amount, 0);
  const net = cashIn - cashOut;

  return (
    <div className="grid grid-cols-2 gap-4 md:grid-cols-5">
      <div className={ui.card}>
        <div className="text-xs text-ink-muted">{m.overview.arOutstanding}</div>
        <div className="mt-1 font-mono text-2xl font-semibold">{arOutstanding.toFixed(0)}</div>
      </div>
      <div className={ui.card}>
        <div className="text-xs text-ink-muted">{m.overview.apOutstanding}</div>
        <div className="mt-1 font-mono text-2xl font-semibold">{apOutstanding.toFixed(0)}</div>
      </div>
      <div className={ui.card}>
        <div className="text-xs text-ink-muted">{m.overview.cashInMonth}</div>
        <div className="mt-1 font-mono text-2xl font-semibold text-good">{cashIn.toFixed(0)}</div>
      </div>
      <div className={ui.card}>
        <div className="text-xs text-ink-muted">{m.overview.cashOutMonth}</div>
        <div className="mt-1 font-mono text-2xl font-semibold text-critical">{cashOut.toFixed(0)}</div>
      </div>
      <div className={ui.card}>
        <div className="text-xs text-ink-muted">{m.overview.netMonth}</div>
        <div className={`mt-1 font-mono text-2xl font-semibold ${net >= 0 ? "text-good" : "text-critical"}`}>{net.toFixed(0)}</div>
      </div>
    </div>
  );
}

async function PayableTab({
  m,
  dict,
  siteScope,
  sites,
  suppliers,
  newBillFlag,
  payId,
  baseUrl,
}: {
  m: Awaited<ReturnType<typeof getDictionary>>["dict"]["modules"]["finance"];
  dict: Awaited<ReturnType<typeof getDictionary>>["dict"];
  siteScope: Record<string, unknown>;
  sites: { id: string; code: string; name: string }[];
  suppliers: { id: string; name: string }[];
  newBillFlag?: string;
  payId?: string;
  baseUrl: string;
}) {
  const bills = await prisma.supplierBill.findMany({
    where: siteScope,
    orderBy: { createdAt: "desc" },
    include: { supplier: true, payments: true },
  });

  return (
    <div className="flex flex-col gap-4">
      <div className="no-print flex justify-end">
        <Link href={`${baseUrl}&newBill=1`} className={ui.button}>+ {m.payable.newTitle}</Link>
      </div>

      <div className={ui.card}>
        <table className={ui.table}>
          <thead>
            <tr>
              <th className={ui.th}>{m.payable.col.number}</th>
              <th className={ui.th}>{m.payable.col.supplier}</th>
              <th className={ui.th}>{m.payable.col.status}</th>
              <th className={ui.th}>{m.payable.col.total}</th>
              <th className={ui.th}>{m.payable.col.paid}</th>
              <th className={ui.th}>{m.payable.col.dueDate}</th>
              <th className={ui.th}>{dict.field.actions}</th>
            </tr>
          </thead>
          <tbody>
            {bills.map((b) => {
              const paid = b.payments.reduce((s, p) => s + p.amount, 0);
              return (
                <tr key={b.id}>
                  <td className={`${ui.td} font-mono text-xs`}>{b.billNumber}</td>
                  <td className={ui.td}>{b.supplier.name}</td>
                  <td className={ui.td}>
                    <span className={`${ui.chip} ${billStatusChip[b.status] ?? ""}`}>{m.payable.statusLabel[b.status as keyof typeof m.payable.statusLabel] ?? b.status}</span>
                  </td>
                  <td className={`${ui.td} font-mono`}>{b.total.toFixed(2)} {b.currency}</td>
                  <td className={`${ui.td} font-mono`}>{paid.toFixed(2)}</td>
                  <td className={ui.td}>{fmtDate(b.dueDate)}</td>
                  <td className={ui.td}>
                    <div className="flex flex-col gap-1">
                      {["UNPAID", "PARTIALLY_PAID"].includes(b.status) && (
                        <Link href={`${baseUrl}&pay=${b.id}`} className="text-xs font-medium text-good hover:underline">{m.payable.recordPayment}</Link>
                      )}
                      {b.status === "UNPAID" && (
                        <form action={cancelSupplierBill}>
                          <input type="hidden" name="id" value={b.id} />
                          <button className="text-xs font-medium text-critical hover:underline">{m.payable.cancel}</button>
                        </form>
                      )}
                    </div>
                  </td>
                </tr>
              );
            })}
            {bills.length === 0 && (
              <tr><td className={ui.td} colSpan={7}><span className="text-ink-muted">{m.payable.empty}</span></td></tr>
            )}
          </tbody>
        </table>
      </div>

      {newBillFlag === "1" && (
        <Modal title={m.payable.newTitle} closeHref={baseUrl}>
          <form action={createSupplierBill} className="flex flex-col gap-3">
            <div>
              <label className={ui.label}>{m.payable.f.supplierId}</label>
              <select name="supplierId" required className={ui.select}>
                <option value="" disabled>{dict.field.selectSupplier}</option>
                {suppliers.map((s) => (
                  <option key={s.id} value={s.id}>{s.name}</option>
                ))}
              </select>
            </div>
            <div>
              <label className={ui.label}>{m.payable.f.siteId}</label>
              <select name="siteId" required className={ui.select}>
                {sites.map((s) => (
                  <option key={s.id} value={s.id}>{s.code} — {s.name}</option>
                ))}
              </select>
            </div>
            <div>
              <label className={ui.label}>{m.payable.f.dueDate}</label>
              <input name="dueDate" type="date" required className={ui.input} />
            </div>
            <div className="grid grid-cols-2 gap-2">
              <div>
                <label className={ui.label}>{m.payable.f.subtotal}</label>
                <input name="subtotal" type="number" step="0.01" required className={ui.input} />
              </div>
              <div>
                <label className={ui.label}>{m.payable.f.taxAmount}</label>
                <input name="taxAmount" type="number" step="0.01" className={ui.input} />
              </div>
            </div>
            <div>
              <label className={ui.label}>{m.payable.f.notes}</label>
              <input name="notes" className={ui.input} />
            </div>
            <button type="submit" className={`${ui.button} mt-2`}>{m.payable.add}</button>
          </form>
        </Modal>
      )}

      {payId && (
        <Modal title={m.payable.recordPayment} closeHref={baseUrl}>
          <form action={recordSupplierPayment} className="flex flex-col gap-3">
            <input type="hidden" name="supplierBillId" value={payId} />
            <div>
              <label className={ui.label}>{m.payable.f.amount}</label>
              <input name="amount" type="number" step="0.01" required className={ui.input} />
            </div>
            <div className="grid grid-cols-2 gap-2">
              <div>
                <label className={ui.label}>{m.payable.f.method}</label>
                <select name="method" defaultValue="" className={ui.select}>
                  <option value="">{dict.field.none}</option>
                  <option value="CASH">{m.payable.methodLabel.CASH}</option>
                  <option value="BANK_TRANSFER">{m.payable.methodLabel.BANK_TRANSFER}</option>
                  <option value="CHEQUE">{m.payable.methodLabel.CHEQUE}</option>
                </select>
              </div>
              <div>
                <label className={ui.label}>{m.payable.f.reference}</label>
                <input name="reference" className={ui.input} />
              </div>
            </div>
            <button type="submit" className={`${ui.button} mt-2`}>{m.payable.confirmPayment}</button>
          </form>
        </Modal>
      )}
    </div>
  );
}

async function CashTab({
  m,
  siteScope,
  sites,
  newCashFlag,
  baseUrl,
}: {
  m: Awaited<ReturnType<typeof getDictionary>>["dict"]["modules"]["finance"];
  siteScope: Record<string, unknown>;
  sites: { id: string; code: string; name: string }[];
  newCashFlag?: string;
  baseUrl: string;
}) {
  const transactions = await prisma.cashTransaction.findMany({
    where: siteScope,
    orderBy: { occurredAt: "desc" },
    take: 100,
    include: { createdBy: true },
  });

  return (
    <div className="flex flex-col gap-4">
      <div className="no-print flex justify-end">
        <Link href={`${baseUrl}&newCash=1`} className={ui.button}>+ {m.cash.newTitle}</Link>
      </div>

      <div className={ui.card}>
        <table className={ui.table}>
          <thead>
            <tr>
              <th className={ui.th}>{m.cash.col.number}</th>
              <th className={ui.th}>{m.cash.col.date}</th>
              <th className={ui.th}>{m.cash.col.direction}</th>
              <th className={ui.th}>{m.cash.col.category}</th>
              <th className={ui.th}>{m.cash.col.amount}</th>
              <th className={ui.th}>{m.cash.col.description}</th>
              <th className={ui.th}>{m.cash.col.by}</th>
            </tr>
          </thead>
          <tbody>
            {transactions.map((t) => (
              <tr key={t.id}>
                <td className={`${ui.td} font-mono text-xs`}>{t.txnNumber}</td>
                <td className={ui.td}>{fmtDate(t.occurredAt)}</td>
                <td className={ui.td}>
                  <span className={`${ui.chip} ${t.direction === "IN" ? "bg-good-soft text-good" : "bg-critical-soft text-critical"}`}>
                    {t.direction === "IN" ? m.cash.in : m.cash.out}
                  </span>
                </td>
                <td className={ui.td}>{m.cash.categoryLabel[t.category as keyof typeof m.cash.categoryLabel] ?? t.category}</td>
                <td className={`${ui.td} font-mono`}>{t.amount.toFixed(2)} {t.currency}</td>
                <td className={ui.td}>{t.description}</td>
                <td className={ui.td}>{t.createdBy.name}</td>
              </tr>
            ))}
            {transactions.length === 0 && (
              <tr><td className={ui.td} colSpan={7}><span className="text-ink-muted">{m.cash.empty}</span></td></tr>
            )}
          </tbody>
        </table>
      </div>

      {newCashFlag === "1" && (
        <Modal title={m.cash.newTitle} closeHref={baseUrl}>
          <form action={createCashTransaction} className="flex flex-col gap-3">
            <div>
              <label className={ui.label}>{m.cash.f.siteId}</label>
              <select name="siteId" required className={ui.select}>
                {sites.map((s) => (
                  <option key={s.id} value={s.id}>{s.code} — {s.name}</option>
                ))}
              </select>
            </div>
            <div className="grid grid-cols-2 gap-2">
              <div>
                <label className={ui.label}>{m.cash.f.direction}</label>
                <select name="direction" required className={ui.select}>
                  <option value="IN">{m.cash.in}</option>
                  <option value="OUT">{m.cash.out}</option>
                </select>
              </div>
              <div>
                <label className={ui.label}>{m.cash.f.category}</label>
                <select name="category" required className={ui.select}>
                  {CASH_CATEGORIES.map((c) => (
                    <option key={c} value={c}>{m.cash.categoryLabel[c]}</option>
                  ))}
                </select>
              </div>
            </div>
            <div className="grid grid-cols-2 gap-2">
              <div>
                <label className={ui.label}>{m.cash.f.amount}</label>
                <input name="amount" type="number" step="0.01" required className={ui.input} />
              </div>
              <div>
                <label className={ui.label}>{m.cash.f.occurredAt}</label>
                <input name="occurredAt" type="date" className={ui.input} />
              </div>
            </div>
            <div>
              <label className={ui.label}>{m.cash.f.description}</label>
              <input name="description" required className={ui.input} />
            </div>
            <div>
              <label className={ui.label}>{m.cash.f.reference}</label>
              <input name="reference" className={ui.input} />
            </div>
            <button type="submit" className={`${ui.button} mt-2`}>{m.cash.add}</button>
          </form>
        </Modal>
      )}
    </div>
  );
}

async function AgingTab({
  m,
  siteScope,
}: {
  m: Awaited<ReturnType<typeof getDictionary>>["dict"]["modules"]["finance"];
  siteScope: Record<string, unknown>;
}) {
  const now = new Date();

  const [invoices, bills] = await Promise.all([
    prisma.invoice.findMany({
      where: { status: { notIn: ["DRAFT", "CANCELLED"] }, ...(siteScope.siteId ? { plant: { siteId: (siteScope as { siteId: string }).siteId } } : {}) },
      include: { customer: true, payments: true, creditNotes: true },
    }),
    prisma.supplierBill.findMany({
      where: { status: { notIn: ["CANCELLED"] }, ...siteScope },
      include: { supplier: true, payments: true },
    }),
  ]);

  // Same shape for both sides: one row per still-open invoice/bill, bucketed
  // by how many days past its own due date it now is — a paid-off row
  // (outstanding <= 0) never appears, same as an aging report anywhere else.
  const arRows = invoices
    .map((inv) => ({
      label: `${inv.invoiceNumber} — ${inv.customer.legalName}`,
      outstanding: invoiceAmountDue(inv),
      currency: inv.currency,
      bucket: agingBucket(inv.dueDate, now),
    }))
    .filter((r) => r.outstanding > 0.01);

  const apRows = bills
    .map((b) => ({
      label: `${b.billNumber} — ${b.supplier.name}`,
      outstanding: b.total - b.payments.reduce((s, p) => s + p.amount, 0),
      currency: b.currency,
      bucket: agingBucket(b.dueDate, now),
    }))
    .filter((r) => r.outstanding > 0.01);

  function bucketTotals(rows: { outstanding: number; bucket: string }[]) {
    return Object.fromEntries(AGING_BUCKETS.map((b) => [b.key, rows.filter((r) => r.bucket === b.key).reduce((s, r) => s + r.outstanding, 0)]));
  }
  const arTotals = bucketTotals(arRows);
  const apTotals = bucketTotals(apRows);

  return (
    <div className="flex flex-col gap-6">
      <div className={ui.card}>
        <h2 className="mb-3 font-display text-lg font-semibold">{m.aging.arTitle}</h2>
        <table className={ui.table}>
          <thead>
            <tr>
              {AGING_BUCKETS.map((b) => (
                <th key={b.key} className={`${ui.th} text-center`}>{m.aging.bucketLabel[b.key]}</th>
              ))}
            </tr>
          </thead>
          <tbody>
            <tr>
              {AGING_BUCKETS.map((b) => (
                <td key={b.key} className={`${ui.td} text-center font-mono ${b.key !== "current" && arTotals[b.key] > 0 ? "text-critical font-semibold" : ""}`}>
                  {arTotals[b.key].toFixed(0)}
                </td>
              ))}
            </tr>
          </tbody>
        </table>
        {arRows.length > 0 && (
          <table className={`${ui.table} mt-4`}>
            <thead>
              <tr>
                <th className={ui.th}>{m.aging.col.item}</th>
                <th className={ui.th}>{m.aging.col.bucket}</th>
                <th className={ui.th}>{m.aging.col.outstanding}</th>
              </tr>
            </thead>
            <tbody>
              {arRows.map((r) => (
                <tr key={r.label}>
                  <td className={ui.td}>{r.label}</td>
                  <td className={ui.td}>
                    <span className={`${ui.chip} ${r.bucket === "current" ? "bg-surface-alt text-ink-muted" : "bg-critical-soft text-critical"}`}>{m.aging.bucketLabel[r.bucket]}</span>
                  </td>
                  <td className={`${ui.td} font-mono`}>{r.outstanding.toFixed(2)} {r.currency}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>

      <div className={ui.card}>
        <h2 className="mb-3 font-display text-lg font-semibold">{m.aging.apTitle}</h2>
        <table className={ui.table}>
          <thead>
            <tr>
              {AGING_BUCKETS.map((b) => (
                <th key={b.key} className={`${ui.th} text-center`}>{m.aging.bucketLabel[b.key]}</th>
              ))}
            </tr>
          </thead>
          <tbody>
            <tr>
              {AGING_BUCKETS.map((b) => (
                <td key={b.key} className={`${ui.td} text-center font-mono ${b.key !== "current" && apTotals[b.key] > 0 ? "text-critical font-semibold" : ""}`}>
                  {apTotals[b.key].toFixed(0)}
                </td>
              ))}
            </tr>
          </tbody>
        </table>
        {apRows.length > 0 && (
          <table className={`${ui.table} mt-4`}>
            <thead>
              <tr>
                <th className={ui.th}>{m.aging.col.item}</th>
                <th className={ui.th}>{m.aging.col.bucket}</th>
                <th className={ui.th}>{m.aging.col.outstanding}</th>
              </tr>
            </thead>
            <tbody>
              {apRows.map((r) => (
                <tr key={r.label}>
                  <td className={ui.td}>{r.label}</td>
                  <td className={ui.td}>
                    <span className={`${ui.chip} ${r.bucket === "current" ? "bg-surface-alt text-ink-muted" : "bg-critical-soft text-critical"}`}>{m.aging.bucketLabel[r.bucket]}</span>
                  </td>
                  <td className={`${ui.td} font-mono`}>{r.outstanding.toFixed(2)} {r.currency}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
    </div>
  );
}

// Read-only — nothing here is entered by hand, every row was posted by
// postJournalEntry (src/lib/ledger.ts) from a real Billing/Finance/
// Payroll event. Grouped by currency, never blended across currencies
// (same rule every other money-grouping in this app already follows) —
// with "all plants" selected this can show more than one currency's own
// balanced trial balance, one table per currency.
async function LedgerTab({
  m,
  siteScope,
}: {
  m: Awaited<ReturnType<typeof getDictionary>>["dict"]["modules"]["finance"];
  siteScope: Record<string, unknown>;
}) {
  // Summed directly by Postgres (groupBy) rather than fetched row-by-row
  // and reduced in JS — a Trial Balance is a lifetime-to-date balance by
  // definition (there's no "period" to bound it to, unlike Reports' other
  // metrics), so the fix for its growing-forever query isn't pagination,
  // it's asking the database to do the summing instead of pulling every
  // journal line ever posted into the app on every render.
  const grouped = await prisma.journalLine.groupBy({
    by: ["accountId", "currency"],
    where: { ...siteScope },
    _sum: { debit: true, credit: true },
  });
  const accounts = await prisma.account.findMany({ where: { id: { in: [...new Set(grouped.map((g) => g.accountId))] } } });
  const accountById = new Map(accounts.map((a) => [a.id, a]));

  type Row = { account: { code: string; name: string }; debit: number; credit: number };
  const byCurrency = new Map<string, Row[]>();
  for (const g of grouped) {
    const account = accountById.get(g.accountId);
    if (!account) continue;
    const rows = byCurrency.get(g.currency) ?? [];
    rows.push({ account, debit: g._sum.debit ?? 0, credit: g._sum.credit ?? 0 });
    byCurrency.set(g.currency, rows);
  }
  const currencies = [...byCurrency.keys()].sort();

  return (
    <div className="flex flex-col gap-6">
      <p className="text-sm text-ink-muted">{m.ledger.intro}</p>
      {currencies.length === 0 && <p className="text-sm text-ink-muted">{m.ledger.empty}</p>}
      {currencies.map((currency) => {
        const rows = [...byCurrency.get(currency)!].sort((a, b) => a.account.code.localeCompare(b.account.code));
        const totalDebit = rows.reduce((sum, r) => sum + r.debit, 0);
        const totalCredit = rows.reduce((sum, r) => sum + r.credit, 0);
        const balanced = Math.abs(totalDebit - totalCredit) < 0.01;
        return (
          <div key={currency} className={ui.card}>
            <div className="mb-3 flex items-center justify-between">
              <h2 className="font-display text-lg font-semibold" dir="ltr">{currency}</h2>
              <span className={`${ui.chip} ${balanced ? "bg-good-soft text-good" : "bg-critical-soft text-critical"}`}>
                {balanced ? m.ledger.balanced : `${totalDebit.toFixed(2)} ≠ ${totalCredit.toFixed(2)}`}
              </span>
            </div>
            <table className={ui.table}>
              <thead>
                <tr>
                  <th className={ui.th}>{m.ledger.col.account}</th>
                  <th className={ui.th}>{m.ledger.col.debit}</th>
                  <th className={ui.th}>{m.ledger.col.credit}</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((r) => (
                  <tr key={r.account.code}>
                    <td className={ui.td}>
                      <span className="font-mono text-xs text-ink-muted" dir="ltr">{r.account.code}</span> {r.account.name}
                    </td>
                    <td className={`${ui.td} font-mono tabular`} dir="ltr">{r.debit > 0 ? r.debit.toFixed(2) : "—"}</td>
                    <td className={`${ui.td} font-mono tabular`} dir="ltr">{r.credit > 0 ? r.credit.toFixed(2) : "—"}</td>
                  </tr>
                ))}
                <tr>
                  <td className={`${ui.td} font-semibold`}>{m.ledger.total}</td>
                  <td className={`${ui.td} font-mono font-semibold tabular`} dir="ltr">{totalDebit.toFixed(2)}</td>
                  <td className={`${ui.td} font-mono font-semibold tabular`} dir="ltr">{totalCredit.toFixed(2)}</td>
                </tr>
              </tbody>
            </table>
          </div>
        );
      })}
    </div>
  );
}

async function ReconciliationTab({
  m,
  dict,
  siteScope,
}: {
  m: Awaited<ReturnType<typeof getDictionary>>["dict"]["modules"]["finance"];
  dict: Awaited<ReturnType<typeof getDictionary>>["dict"];
  siteScope: Record<string, unknown>;
}) {
  const [payments, supplierPayments, cashTransactions] = await Promise.all([
    prisma.payment.findMany({ where: { reconciled: false }, orderBy: { paidAt: "desc" }, include: { invoice: { include: { customer: true } } } }),
    prisma.supplierPayment.findMany({ where: { reconciled: false }, orderBy: { paidAt: "desc" }, include: { supplierBill: { include: { supplier: true } } } }),
    prisma.cashTransaction.findMany({ where: { reconciled: false, ...siteScope }, orderBy: { occurredAt: "desc" } }),
  ]);

  const rows = [
    ...payments.map((p) => ({ kind: "payment", id: p.id, date: p.paidAt, direction: "IN", amount: p.amount, currency: p.invoice.currency, label: `${p.invoice.invoiceNumber} — ${p.invoice.customer.legalName}` })),
    ...supplierPayments.map((p) => ({ kind: "supplierPayment", id: p.id, date: p.paidAt, direction: "OUT", amount: p.amount, currency: p.supplierBill.currency, label: `${p.supplierBill.billNumber} — ${p.supplierBill.supplier.name}` })),
    ...cashTransactions.map((t) => ({ kind: "cashTransaction", id: t.id, date: t.occurredAt, direction: t.direction, amount: t.amount, currency: t.currency, label: `${t.txnNumber} — ${t.description}` })),
  ].sort((a, b) => b.date.getTime() - a.date.getTime());

  return (
    <div className="flex flex-col gap-4">
      <p className="text-sm text-ink-muted">{m.reconciliation.intro}</p>
      <div className={ui.card}>
        <table className={ui.table}>
          <thead>
            <tr>
              <th className={ui.th}>{m.reconciliation.col.date}</th>
              <th className={ui.th}>{m.reconciliation.col.direction}</th>
              <th className={ui.th}>{m.reconciliation.col.description}</th>
              <th className={ui.th}>{m.reconciliation.col.amount}</th>
              <th className={ui.th}>{dict.field.actions}</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => (
              <tr key={`${r.kind}-${r.id}`}>
                <td className={ui.td}>{fmtDate(r.date)}</td>
                <td className={ui.td}>
                  <span className={`${ui.chip} ${r.direction === "IN" ? "bg-good-soft text-good" : "bg-critical-soft text-critical"}`}>
                    {r.direction === "IN" ? m.cash.in : m.cash.out}
                  </span>
                </td>
                <td className={ui.td}>{r.label}</td>
                <td className={`${ui.td} font-mono`}>{r.amount.toFixed(2)} {r.currency}</td>
                <td className={ui.td}>
                  <form action={reconcileMovement}>
                    <input type="hidden" name="kind" value={r.kind} />
                    <input type="hidden" name="id" value={r.id} />
                    <button className="text-xs font-medium text-accent-strong hover:underline">{m.reconciliation.markReconciled}</button>
                  </form>
                </td>
              </tr>
            ))}
            {rows.length === 0 && (
              <tr><td className={ui.td} colSpan={5}><span className="text-ink-muted">{m.reconciliation.empty}</span></td></tr>
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
}

// Merged from the old standalone /billing module — invoicing customers
// (accounts receivable) is the other half of the AR/AP picture "payable"
// already covers for suppliers, so it belongs here as its own tab rather
// than a separate sidebar entry. Uses the plant-level site scoping
// Invoice/Trip need (plantScopeWhere/tripPlantScopeWhere), not the plain
// siteScope object the other Finance tabs use — Invoice/Trip have no
// siteId scalar of their own (see the Billing module's original comments).
async function BillingTab({
  dict,
  siteId,
}: {
  dict: Awaited<ReturnType<typeof getDictionary>>["dict"];
  siteId: string | null;
}) {
  const bm = dict.modules.billing;
  // eslint-disable-next-line react-hooks/purity
  const nowMs = Date.now();

  const [uninvoicedTrips, invoicesRaw, priceEntries] = await Promise.all([
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
      where: { ...plantScopeWhere(siteId) },
      orderBy: { issueDate: "desc" },
      include: { customer: true, project: true, payments: true, creditNotes: true },
      take: 30,
    }),
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
    const due = invoiceAmountDue(inv);
    const isOverdue = inv.status === "SENT" && due > 0.01 && inv.dueDate.getTime() < nowMs;
    const daysOverdue = isOverdue ? Math.floor((nowMs - inv.dueDate.getTime()) / 86400000) : 0;
    return { ...inv, isOverdue, daysOverdue };
  });

  return (
    <div className="flex flex-col gap-8">
      <div className={ui.card}>
        <h2 className="mb-3 font-display text-lg font-semibold">{bm.readyTitle}</h2>
        <table className={ui.table}>
          <thead>
            <tr>
              <th className={ui.th}>{bm.col.project}</th>
              <th className={ui.th}>{bm.col.customer}</th>
              <th className={ui.th}>{bm.col.ticket}</th>
              <th className={ui.th}>{bm.col.reservation}</th>
              <th className={ui.th}>{bm.col.mix}</th>
              <th className={ui.th}>{bm.col.pourLocation}</th>
              <th className={ui.th}>{bm.col.loadTime}</th>
              <th className={ui.th}>{bm.col.deliveries}</th>
              <th className={ui.th}>{bm.col.volume}</th>
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
                        <button className={ui.button}>{bm.generate}</button>
                      </form>
                    ) : (
                      <span className="text-xs text-warn">{bm.needsPricing([...g.missingMixCodes].join(", "))}</span>
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
                  <span className="text-ink-muted">{bm.empty}</span>
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>

      <div className={ui.card}>
        <h2 className="mb-3 font-display text-lg font-semibold">{bm.invoicesTitle}</h2>
        <table className={ui.table}>
          <thead>
            <tr>
              <th className={ui.th}>{bm.colInvoice.number}</th>
              <th className={ui.th}>{bm.colInvoice.customer}</th>
              <th className={ui.th}>{bm.colInvoice.project}</th>
              <th className={ui.th}>{bm.colInvoice.issued}</th>
              <th className={ui.th}>{bm.colInvoice.due}</th>
              <th className={ui.th}>{bm.colInvoice.total}</th>
              <th className={ui.th}>{bm.colInvoice.status}</th>
            </tr>
          </thead>
          <tbody>
            {invoices.map((inv) => (
              <tr key={inv.id}>
                <td className={ui.td}>
                  <Link href={`/finance/invoices/${inv.id}`} className="font-mono text-xs font-medium text-accent-strong hover:underline" dir="ltr">
                    {inv.invoiceNumber}
                  </Link>
                </td>
                <td className={ui.td}>{inv.customer.legalName}</td>
                <td className={ui.td}>{inv.project?.name ?? "—"}</td>
                <td className={`${ui.td} font-mono text-xs tabular`}>{new Date(inv.issueDate).toLocaleDateString()}</td>
                <td className={`${ui.td} font-mono text-xs tabular`}>{new Date(inv.dueDate).toLocaleDateString()}</td>
                <td className={`${ui.td} font-mono tabular`} dir="ltr">{inv.total.toLocaleString()} {inv.currency}</td>
                <td className={ui.td}>
                  <span className={`${ui.chip} ${invoiceStatusChip[inv.status] ?? ""}`}>{dict.status[inv.status as keyof typeof dict.status] ?? inv.status}</span>
                  {inv.isOverdue && (
                    <span className={`${ui.chip} bg-critical-soft text-critical ms-2`}>{bm.overdue(inv.daysOverdue)}</span>
                  )}
                </td>
              </tr>
            ))}
            {invoices.length === 0 && (
              <tr>
                <td className={ui.td} colSpan={7}>
                  <span className="text-ink-muted">{bm.emptyInvoices}</span>
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>

      <div className={ui.card}>
        <h2 className="mb-1 font-display text-lg font-semibold">{bm.pricingTitle}</h2>
        <p className="mb-3 text-sm text-ink-muted">{bm.pricingSourceHint}</p>
        <table className={ui.table}>
          <thead>
            <tr>
              <th className={ui.th}>{bm.colPrice.customer}</th>
              <th className={ui.th}>{bm.colPrice.mix}</th>
              <th className={ui.th}>{bm.colPrice.price}</th>
            </tr>
          </thead>
          <tbody>
            {priceEntries.map((p) => (
              <tr key={p.id}>
                <td className={ui.td}>{p.customer.legalName}</td>
                <td className={`${ui.td} font-mono text-xs`} dir="ltr">{p.mix.code}</td>
                <td className={`${ui.td} font-mono tabular`} dir="ltr">{p.pricePerM3.toLocaleString()}</td>
              </tr>
            ))}
            {priceEntries.length === 0 && (
              <tr>
                <td className={ui.td} colSpan={3}>
                  <span className="text-ink-muted">{bm.emptyPricing}</span>
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
}
