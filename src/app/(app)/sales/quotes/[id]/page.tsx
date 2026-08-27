import { notFound } from "next/navigation";
import Link from "next/link";
import { prisma } from "@/lib/prisma";
import { requirePageAccess } from "@/lib/session";
import { getDictionary } from "@/lib/i18n";
import { PrintButton } from "@/components/PrintButton";
import { convertQuoteLineToReservation } from "../../actions";

const cellBorder = { border: "1px solid #000" };

// Same editable-print-preview pattern as production/[id]/delivery-note —
// what prints is whatever's currently in the field, nothing here writes
// back to the stored Quote/QuoteLine rows. See dict.modules.sales.quoteDoc.editableHint.
function Cell({ label, value, className = "" }: { label: string; value: string | number | null; className?: string }) {
  return (
    <div style={cellBorder} className="px-2 py-1.5">
      <div style={{ fontSize: "10px" }} className="font-semibold leading-tight">{label}</div>
      <input
        type="text"
        defaultValue={value ?? ""}
        placeholder="—"
        dir="ltr"
        style={{ fontSize: "13px", color: "#000" }}
        className={`mt-0.5 w-full border-0 bg-transparent p-0 outline-none focus:bg-yellow-50 ${className}`}
      />
    </div>
  );
}

export default async function QuoteDetailPage({ params }: { params: Promise<{ id: string }> }) {
  await requirePageAccess("sales");
  const { id } = await params;
  const { dict } = await getDictionary();
  const m = dict.modules.sales;
  const d = m.quoteDoc;

  const quote = await prisma.quote.findUnique({
    where: { id },
    include: {
      customer: true,
      project: true,
      site: true,
      preparedBy: true,
      lines: { include: { mix: true, reservation: true } },
    },
  });
  if (!quote) notFound();

  return (
    <div className="mx-auto flex max-w-3xl flex-col gap-4">
      <div className="no-print flex items-center justify-between gap-3">
        <Link href="/sales?tab=quotes" className="text-sm font-medium text-accent-strong hover:underline">
          ← {dict.field.cancel}
        </Link>
        <div className="flex items-center gap-3">
          <p className="text-xs text-ink-muted">{d.editableHint}</p>
          <PrintButton label={d.print} />
        </div>
      </div>

      <div dir="ltr" style={{ background: "#fff", color: "#000" }} className="flex flex-col gap-3 p-6">
        <div style={{ ...cellBorder }} className="p-2 text-center">
          <div className="text-lg font-bold">{d.docTitleAr}</div>
          <div className="text-base font-semibold">{d.docTitleEn}</div>
          <div className="mt-1 text-xs">{quote.site.name} — {quote.site.code}</div>
        </div>

        <div className="grid grid-cols-3">
          <Cell label={d.quoteNumber} value={quote.quoteNumber} />
          <Cell label={d.date} value={new Date(quote.createdAt).toLocaleDateString("en-GB")} className="text-center" />
          <Cell label={d.validUntil} value={quote.validUntil ? new Date(quote.validUntil).toLocaleDateString("en-GB") : null} className="text-end" />
        </div>

        <div className="grid grid-cols-2">
          <Cell label={d.customer} value={quote.customer.legalName} />
          <Cell label={d.project} value={quote.project?.name ?? null} className="text-end" />
        </div>

        <div style={cellBorder}>
          <table className="w-full border-collapse text-sm">
            <thead>
              <tr>
                <th style={{ fontSize: "10px" }} className="border-b border-black px-2 py-1.5 text-start font-semibold">{d.col.mix}</th>
                <th style={{ fontSize: "10px" }} className="border-b border-black px-2 py-1.5 text-center font-semibold">{d.col.volume}</th>
                <th style={{ fontSize: "10px" }} className="border-b border-black px-2 py-1.5 text-center font-semibold">{d.col.unitPrice}</th>
                <th style={{ fontSize: "10px" }} className="border-b border-black px-2 py-1.5 text-end font-semibold">{d.col.lineTotal}</th>
              </tr>
            </thead>
            <tbody>
              {quote.lines.map((l) => (
                <tr key={l.id}>
                  <td className="px-2 py-1.5 text-sm">{l.mix.code} — {l.mix.grade}</td>
                  <td className="px-2 py-1.5 text-center font-mono text-sm">{l.estimatedVolumeM3.toFixed(1)}</td>
                  <td className="px-2 py-1.5 text-center font-mono text-sm">{l.unitPrice.toFixed(2)}</td>
                  <td className="px-2 py-1.5 text-end font-mono text-sm">{l.lineTotal.toFixed(2)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>

        <div className="grid grid-cols-2">
          <div />
          <div style={cellBorder} className="p-2 text-end text-sm">
            <div className="flex justify-between"><span>{d.subtotal}</span><span className="font-mono">{quote.subtotal.toFixed(2)} {quote.currency}</span></div>
            <div className="flex justify-between"><span>{quote.taxLabel} ({quote.taxRatePct}%)</span><span className="font-mono">{quote.taxAmount.toFixed(2)} {quote.currency}</span></div>
            <div className="mt-1 flex justify-between border-t border-black pt-1 font-bold"><span>{d.total}</span><span className="font-mono">{quote.total.toFixed(2)} {quote.currency}</span></div>
          </div>
        </div>

        {quote.notes && (
          <div className="grid grid-cols-1">
            <Cell label={d.notes} value={quote.notes} />
          </div>
        )}

        <div className="grid grid-cols-2">
          <Cell label={d.preparedBy} value={quote.preparedBy.name} />
          <Cell label={d.status} value={m.quotes.statusLabel[quote.status as keyof typeof m.quotes.statusLabel] ?? quote.status} className="text-end" />
        </div>
      </div>

      {quote.status === "ACCEPTED" && (
        <div className="no-print flex flex-col gap-2">
          <h2 className="font-display text-sm font-semibold">{d.convertToReservation}</h2>
          {quote.lines.map((l) => (
            <div key={l.id} className="flex items-center justify-between rounded-md border border-border p-2 text-sm">
              <span>{l.mix.code} — {l.estimatedVolumeM3.toFixed(1)} m³</span>
              {l.reservation ? (
                <span className="text-xs text-ink-muted">{d.alreadyConverted}</span>
              ) : (
                <form action={convertQuoteLineToReservation}>
                  <input type="hidden" name="quoteLineId" value={l.id} />
                  <button className="rounded-md border border-border px-3 py-1.5 text-xs hover:bg-surface-alt">{d.convertToReservation}</button>
                </form>
              )}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
