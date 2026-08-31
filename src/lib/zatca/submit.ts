import { prisma } from "@/lib/prisma";
import { getZatcaReadiness } from "./settings";

// ZATCA's Clearance API — real-time submission required for a B2B
// (Standard Tax Invoice) document once Phase 2 is live for this
// taxpayer. Base URLs match ZATCA's developer portal as documented at the
// time this was written; confirm against ZATCA's current docs before
// going live; ZATCA_CLEARANCE_URL_SANDBOX / ZATCA_CLEARANCE_URL_PRODUCTION
// override them if they've since changed.
const DEFAULT_SANDBOX_URL = "https://gw-fatoora.zatca.gov.sa/e-invoicing/developer-portal/invoices/clearance/single";
const DEFAULT_PRODUCTION_URL = "https://gw-fatoora.zatca.gov.sa/e-invoicing/core/invoices/clearance/single";

export type ZatcaSubmitResult =
  | { ok: true }
  | { ok: false; reason: "NOT_CONFIGURED" | "NOT_GENERATED" | "ALREADY_CLEARED" | "NOT_FOUND" }
  | { ok: false; reason: "API_ERROR"; status: number; body: string };

// Submits this invoice's already-generated XML (see generate.ts) for
// clearance. Refuses outright — no network call at all — unless
// getZatcaReadiness says CLEARANCE_READY (a real CSID exists), so this
// never pretends to have submitted something it couldn't have.
//
// One real gap even at CLEARANCE_READY: the XML built by invoiceXml.ts is
// unsigned (see that file's own note) — ZATCA's clearance endpoint will
// legitimately reject an unsigned submission. Wiring in XAdES signing
// with the CSID private key is the next piece once there's a real
// sandbox to validate the signature against; until then this function is
// honest plumbing that will start working the moment signing is added,
// not a working clearance path today.
export async function submitInvoiceForClearance(invoiceId: string): Promise<ZatcaSubmitResult> {
  const invoice = await prisma.invoice.findUnique({ where: { id: invoiceId }, include: { plant: true } });
  if (!invoice) return { ok: false, reason: "NOT_FOUND" };
  if (!invoice.zatcaXml || !invoice.zatcaUuid || !invoice.zatcaInvoiceHash) return { ok: false, reason: "NOT_GENERATED" };
  if (invoice.zatcaStatus === "CLEARED") return { ok: false, reason: "ALREADY_CLEARED" };
  if (!invoice.plant) return { ok: false, reason: "NOT_CONFIGURED" };

  const readiness = await getZatcaReadiness(invoice.plant.siteId);
  if (readiness.level !== "CLEARANCE_READY") return { ok: false, reason: "NOT_CONFIGURED" };

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
        invoiceHash: invoice.zatcaInvoiceHash,
        uuid: invoice.zatcaUuid,
        invoice: Buffer.from(invoice.zatcaXml, "utf8").toString("base64"),
      }),
    });

    if (!res.ok) {
      const body = await res.text().catch(() => "");
      await prisma.invoice.update({
        where: { id: invoiceId },
        data: { zatcaStatus: "FAILED", zatcaErrorMessage: `HTTP ${res.status}: ${body.slice(0, 500)}`, zatcaSubmittedAt: new Date() },
      });
      return { ok: false, reason: "API_ERROR", status: res.status, body };
    }

    await prisma.invoice.update({
      where: { id: invoiceId },
      data: { zatcaStatus: "CLEARED", zatcaSubmittedAt: new Date(), zatcaClearedAt: new Date(), zatcaErrorMessage: null },
    });
    return { ok: true };
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    await prisma.invoice.update({
      where: { id: invoiceId },
      data: { zatcaStatus: "FAILED", zatcaErrorMessage: message, zatcaSubmittedAt: new Date() },
    });
    return { ok: false, reason: "API_ERROR", status: 0, body: message };
  }
}
