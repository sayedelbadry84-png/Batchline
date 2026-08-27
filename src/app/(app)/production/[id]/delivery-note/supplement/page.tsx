import { notFound } from "next/navigation";
import Link from "next/link";
import { prisma } from "@/lib/prisma";
import { requirePageAccess } from "@/lib/session";
import { getDictionary } from "@/lib/i18n";
import { PrintButton } from "@/components/PrintButton";

// A corrected/amended delivery document (ملحق تذكرة توريد) — issued only
// when a load was closed with a QUALITY_REJECTED return, showing the
// customer the REAL accepted quantity (original loaded qty minus the
// rejected/wasted qty) after the fact, since the original delivery note
// (delivery-note/page.tsx) was already printed at load time, before the
// rejection happened, and always shows the full loaded quantity. Same
// bilingual EN+AR hardcoded label pattern as the original — see that
// file's own comment for why this isn't run through the app's dict.
const L = {
  docTitleAr: "ملحق تذكرة توريد خرسانة جاهزة",
  docTitleEn: "RMC Delivery Note — Supplement",
  supplementStamp: "ملحق يصحّح الكمية المعتمدة من العميل بعد استبعاد كمية مرفوضة لأسباب جودة",
  supplementStampEn: "Corrects the customer-accepted quantity after excluding a quality-rejected volume",
  bookingRef: "Booking Ref. رقم التذكرة",
  customerCode: "Code كود العميل",
  customerName: "Customer Name اسم العميل",
  item: "Item رمز الصنف",
  itemDescription: "Item Description وصف الصنف",
  originalQty: "Original Loaded Qty الكمية الأصلية بالشاحنة",
  rejectedQty: "Rejected / Wasted Qty الكمية المرفوضة والمهدرة",
  acceptedQty: "Accepted Qty الكمية المعتمدة من العميل",
  rejectionReason: "Rejection Reason سبب الرفض",
  qualitySignoff: "Quality Sign-off اعتماد الجودة",
  qualityFinding: "Quality Finding نتيجة فحص الجودة",
  pending: "Pending اعتماد معلّق",
  operator: "Operator",
  qualityControl: "Quality Control",
  customer: "Customer",
} as const;

const cellBorder = { border: "1px solid #000" };

// Editable, like the main delivery note (production/[id]/delivery-note/
// page.tsx) — same reasoning: what prints is whatever's currently in the
// field, nothing here writes back to stored data. The two Quality fields
// below deliberately stay read-only (ReadOnlyCell) — this document exists
// specifically to carry the real Quality sign-off, so letting that one
// field be typed over would defeat the point of it.
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

function ReadOnlyCell({ label, value, className = "" }: { label: string; value: string | number | null; className?: string }) {
  return (
    <div style={cellBorder} className={`px-2 py-1.5 ${className}`}>
      <div style={{ fontSize: "10px" }} className="font-semibold leading-tight">{label}</div>
      <div style={{ fontSize: "13px" }} className="mt-0.5" dir="ltr">{value ?? "—"}</div>
    </div>
  );
}

const REASON_LABEL: Record<string, string> = {
  QUALITY_REJECTED: "Quality rejected رفض جودة",
};

