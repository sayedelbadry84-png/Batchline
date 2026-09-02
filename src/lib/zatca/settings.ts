import { prisma } from "@/lib/prisma";

// The onboarded CSID certificate and its private key/secret, obtained via
// ZATCA's CSR -> OTP -> compliance-CSID -> production-CSID flow — real,
// long-lived credentials, so they live in environment variables, never in
// ZatcaSettings or anywhere else in this database (see that model's own
// schema comment). Set these once a real ZATCA account exists.
//
// Three separate values, because ZATCA's onboarding hands back two of
// them (the cert and the API secret) while the third — the EC private
// key — is generated locally when the CSR is created and never leaves
// the machine that made it; ZATCA never sees or returns it. All three
// are required to actually sign an invoice (see src/lib/zatca/sign.ts) —
// cert+secret alone are only enough to authenticate to ZATCA's API, not
// to produce something ZATCA's clearance endpoint will accept.
const CSID_CERT_ENV = "ZATCA_CSID_CERT";
const CSID_SECRET_ENV = "ZATCA_CSID_SECRET";
const CSID_PRIVATE_KEY_ENV = "ZATCA_CSID_PRIVATE_KEY";

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
// - CLEARANCE_READY additionally needs a real onboarded CSID cert+secret
//   AND its private key (env vars above) to actually sign the XML and
//   submit it to ZATCA's clearance API — this is Phase 2, and genuinely
//   can't happen without a real account.
export type ZatcaReadiness =
  | { level: "NOT_CONFIGURED" }
  | { level: "QR_ONLY"; seller: ZatcaSellerInfo }
  | { level: "CLEARANCE_READY"; seller: ZatcaSellerInfo; csidCert: string; csidSecret: string; csidPrivateKey: string };

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
  const csidPrivateKey = process.env[CSID_PRIVATE_KEY_ENV];
  if (!csidCert || !csidSecret || !csidPrivateKey) return { level: "QR_ONLY", seller };

  return { level: "CLEARANCE_READY", seller, csidCert, csidSecret, csidPrivateKey };
}
