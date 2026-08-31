// ZATCA (Saudi e-invoicing) QR payload — TLV (Tag-Length-Value) encoded
// then Base64'd, per ZATCA's e-invoicing implementation standard. This is
// the Phase 1 shape: 5 tags (seller name, VAT number, timestamp, invoice
// total including VAT, VAT total) — the minimum every invoice has needed
// since Phase 1 went live in Dec 2021, computable from data this app
// already has, no CSID/onboarding required.
//
// Phase 2 (real-time clearance/reporting) extends this to 9 tags — XML
// hash, ECDSA digital signature, the CSID public key, and the CSID's own
// signature over the certificate — none of which can be computed without
// a real onboarded CSID, so this module deliberately stops at the 5-tag
// shape. Once ZatcaSettings + the CSID env vars exist, extending this to
// the 9-tag payload is the natural next step (see src/lib/zatca/submit.ts).
//
// The TLV mechanics here (tag byte, length byte, raw UTF-8 value bytes,
// concatenated, then Base64) are the stable, publicly documented part of
// the spec — worth validating against ZATCA's own SDK/simulator once
// sandbox access exists, but the algorithm itself isn't credential-gated.

export type ZatcaQrFields = {
  sellerName: string;
  vatNumber: string;
  timestampIso: string;
  invoiceTotal: number;
  vatTotal: number;
};

function tlv(tag: number, value: string): Buffer {
  const valueBuf = Buffer.from(value, "utf8");
  if (valueBuf.length > 255) {
    throw new Error(`ZATCA QR tag ${tag} value exceeds the 255-byte TLV length limit`);
  }
  return Buffer.concat([Buffer.from([tag, valueBuf.length]), valueBuf]);
}

export function buildZatcaQrPayload(fields: ZatcaQrFields): string {
  const buf = Buffer.concat([
    tlv(1, fields.sellerName),
    tlv(2, fields.vatNumber),
    tlv(3, fields.timestampIso),
    tlv(4, fields.invoiceTotal.toFixed(2)),
    tlv(5, fields.vatTotal.toFixed(2)),
  ]);
  return buf.toString("base64");
}
