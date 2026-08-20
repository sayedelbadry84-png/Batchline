import { notFound } from "next/navigation";
import Link from "next/link";
import { prisma } from "@/lib/prisma";
import { ui } from "@/lib/ui";
import { requirePageAccess } from "@/lib/session";
import { getDictionary } from "@/lib/i18n";
import { markInvoiceSent, recordPayment, cancelInvoice } from "../actions";

const statusChip: Record<string, string> = {
  DRAFT: "bg-surface-alt text-ink-muted",
  SENT: "bg-info-soft text-ink",
  PAID: "bg-good-soft text-good",
  CANCELLED: "bg-critical-soft text-critical",
};

export default async function InvoiceDetailPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  await requirePageAccess("billing");
  const { id } = await params;
  const { dict } = await getDictionary();
  const m = dict.modules.billing;
  const d = m.detail;

  const invoice = await prisma.invoice.findUnique({
    where: { id },
    include: {
      customer: true,
      project: true,
      lines: { include: { trip: { include: { truck: true } } } },
      payments: { orderBy: { paidAt: "desc" } },
    },
  });
  if (!invoice) notFound();

  const paid = invoice.payments.reduce((sum, p) => sum + p.amount, 0);
  const amountDue = Math.max(0, invoice.total - paid);
  const canRecordPayment = invoice.status === "SENT" || invoice.status === "DRAFT";
  const canCancel = (invoice.status === "DRAFT" || invoice.status === "SENT") && invoice.payments.length === 0;

  return (
    <div className="flex flex-col gap-8">
      <header className="flex items-start justify-between gap-4">
        <div>
          <div className={ui.eyebrow}>{d.eyebrow}</div>
          <h1 className={ui.h1} dir="ltr">{invoice.invoiceNumber}</h1>
          <p className={ui.intro}>
            {d.billTo}: {invoice.customer.legalName}
            {invoice.project && ` · ${d.project}: ${invoice.project.name}`}
          </p>
        </div>
        <span className={`${ui.chip} ${statusChip[invoice.status] ?? ""}`}>
          {dict.status[invoice.status as keyof typeof dict.status] ?? invoice.status}
        </span>
      </header>

      <div className="grid grid-cols-4 gap-4">
        <div className={ui.card}>
          <div className="font-mono text-xs text-ink-muted uppercase">{d.issued}</div>
          <div className="mt-1 font-mono text-lg tabular">{new Date(invoice.issueDate).toLocaleDateString()}</div>
        </div>
        <div className={ui.card}>
          <div className="font-mono text-xs text-ink-muted uppercase">{d.due}</div>
          <div className="mt-1 font-mono text-lg tabular">{new Date(invoice.dueDate).toLocaleDateString()}</div>
        </div>
        <div className={ui.card}>
          <div className="font-mono text-xs text-ink-muted uppercase">{d.total}</div>
          <div className="mt-1 font-mono text-lg tabular" dir="ltr">{invoice.total.toLocaleString()} {invoice.currency}</div>
        </div>
        <div className={ui.card}>
          <div className="font-mono text-xs text-ink-muted uppercase">{d.amountDue}</div>
          <div className="mt-1 font-mono text-lg tabular" dir="ltr">{amountDue.toLocaleString()} {invoice.currency}</div>
        </div>
      </div>

      <div className={ui.card}>
        <h2 className="mb-3 font-display text-lg font-semibold">{d.linesTitle}</h2>
        <table className={ui.table}>
          <thead>
            <tr>
              <th className={ui.th}>{d.colLine.description}</th>
              <th className={ui.th}>{d.colLine.volume}</th>
              <th className={ui.th}>{d.colLine.unitPrice}</th>
              <th className={ui.th}>{d.colLine.lineTotal}</th>
            </tr>
          </thead>
          <tbody>
            {invoice.lines.map((l) => (
              <tr key={l.id}>
                <td className={`${ui.td} font-mono text-xs`} dir="ltr">{l.description}</td>
                <td className={`${ui.td} font-mono tabular`}>{l.volumeM3} m³</td>
                <td className={`${ui.td} font-mono tabular`} dir="ltr">{l.unitPrice.toLocaleString()}</td>
                <td className={`${ui.td} font-mono tabular`} dir="ltr">{l.lineTotal.toLocaleString()}</td>
              </tr>
            ))}
            {invoice.lines.length === 0 && (
              <tr>
                <td className={ui.td} colSpan={4}>
                  <span className="text-ink-muted">{d.emptyLinesCancelled}</span>
                </td>
              </tr>
            )}
          </tbody>
        </table>
        <div className="mt-3 flex justify-end gap-8 border-t border-border pt-3 text-sm">
          <span className="text-ink-muted">{d.subtotal}</span>
          <span className="font-mono tabular" dir="ltr">{invoice.subtotal.toLocaleString()} {invoice.currency}</span>
        </div>
      </div>

      <div className="grid grid-cols-2 gap-6">
        <div className={ui.card}>
          <h2 className="mb-3 font-display text-lg font-semibold">{d.paymentsTitle}</h2>
          <table className={ui.table}>
            <thead>
              <tr>
                <th className={ui.th}>{d.colPayment.amount}</th>
                <th className={ui.th}>{d.colPayment.date}</th>
                <th className={ui.th}>{d.colPayment.method}</th>
                <th className={ui.th}>{d.colPayment.reference}</th>
              </tr>
            </thead>
            <tbody>
              {invoice.payments.map((p) => (
                <tr key={p.id}>
                  <td className={`${ui.td} font-mono tabular`} dir="ltr">{p.amount.toLocaleString()}</td>
                  <td className={`${ui.td} font-mono text-xs tabular`}>{new Date(p.paidAt).toLocaleDateString()}</td>
                  <td className={ui.td}>{p.method ?? "—"}</td>
                  <td className={`${ui.td} font-mono text-xs`}>{p.reference ?? "—"}</td>
                </tr>
              ))}
              {invoice.payments.length === 0 && (
                <tr>
                  <td className={ui.td} colSpan={4}>
                    <span className="text-ink-muted">{d.emptyPayments}</span>
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>

        <div className="flex flex-col gap-4">
          {invoice.status === "DRAFT" && (
            <form action={markInvoiceSent} className={`${ui.card} flex items-center justify-between`}>
              <input type="hidden" name="id" value={invoice.id} />
              <span className="text-sm text-ink-muted">{invoice.invoiceNumber}</span>
              <button type="submit" className={ui.button}>{d.markSent}</button>
            </form>
          )}

          {canCancel && (
            <form action={cancelInvoice} className={`${ui.card} flex items-center justify-between`}>
              <input type="hidden" name="id" value={invoice.id} />
              <span className="text-xs text-ink-muted">{d.cancelHint}</span>
              <button type="submit" className="rounded-md border border-critical px-4 py-2 text-sm font-medium text-critical hover:bg-critical-soft">
                {d.cancelInvoice}
              </button>
            </form>
          )}

          {canRecordPayment && (
            <form action={recordPayment} className={`${ui.card} flex flex-col gap-3`}>
              <input type="hidden" name="invoiceId" value={invoice.id} />
              <h2 className="font-display text-lg font-semibold">{d.recordPaymentTitle}</h2>
              <div>
                <label className={ui.label}>{d.fPayment.amount}</label>
                <input name="amount" type="number" step="0.01" max={amountDue || undefined} required className={ui.input} />
              </div>
              <div>
                <label className={ui.label}>{d.fPayment.method}</label>
                <select name="method" className={ui.select}>
                  <option value="CASH">{d.methodCash}</option>
                  <option value="BANK_TRANSFER">{d.methodTransfer}</option>
                  <option value="CHEQUE">{d.methodCheque}</option>
                </select>
              </div>
              <div>
                <label className={ui.label}>{d.fPayment.reference}</label>
                <input name="reference" className={ui.input} dir="ltr" />
              </div>
              <button type="submit" className={`${ui.button} mt-2`}>
                {d.recordPayment}
              </button>
            </form>
          )}
        </div>
      </div>

      <Link href="/billing" className="text-sm font-medium text-accent-strong hover:underline">
        {d.back}
      </Link>
    </div>
  );
}