export default async function DeliveryNoteSupplementPage({ params }: { params: Promise<{ id: string }> }) {
  await requirePageAccess("production");
  const { id } = await params;
  const { dict } = await getDictionary();

  const ticket = await prisma.batchTicket.findUnique({
    where: { id },
    include: {
      reservation: { include: { project: { include: { customer: true } } } },
      mix: true,
      plant: { include: { site: true } },
      trip: { include: { truck: true, driver: true, drumReturn: { include: { wasteMemo: { include: { approvedBy: true } } } } } },
    },
  });
  // Only exists once there's an actual quality-rejection return on file —
  // no return, no rejection, nothing to correct.
  if (!ticket || !ticket.trip || ticket.trip.drumReturn?.reasonCode !== "QUALITY_REJECTED") notFound();

  const { trip, reservation, mix, plant } = ticket;
  const drumReturn = trip.drumReturn!;
  const wasteMemo = drumReturn.wasteMemo;

  return (
    <div className="mx-auto flex max-w-3xl flex-col gap-4">
      <div className="no-print flex items-center justify-between gap-3">
        <p className="text-xs text-ink-muted">{dict.modules.production.detail.deliveryNoteEditableHint}</p>
        <PrintButton label={dict.modules.production.detail.printSupplement} />
      </div>

      <div dir="ltr" style={{ background: "#fff", color: "#000" }} className="flex flex-col gap-3 p-6">
        <div style={{ ...cellBorder, display: "grid", gridTemplateColumns: "1fr" }} className="bg-critical-soft">
          <div className="p-2 text-center">
            <div className="text-lg font-bold">{L.docTitleAr}</div>
            <div className="text-base font-semibold">{L.docTitleEn}</div>
            <div className="mt-1 text-xs">
              {plant.name} — {plant.site.name}
              <span className="ms-2 font-mono">{plant.site.code}</span>
              <span className="ms-2">{new Date(trip.dischargeEnd ?? trip.batchTime).toLocaleDateString("en-GB", { day: "2-digit", month: "2-digit", year: "numeric" })}</span>
            </div>
            <div className="mt-1 text-xs font-semibold">{L.supplementStamp}</div>
            <div className="text-xs">{L.supplementStampEn}</div>
          </div>
        </div>

        <div className="grid grid-cols-3">
          <Cell label={L.bookingRef} value={ticket.ticketNumber} />
          <Cell label={L.customerCode} value={reservation.project.customer.code ?? "—"} />
          <Cell label={L.customerName} value={reservation.project.customer.legalName} className="text-end" />
        </div>

        <div className="grid grid-cols-2">
          <Cell label={L.item} value={mix.code} />
          <Cell label={L.itemDescription} value={mix.grade} className="text-end" />
        </div>

        <div className="grid grid-cols-3">
          <Cell label={L.originalQty} value={ticket.volumeM3.toFixed(2)} className="text-center" />
          <Cell label={L.rejectedQty} value={drumReturn.returnedVolumeM3.toFixed(2)} className="text-center" />
          <Cell
            label={L.acceptedQty}
            value={(trip.volumeDeliveredM3 ?? ticket.volumeM3 - drumReturn.returnedVolumeM3).toFixed(2)}
            className="text-center font-bold"
          />
        </div>

        <div className="grid grid-cols-2">
          <Cell label={L.rejectionReason} value={REASON_LABEL[drumReturn.reasonCode ?? ""] ?? drumReturn.reasonCode} />
          <ReadOnlyCell
            label={L.qualitySignoff}
            value={
              wasteMemo?.status === "APPROVED" && wasteMemo.approvedBy
                ? `${wasteMemo.approvedBy.name} — ${new Date(wasteMemo.approvedAt!).toLocaleDateString("en-GB")}`
                : L.pending
            }
            className={wasteMemo?.status === "APPROVED" ? "text-end" : "text-end text-critical"}
          />
        </div>

        {wasteMemo?.approvalNote && (
          <div className="grid grid-cols-1">
            <ReadOnlyCell label={L.qualityFinding} value={wasteMemo.approvalNote} />
          </div>
        )}

        <div className="grid grid-cols-4">
          <Cell label={L.operator} value={trip.driver.name} />
          <Cell label="Truck الشاحنة" value={trip.truck.code} />
          <Cell label={L.qualityControl} value={wasteMemo?.approvedBy?.name ?? null} />
          <Cell label={L.customer} value={null} />
        </div>
      </div>

      <div className="no-print">
        <Link href={`/production/${ticket.id}`} className="text-sm font-medium text-accent-strong hover:underline">
          ← {dict.field.cancel}
        </Link>
      </div>
    </div>
  );
}
