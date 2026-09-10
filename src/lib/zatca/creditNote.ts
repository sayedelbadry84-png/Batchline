import { writeAudit, type AuditActor as GenerationActor } from "@/lib/audit";
import { submitDocument, type SubmissionResult } from "./submission";
import type { AuditActor } from "@/lib/audit";
import { randomUUID } from "crypto";
import { withRetry } from "@/lib/inventoryLedger";
import { prisma } from "@/lib/prisma";
import { getZatcaReadiness } from "./settings";
import { buildZatcaQrPayload, zatcaTimestamp } from "./qr";
import { buildZatcaInvoiceXml } from "./invoiceXml";
import { hashInvoiceXml, signInvoiceXml } from "./sign";
import { getNextZatcaChainPosition, lockSiteChain } from "./chain";

// A credit note is the only legal way to amend an already-issued
// invoice, so ZATCA requires it to go through the same QR/XML generation
// and Phase 2 clearance pipeline as the invoice it amends — see
// src/lib/zatca/generate.ts and submit.ts, which this closely mirrors.
// The one real difference: CreditNote.amount (see its schema comment) is
// always VAT-inclusive, so the subtotal/tax split has to be derived here
// rather than read off stored fields the way an Invoice's already are.

export type ZatcaCreditNoteGenerateResult = { ok: true } | { ok: false; reason: "NOT_CONFIGURED" | "NO_PLANT" | "ALREADY_GENERATED" | "NOT_FOUND" };

export async function generateZatcaCreditNoteDocuments(creditNoteId: string, actor: GenerationActor = null): Promise<ZatcaCreditNoteGenerateResult> {
  const creditNote = await prisma.creditNote.findUnique({
    where: { id: creditNoteId },
    include: { invoice: { include: { customer: true, plant: true } } },
  });
  if (!creditNote) return { ok: false, reason: "NOT_FOUND" };
  if (creditNote.zatcaStatus) return { ok: false, reason: "ALREADY_GENERATED" };
  if (!creditNote.invoice.plant) return { ok: false, reason: "NO_PLANT" };

  const readiness = await getZatcaReadiness(creditNote.invoice.plant.siteId);
  if (readiness.level === "NOT_CONFIGURED") return { ok: false, reason: "NOT_CONFIGURED" };

  const siteId = creditNote.invoice.plant.siteId;
  return withRetry(() => prisma.$transaction(async (tx): Promise<ZatcaCreditNoteGenerateResult> => {
    await lockSiteChain(tx, siteId);
    // The preflight above is only an optimization. Re-read under the shared
    // site lock so concurrent calls cannot regenerate the same document.
    const creditNote = await tx.creditNote.findUnique({
      where: { id: creditNoteId }, include: { invoice: { include: { customer: true, plant: true } } },
    });
    if (!creditNote) return { ok: false, reason: "NOT_FOUND" };
    if (creditNote.zatcaStatus) return { ok: false, reason: "ALREADY_GENERATED" };
    if (!creditNote.invoice.plant) return { ok: false, reason: "NO_PLANT" };
    const { icv, previousHash: previousInvoiceHash, generatedAt } = await getNextZatcaChainPosition(tx, creditNote.invoice.plant.siteId);

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

    // The shared site lock serializes the normal path; this conditional claim
    // also makes the write itself idempotent if a future caller misses it.
    const claim = await tx.creditNote.updateMany({
      where: { id: creditNoteId, zatcaStatus: null },
      data: {
        zatcaUuid: uuid,
        zatcaInvoiceHash: hashInvoiceXml(xml),
        zatcaPreviousHash: previousInvoiceHash,
        zatcaQrCode: qrCode,
        zatcaXml: xml,
        zatcaStatus: "GENERATED",
        zatcaGeneratedAt: generatedAt,
      },
    });
    if (claim.count === 0) return { ok: false, reason: "ALREADY_GENERATED" };

    await writeAudit(tx, actor, { module: "Billing", recordId: creditNoteId, reasonCode: "ZATCA_CREDIT_NOTE_GENERATED" });
    return { ok: true };
  }, { timeout: 15000, isolationLevel: "Serializable" }));
}

const DEFAULT_SANDBOX_URL = "https://gw-fatoora.zatca.gov.sa/e-invoicing/developer-portal/invoices/clearance/single";
const DEFAULT_PRODUCTION_URL = "https://gw-fatoora.zatca.gov.sa/e-invoicing/core/invoices/clearance/single";

export type ZatcaCreditNoteSubmitResult = SubmissionResult;

export async function submitCreditNoteForClearance(creditNoteId: string, actor: AuditActor = null): Promise<ZatcaCreditNoteSubmitResult> {
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

  return submitDocument({ kind: "CREDIT_NOTE", id: creditNoteId, uuid: creditNote.zatcaUuid, actor, prepare: async () => {
  const { signedXml, invoiceHash, qrCode } = signInvoiceXml({
    xml: creditNote.zatcaXml!,
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

  return { signedXml, invoiceHash, qrCode, url, authorization: `Basic ${auth}` };
  } });
}
