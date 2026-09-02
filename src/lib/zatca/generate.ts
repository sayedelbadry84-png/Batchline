import { randomUUID } from "crypto";
import { prisma } from "@/lib/prisma";
import { getZatcaReadiness } from "./settings";
import { buildZatcaQrPayload, zatcaTimestamp } from "./qr";
import { buildZatcaInvoiceXml } from "./invoiceXml";
import { hashInvoiceXml } from "./sign";
import { getNextZatcaChainPosition } from "./chain";

export type ZatcaGenerateResult = { ok: true } | { ok: false; reason: "NOT_CONFIGURED" | "NO_PLANT" | "ALREADY_GENERATED" | "NOT_FOUND" };

// Builds and saves this invoice's Phase 1 QR code and UBL XML (unsigned)
// — everything a QR_ONLY readiness level can produce without a real
// ZATCA account. Idempotent by design (refuses to run twice on the same
// invoice, same as every other document-numbering action in this app) —
// re-generating would silently break the hash chain for whatever was
// generated after it.
export async function generateZatcaDocuments(invoiceId: string): Promise<ZatcaGenerateResult> {
  const invoice = await prisma.invoice.findUnique({
    where: { id: invoiceId },
    include: { customer: true, plant: true, lines: true },
  });
  if (!invoice) return { ok: false, reason: "NOT_FOUND" };
  if (invoice.zatcaStatus) return { ok: false, reason: "ALREADY_GENERATED" };
  if (!invoice.plant) return { ok: false, reason: "NO_PLANT" };

  const readiness = await getZatcaReadiness(invoice.plant.siteId);
  if (readiness.level === "NOT_CONFIGURED") return { ok: false, reason: "NOT_CONFIGURED" };

  // Hash chain: shared across invoices AND credit notes at this site — see
  // chain.ts for why this can't just look at the Invoice table alone.
  const { icv, previousHash: previousInvoiceHash } = await getNextZatcaChainPosition(invoice.plant.siteId);

  const uuid = randomUUID();
  const qrCode = buildZatcaQrPayload({
    sellerName: readiness.seller.sellerLegalName,
    vatNumber: readiness.seller.vatNumber,
    timestampIso: zatcaTimestamp(invoice.issueDate),
    invoiceTotal: invoice.total,
    vatTotal: invoice.taxAmount,
  });

  const xml = buildZatcaInvoiceXml({
    invoiceNumber: invoice.invoiceNumber,
    uuid,
    issueDate: invoice.issueDate,
    currency: invoice.currency,
    seller: { legalName: readiness.seller.sellerLegalName, vatNumber: readiness.seller.vatNumber, crNumber: readiness.seller.crNumber },
    buyer: { legalName: invoice.customer.legalName, vatNumber: invoice.customer.taxId },
    lines: invoice.lines.map((l) => ({ description: l.description, volumeM3: l.volumeM3, unitPrice: l.unitPrice, lineTotal: l.lineTotal })),
    subtotal: invoice.subtotal,
    taxRatePct: invoice.taxRatePct,
    taxAmount: invoice.taxAmount,
    total: invoice.total,
    icv,
    previousInvoiceHash,
    qrCode,
  });

  await prisma.invoice.update({
    where: { id: invoiceId },
    data: {
      zatcaUuid: uuid,
      zatcaInvoiceHash: hashInvoiceXml(xml),
      zatcaPreviousHash: previousInvoiceHash,
      zatcaQrCode: qrCode,
      zatcaXml: xml,
      zatcaStatus: "GENERATED",
      zatcaGeneratedAt: new Date(),
    },
  });

  return { ok: true };
}
