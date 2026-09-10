import { submitDocument, type SubmissionResult } from "./submission";
import type { AuditActor } from "@/lib/audit";
import { prisma } from "@/lib/prisma";
import { getZatcaReadiness } from "./settings";
import { signInvoiceXml } from "./sign";
import { zatcaTimestamp } from "./qr";

// ZATCA's Clearance API — real-time submission required for a B2B
// (Standard Tax Invoice) document once Phase 2 is live for this
// taxpayer. Base URLs match ZATCA's developer portal as documented at the
// time this was written; confirm against ZATCA's current docs before
// going live; ZATCA_CLEARANCE_URL_SANDBOX / ZATCA_CLEARANCE_URL_PRODUCTION
// override them if they've since changed.
const DEFAULT_SANDBOX_URL = "https://gw-fatoora.zatca.gov.sa/e-invoicing/developer-portal/invoices/clearance/single";
const DEFAULT_PRODUCTION_URL = "https://gw-fatoora.zatca.gov.sa/e-invoicing/core/invoices/clearance/single";

export type ZatcaSubmitResult = SubmissionResult;

// Submits this invoice's already-generated XML (see generate.ts) for
// clearance. Refuses outright — no network call at all — unless
// getZatcaReadiness says CLEARANCE_READY (a real CSID + private key
// exist), so this never pretends to have submitted something it
// couldn't have.
//
// Signs the invoice with sign.ts right before submitting (not at
// generate.ts time) — generate.ts runs the moment an invoice is issued,
// long before a real CSID may exist, so it deliberately only ever
// produces the unsigned Phase 1 shape. Signing here, right before the
// one thing that actually needs a signature, keeps that separation:
// every invoice still gets its Phase 1 QR immediately, and only ever
// pays the signing cost when a real clearance submission is about to
// happen. The signed XML and 9-tag QR replace the stored Phase 1 ones so
// what's on the invoice always reflects what was actually sent.
export async function submitInvoiceForClearance(invoiceId: string, actor: AuditActor = null): Promise<ZatcaSubmitResult> {
  const invoice = await prisma.invoice.findUnique({ where: { id: invoiceId }, include: { plant: true } });
  if (!invoice) return { ok: false, reason: "NOT_FOUND" };
  if (!invoice.zatcaXml || !invoice.zatcaUuid || !invoice.zatcaInvoiceHash) return { ok: false, reason: "NOT_GENERATED" };
  if (invoice.zatcaStatus === "CLEARED") return { ok: false, reason: "ALREADY_CLEARED" };
  if (!invoice.plant) return { ok: false, reason: "NOT_CONFIGURED" };

  const readiness = await getZatcaReadiness(invoice.plant.siteId);
  if (readiness.level !== "CLEARANCE_READY") return { ok: false, reason: "NOT_CONFIGURED" };

  return submitDocument({ kind: "INVOICE", id: invoiceId, uuid: invoice.zatcaUuid, actor, prepare: async () => {
  const { signedXml, invoiceHash, qrCode } = signInvoiceXml({
    xml: invoice.zatcaXml!,
    certificatePem: readiness.csidCert,
    privateKeyPem: readiness.csidPrivateKey,
    qrFields: {
      sellerName: readiness.seller.sellerLegalName,
      vatNumber: readiness.seller.vatNumber,
      timestampIso: zatcaTimestamp(invoice.issueDate),
      invoiceTotal: invoice.total,
      vatTotal: invoice.taxAmount,
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
