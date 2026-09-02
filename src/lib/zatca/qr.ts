// ZATCA (Saudi e-invoicing) QR payload — TLV (Tag-Length-Value) encoded
// then Base64'd, per ZATCA's e-invoicing implementation standard. This is
// the Phase 1 shape: 5 tags (seller name, VAT number, timestamp, invoice
// total including VAT, VAT total) — the minimum every invoice has needed
// since Phase 1 went live in Dec 2021, computable from data this app
// already has, no CSID/onboarding required.
//
// Phase 2 (real-time clearance/reporting) extends this to 9 tags — XML
// hash, ECDSA digital signature, the CSID public key, and the CSID's own
// signature over the certificate — added by buildZatcaPhase2QrPayload
// below once src/lib/zatca/sign.ts has actually signed the invoice.
//
// The TLV mechanics here (tag byte, length byte, raw value bytes,
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

// ZATCA's timestamp tag expects exactly YYYY-MM-DDTHH:mm:ssZ — no
// milliseconds. Date.prototype.toISOString() always includes them, so
// every caller building a timestampIso should go through this rather
// than calling toISOString() directly.
export function zatcaTimestamp(date: Date): string {
  return date.toISOString().slice(0, 19) + "Z";
}

export type ZatcaPhase2QrFields = ZatcaQrFields & {
  invoiceHash: string; // base64
  digitalSignature: string; // base64
  publicKey: Buffer;
  certificateSignature: Buffer;
};

function tlv(tag: number, value: string | Buffer): Buffer {
  const valueBuf = Buffer.isBuffer(value) ? value : Buffer.from(value, "utf8");
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

// Tags 6-7 (invoice hash, digital signature) carry the UTF-8 bytes of
// their own base64 text, not the raw decoded bytes — matching ZATCA's
// documented sample implementation (every community SDK cross-checked
// against ZATCA's validator does the same, however inconsistent that
// looks next to tags 8-9, which are the certificate's genuinely raw
// bytes).
export function buildZatcaPhase2QrPayload(fields: ZatcaPhase2QrFields): string {
  const buf = Buffer.concat([
    tlv(1, fields.sellerName),
    tlv(2, fields.vatNumber),
    tlv(3, fields.timestampIso),
    tlv(4, fields.invoiceTotal.toFixed(2)),
    tlv(5, fields.vatTotal.toFixed(2)),
    tlv(6, fields.invoiceHash),
    tlv(7, fields.digitalSignature),
    tlv(8, fields.publicKey),
    tlv(9, fields.certificateSignature),
  ]);
  return buf.toString("base64");
}
