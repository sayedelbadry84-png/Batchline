import { prisma } from "@/lib/prisma";

// The onboarded CSID certificate and its private key/secret, obtained via
// ZATCA's CSR -> OTP -> compliance-CSID -> production-CSID flow — real,
// long-lived credentials, so they live in environment variables, never in
// ZatcaSettings or anywhere else in this database (see that model's own
// schema comment). Set these once a real ZATCA account exists.
const CSID_CERT_ENV = "ZATCA_CSID_CERT";
const CSID_SECRET_ENV = "ZATCA_CSID_SECRET";

export type ZatcaSellerInfo = {
  sellerLegalName: string;
  vatNumber: string;
  crNumber: string | null;
  environment: "SANDBOX" | "PRODUCTION";
};

// Two independent levels, because they need genuinely different things:
// - QR_ONLY only needs the seller's own VAT registration on file — a
//   Phase 1-compliant QR code can be generated and printed on the invoice
//   today, no ZATCA account needed at all.
// - CLEARANCE_READY additionally needs a real onboarded CSID (env vars
//   above) to sign the XML and submit it to ZATCA's clearance API — this
//   is Phase 2, and genuinely can't happen without a real account.
export type ZatcaReadiness =
  | { level: "NOT_CONFIGURED" }
  | { level: "QR_ONLY"; seller: ZatcaSellerInfo }
  | { level: "CLEARANCE_READY"; seller: ZatcaSellerInfo; csidCert: string; csidSecret: string };

export async function getZatcaReadiness(siteId: string): Promise<ZatcaReadiness> {
  const settings = await prisma.zatcaSettings.findUnique({ where: { siteId } });
  if (!settings || !settings.sellerLegalName || !settings.vatNumber) return { level: "NOT_CONFIGURED" };

  const seller: ZatcaSellerInfo = {
    sellerLegalName: settings.sellerLegalName,
    vatNumber: settings.vatNumber,
    crNumber: settings.crNumber,
    environment: settings.environment === "PRODUCTION" ? "PRODUCTION" : "SANDBOX",
  };

  const csidCert = process.env[CSID_CERT_ENV];
  const csidSecret = process.env[CSID_SECRET_ENV];
  if (!csidCert || !csidSecret) return { level: "QR_ONLY", seller };

  return { level: "CLEARANCE_READY", seller, csidCert, csidSecret };
}
