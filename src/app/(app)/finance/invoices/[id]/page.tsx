import { notFound } from "next/navigation";
import Link from "next/link";
import QRCode from "qrcode";
import { prisma } from "@/lib/prisma";
import { ui } from "@/lib/ui";
import { requirePageAccess } from "@/lib/session";
import { getDictionary } from "@/lib/i18n";
import {
  markInvoiceSent,
  recordPayment,
  cancelInvoice,
  issueCreditNote,
  generateZatcaInvoiceDocuments,
  submitZatcaInvoiceForClearance,
  generateZatcaCreditNoteDocumentsAction,
  submitZatcaCreditNoteForClearanceAction,
} from "../../../billing/actions";
import { getActiveSiteId } from "@/lib/siteScope";
import { invoiceAmountDue } from "@/lib/billing";
import { getZatcaReadiness } from "@/lib/zatca/settings";

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
  const user = await requirePageAccess("finance");
  const { id } = await params;
  const { dict } = await getDictionary();
  const m = dict.modules.billing;
  const d = m.detail;

  const invoice = await prisma.invoice.findUnique({
    where: { id },
    include: {
      customer: true,
      project: true,
      plant: true,
      lines: { include: { trip: { include: { truck: true, batchTicket: { include: { mix: true, reservation: true } } } } } },
      payments: { orderBy: { paidAt: "desc" } },
      creditNotes: { include: { issuedBy: true }, orderBy: { createdAt: "desc" } },
    },
  });
  if (!invoice) notFound();
  const siteId = await getActiveSiteId(user);
  if (siteId !== null && invoice.plant?.siteId !== siteId) notFound();

  const amountDue = invoiceAmountDue(invoice);
  const canRecordPayment = invoice.status === "SENT" || invoice.status === "DRAFT";
  const canIssueCreditNote = canRecordPayment && amountDue > 0.01;
  const canCancel = (invoice.status === "DRAFT" || invoice.status === "SENT") && invoice.payments.length === 0 && invoice.creditNotes.length === 0;

  const zatcaReadiness = invoice.plant ? await getZatcaReadiness(invoice.plant.siteId) : ({ level: "NOT_CONFIGURED" } as const);
  const zatcaQrDataUrl = invoice.zatcaQrCode ? await QRCode.toDataURL(invoice.zatcaQrCode, { margin: 1, width: 180 }) : null;

  return (
    <div className="flex flex-col gap-8">
      <header className="flex items-start justify-between gap-4">
        <div>
          <div className={ui.eyebrow}>{d.eyebrow}</div>
          <h1 className={ui.h1} dir="ltr">{invoice.invoiceNumber}</h1>
          <p className={ui.intro}>
            {d.billTo}: {invoice.customer.legalName}
            {invoice.project && ` · ${d.project}: ${invoice.project.name}`}
            {invoice.plant && ` · ${invoice.plant.name}`}
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
              <th className={ui.th}>{d.colLine.reservation}</th>
              <th className={ui.th}>{d.colLine.pourLocation}</th>
              <th className={ui.th}>{d.colLine.volume}</th>
              <th className={ui.th}>{d.colLine.unitPrice}</th>
              <th className={ui.th}>{d.colLine.lineTotal}</th>
            </tr>
          </thead>
          <tbody>
            {invoice.lines.map((l) => (
              <tr key={l.id}>
                <td className={`${ui.td} font-mono text-xs`} dir="ltr">{l.description}</td>
                <td className={`${ui.td} font-mono text-xs`} dir="ltr">{l.trip.batchTicket.reservation.reservationNumber}</td>
                <td className={`${ui.td} text-xs`}>{l.trip.batchTicket.reservation.siteLocation ?? "—"}</td>
                <td className={`${ui.td} font-mono tabular`}>{l.volumeM3} m³</td>
                <td className={`${ui.td} font-mono tabular`} dir="ltr">{l.unitPrice.toLocaleString()}</td>
                <td className={`${ui.td} font-mono tabular`} dir="ltr">{l.lineTotal.toLocaleString()}</td>
              </tr>
            ))}
            {invoice.lines.length === 0 && (
              <tr>
                <td className={ui.td} colSpan={6}>
                  <span className="text-ink-muted">{d.emptyLinesCancelled}</span>
                </td>
              </tr>
            )}
          </tbody>
        </table>
        <div className="mt-3 flex flex-col items-end gap-1 border-t border-border pt-3 text-sm">
          <div className="flex gap-8">
            <span className="text-ink-muted">{d.subtotal}</span>
            <span className="font-mono tabular" dir="ltr">{invoice.subtotal.toLocaleString()} {invoice.currency}</span>
          </div>
          {invoice.taxAmount > 0 && (
            <div className="flex gap-8">
              <span className="text-ink-muted">{d.taxLine(invoice.taxLabel, invoice.taxRatePct)}</span>
              <span className="font-mono tabular" dir="ltr">{invoice.taxAmount.toLocaleString()} {invoice.currency}</span>
            </div>
          )}
          <div className="flex gap-8 font-semibold">
            <span>{d.total}</span>
            <span className="font-mono tabular" dir="ltr">{invoice.total.toLocaleString()} {invoice.currency}</span>
          </div>
        </div>
      </div>

      <div className={ui.card}>
        <h2 className="mb-3 font-display text-lg font-semibold">{d.zatcaTitle}</h2>
        {zatcaReadiness.level === "NOT_CONFIGURED" && !invoice.zatcaStatus ? (
          <p className="text-sm text-ink-muted">{d.zatcaNotConfigured}</p>
        ) : (
          <div className="flex flex-wrap items-start gap-6">
            <div className="flex flex-col gap-2 text-sm">
              {invoice.zatcaStatus ? (
                <span className={`${ui.chip} w-fit ${invoice.zatcaStatus === "CLEARED" ? "bg-good-soft text-good" : invoice.zatcaStatus === "FAILED" ? "bg-critical-soft text-critical" : "bg-warn-soft text-warn"}`}>
                  {d.zatcaStatusLabel[invoice.zatcaStatus as keyof typeof d.zatcaStatusLabel] ?? invoice.zatcaStatus}
                </span>
              ) : (
                <span className={`${ui.chip} w-fit bg-surface-alt text-ink-muted`}>{d.zatcaQrOnlyHint}</span>
              )}

              {invoice.zatcaUuid && (
                <div>
                  <span className="text-ink-muted">{d.zatcaUuid}: </span>
                  <span className="font-mono text-xs" dir="ltr">{invoice.zatcaUuid}</span>
                </div>
              )}
              {invoice.zatcaInvoiceHash && (
                <div>
                  <span className="text-ink-muted">{d.zatcaHash}: </span>
                  <span className="break-all font-mono text-xs" dir="ltr">{invoice.zatcaInvoiceHash}</span>
                </div>
              )}
              {invoice.zatcaErrorMessage && (
                <div className="text-critical">
                  <span className="text-ink-muted">{d.zatcaError}: </span>
                  <span className="text-xs">{invoice.zatcaErrorMessage}</span>
                </div>
              )}

              {!invoice.zatcaStatus && (
                <form action={generateZatcaInvoiceDocuments}>
                  <input type="hidden" name="id" value={invoice.id} />
                  <button type="submit" className={`${ui.button} mt-1 w-fit`}>{d.zatcaGenerate}</button>
                </form>
              )}
              {invoice.zatcaStatus && invoice.zatcaStatus !== "CLEARED" && (
                zatcaReadiness.level === "CLEARANCE_READY" ? (
                  <form action={submitZatcaInvoiceForClearance}>
                    <input type="hidden" name="id" value={invoice.id} />
                    <button type="submit" className={`${ui.button} mt-1 w-fit`}>{d.zatcaSubmit}</button>
                  </form>
                ) : (
                  <p className="max-w-sm text-xs text-ink-muted">{d.zatcaClearanceNotReady}</p>
                )
              )}
            </div>

            {zatcaQrDataUrl && (
              <div className="flex flex-col items-center gap-1">
                {/* eslint-disable-next-line @next/next/no-img-element -- a server-rendered data: URL, not an optimizable remote/static asset */}
                <img src={zatcaQrDataUrl} alt={d.zatcaQrLabel} width={140} height={140} className="rounded-md border border-border" />
                <span className="text-xs text-ink-muted">{d.zatcaQrLabel}</span>
              </div>
            )}
          </div>
        )}
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

          {canIssueCreditNote && (
            <form action={issueCreditNote} className={`${ui.card} flex flex-col gap-3`}>
              <input type="hidden" name="invoiceId" value={invoice.id} />
              <h2 className="font-display text-lg font-semibold">{d.issueCreditNoteTitle}</h2>
              <div>
                <label className={ui.label}>{d.fCreditNote.amount}</label>
                <input name="amount" type="number" step="0.01" max={amountDue || undefined} required className={ui.input} />
              </div>
              <div>
                <label className={ui.label}>{d.fCreditNote.reason}</label>
                <select name="reason" required className={ui.select}>
                  <option value="RETURN">{d.creditReasonLabel.RETURN}</option>
                  <option value="PRICE_ADJUSTMENT">{d.creditReasonLabel.PRICE_ADJUSTMENT}</option>
                  <option value="QUALITY_ISSUE">{d.creditReasonLabel.QUALITY_ISSUE}</option>
                  <option value="GOODWILL">{d.creditReasonLabel.GOODWILL}</option>
                  <option value="OTHER">{d.creditReasonLabel.OTHER}</option>
                </select>
              </div>
              <div>
                <label className={ui.label}>{d.fCreditNote.notes}</label>
                <input name="notes" className={ui.input} />
              </div>
              <button type="submit" className={`${ui.button} mt-2`}>
                {d.issueCreditNote}
              </button>
            </form>
          )}
        </div>
      </div>

      <div className={ui.card}>
        <h2 className="mb-3 font-display text-lg font-semibold">{d.creditNotesTitle}</h2>
        <table className={ui.table}>
          <thead>
            <tr>
              <th className={ui.th}>{d.colCreditNote.number}</th>
              <th className={ui.th}>{d.colCreditNote.amount}</th>
              <th className={ui.th}>{d.colCreditNote.reason}</th>
              <th className={ui.th}>{d.colCreditNote.notes}</th>
              <th className={ui.th}>{d.colCreditNote.issuedBy}</th>
              <th className={ui.th}>{d.colCreditNote.date}</th>
              {zatcaReadiness.level !== "NOT_CONFIGURED" && <th className={ui.th}>{d.colCreditNote.zatca}</th>}
            </tr>
          </thead>
          <tbody>
            {invoice.creditNotes.map((c) => (
              <tr key={c.id}>
                <td className={`${ui.td} font-mono text-xs`}>{c.creditNoteNumber}</td>
                <td className={`${ui.td} font-mono tabular`} dir="ltr">{c.amount.toLocaleString()}</td>
                <td className={ui.td}>{d.creditReasonLabel[c.reason as keyof typeof d.creditReasonLabel] ?? c.reason}</td>
                <td className={`${ui.td} text-xs text-ink-muted`}>{c.notes ?? "—"}</td>
                <td className={ui.td}>{c.issuedBy.name}</td>
                <td className={`${ui.td} font-mono text-xs tabular`}>{new Date(c.createdAt).toLocaleDateString()}</td>
                {zatcaReadiness.level !== "NOT_CONFIGURED" && (
                  <td className={ui.td}>
                    {c.zatcaStatus ? (
                      <div className="flex flex-col items-start gap-1">
                        <span className={`${ui.chip} w-fit text-xs ${c.zatcaStatus === "CLEARED" ? "bg-good-soft text-good" : c.zatcaStatus === "FAILED" ? "bg-critical-soft text-critical" : "bg-warn-soft text-warn"}`}>
                          {d.zatcaStatusLabel[c.zatcaStatus as keyof typeof d.zatcaStatusLabel] ?? c.zatcaStatus}
                        </span>
                        {c.zatcaStatus !== "CLEARED" && zatcaReadiness.level === "CLEARANCE_READY" && (
                          <form action={submitZatcaCreditNoteForClearanceAction}>
                            <input type="hidden" name="id" value={c.id} />
                            <button type="submit" className="text-xs font-medium text-accent-strong hover:underline">{d.zatcaSubmit}</button>
                          </form>
                        )}
                      </div>
                    ) : (
                      <form action={generateZatcaCreditNoteDocumentsAction}>
                        <input type="hidden" name="id" value={c.id} />
                        <button type="submit" className="text-xs font-medium text-accent-strong hover:underline">{d.zatcaGenerate}</button>
                      </form>
                    )}
                  </td>
                )}
              </tr>
            ))}
            {invoice.creditNotes.length === 0 && (
              <tr>
                <td className={ui.td} colSpan={zatcaReadiness.level !== "NOT_CONFIGURED" ? 7 : 6}>
                  <span className="text-ink-muted">{d.emptyCreditNotes}</span>
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>

      <Link href="/finance?tab=billing" className="text-sm font-medium text-accent-strong hover:underline">
        {d.back}
      </Link>
    </div>
  );
}
