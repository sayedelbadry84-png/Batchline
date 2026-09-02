import { randomUUID } from "crypto";
import { prisma } from "@/lib/prisma";
import { getZatcaReadiness } from "./settings";
import { buildZatcaQrPayload, zatcaTimestamp } from "./qr";
import { buildZatcaInvoiceXml } from "./invoiceXml";
import { hashInvoiceXml, signInvoiceXml } from "./sign";
import { getNextZatcaChainPosition } from "./chain";

// A credit note is the only legal way to amend an already-issued
// invoice, so ZATCA requires it to go through the same QR/XML generation
// and Phase 2 clearance pipeline as the invoice it amends — see
// src/lib/zatca/generate.ts and submit.ts, which this closely mirrors.
// The one real difference: CreditNote.amount (see its schema comment) is
// always VAT-inclusive, so the subtotal/tax split has to be derived here
// rather than read off stored fields the way an Invoice's already are.

export type ZatcaCreditNoteGenerateResult = { ok: true } | { ok: false; reason: "NOT_CONFIGURED" | "NO_PLANT" | "ALREADY_GENERATED" | "NOT_FOUND" };

export async function generateZatcaCreditNoteDocuments(creditNoteId: string): Promise<ZatcaCreditNoteGenerateResult> {
  const creditNote = await prisma.creditNote.findUnique({
    where: { id: creditNoteId },
    include: { invoice: { include: { customer: true, plant: true } } },
  });
  if (!creditNote) return { ok: false, reason: "NOT_FOUND" };
  if (creditNote.zatcaStatus) return { ok: false, reason: "ALREADY_GENERATED" };
  if (!creditNote.invoice.plant) return { ok: false, reason: "NO_PLANT" };

  const readiness = await getZatcaReadiness(creditNote.invoice.plant.siteId);
  if (readiness.level === "NOT_CONFIGURED") return { ok: false, reason: "NOT_CONFIGURED" };

  const { icv, previousHash: previousInvoiceHash } = await getNextZatcaChainPosition(creditNote.invoice.plant.siteId);

  const taxRatePct = creditNote.invoice.taxRatePct;
  const subtotal = taxRatePct > 0 ? creditNote.amount / (1 + taxRatePct / 100) : creditNote.amount;
  const taxAmount = creditNote.amount - subtotal;

  const uuid = randomUUID();
  const issueDate = creditNote.createdAt;
  const qrCode = buildZatcaQrPayload({
    sellerName: readiness.seller.sellerLegalName,
    vatNumber: readiness.seller.vatNumber,
    timestampIso: zatcaTimestamp(issueDate),
    invoiceTotal: creditNote.amount,
    vatTotal: taxAmount,
  });

  const xml = buildZatcaInvoiceXml({
    invoiceNumber: creditNote.creditNoteNumber,
    uuid,
    issueDate,
    currency: creditNote.invoice.currency,
    seller: { legalName: readiness.seller.sellerLegalName, vatNumber: readiness.seller.vatNumber, crNumber: readiness.seller.crNumber },
    buyer: { legalName: creditNote.invoice.customer.legalName, vatNumber: creditNote.invoice.customer.taxId },
    lines: [{ description: creditNote.reason, volumeM3: 1, unitCode: "C62", unitPrice: subtotal, lineTotal: subtotal }],
    subtotal,
    taxRatePct,
    taxAmount,
    total: creditNote.amount,
    icv,
    previousInvoiceHash,
    qrCode,
    documentTypeCode: "381",
    billingReferenceInvoiceNumber: creditNote.invoice.invoiceNumber,
  });

  await prisma.creditNote.update({
    where: { id: creditNoteId },
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

const DEFAULT_SANDBOX_URL = "https://gw-fatoora.zatca.gov.sa/e-invoicing/developer-portal/invoices/clearance/single";
const DEFAULT_PRODUCTION_URL = "https://gw-fatoora.zatca.gov.sa/e-invoicing/core/invoices/clearance/single";

export type ZatcaCreditNoteSubmitResult =
  | { ok: true }
  | { ok: false; reason: "NOT_CONFIGURED" | "NOT_GENERATED" | "ALREADY_CLEARED" | "NOT_FOUND" }
  | { ok: false; reason: "API_ERROR"; status: number; body: string };

export async function submitCreditNoteForClearance(creditNoteId: string): Promise<ZatcaCreditNoteSubmitResult> {
  const creditNote = await prisma.creditNote.findUnique({
    where: { id: creditNoteId },
    include: { invoice: { include: { plant: true } } },
  });
  if (!creditNote) return { ok: false, reason: "NOT_FOUND" };
  if (!creditNote.zatcaXml || !creditNote.zatcaUuid || !creditNote.zatcaInvoiceHash) return { ok: false, reason: "NOT_GENERATED" };
  if (creditNote.zatcaStatus === "CLEARED") return { ok: false, reason: "ALREADY_CLEARED" };
  if (!creditNote.invoice.plant) return { ok: false, reason: "NOT_CONFIGURED" };

  const readiness = await getZatcaReadiness(creditNote.invoice.plant.siteId);
  if (readiness.level !== "CLEARANCE_READY") return { ok: false, reason: "NOT_CONFIGURED" };

  const { signedXml, invoiceHash, qrCode } = signInvoiceXml({
    xml: creditNote.zatcaXml,
    certificatePem: readiness.csidCert,
    privateKeyPem: readiness.csidPrivateKey,
    qrFields: {
      sellerName: readiness.seller.sellerLegalName,
      vatNumber: readiness.seller.vatNumber,
      timestampIso: zatcaTimestamp(creditNote.createdAt),
      invoiceTotal: creditNote.amount,
      vatTotal: creditNote.amount - creditNote.amount / (1 + creditNote.invoice.taxRatePct / 100),
    },
  });

  const url =
    readiness.seller.environment === "PRODUCTION"
      ? process.env.ZATCA_CLEARANCE_URL_PRODUCTION || DEFAULT_PRODUCTION_URL
      : process.env.ZATCA_CLEARANCE_URL_SANDBOX || DEFAULT_SANDBOX_URL;

  const auth = Buffer.from(`${readiness.csidCert}:${readiness.csidSecret}`).toString("base64");

  try {
    const res = await fetch(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Accept: "application/json",
        "Accept-Language": "en",
        "Accept-Version": "V2",
        Authorization: `Basic ${auth}`,
      },
      body: JSON.stringify({
        invoiceHash,
        uuid: creditNote.zatcaUuid,
        invoice: Buffer.from(signedXml, "utf8").toString("base64"),
      }),
    });

    if (!res.ok) {
      const body = await res.text().catch(() => "");
      await prisma.creditNote.update({
        where: { id: creditNoteId },
        data: {
          zatcaXml: signedXml,
          zatcaQrCode: qrCode,
          zatcaInvoiceHash: invoiceHash,
          zatcaStatus: "FAILED",
          zatcaErrorMessage: `HTTP ${res.status}: ${body.slice(0, 500)}`,
          zatcaSubmittedAt: new Date(),
        },
      });
      return { ok: false, reason: "API_ERROR", status: res.status, body };
    }

    await prisma.creditNote.update({
      where: { id: creditNoteId },
      data: {
        zatcaXml: signedXml,
        zatcaQrCode: qrCode,
        zatcaInvoiceHash: invoiceHash,
        zatcaStatus: "CLEARED",
        zatcaSubmittedAt: new Date(),
        zatcaClearedAt: new Date(),
        zatcaErrorMessage: null,
      },
    });
    return { ok: true };
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    await prisma.creditNote.update({
      where: { id: creditNoteId },
      data: { zatcaXml: signedXml, zatcaQrCode: qrCode, zatcaInvoiceHash: invoiceHash, zatcaStatus: "FAILED", zatcaErrorMessage: message, zatcaSubmittedAt: new Date() },
    });
    return { ok: false, reason: "API_ERROR", status: 0, body: message };
  }
}
