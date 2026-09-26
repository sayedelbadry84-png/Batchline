// The PIH chain stores each document's hash at generation time, and
// submission later writes the hash that signing computes. The two must be
// the same value, or submitting a document would change a hash its
// successor already links to (audit of PR #10, S1). They are equal by
// construction: signInvoiceXml hashes the XML with the signature block and
// the QR stripped, exactly as generation does. These tests hold that for an
// invoice, a credit note, and a retry that signs the already-signed stored
// XML again. No database.
import { test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { buildZatcaInvoiceXml, zatcaGenesisPreviousHash, type ZatcaInvoiceInput } from "../src/lib/zatca/invoiceXml";
import { buildZatcaQrPayload } from "../src/lib/zatca/qr";
import { hashInvoiceXml, signInvoiceXml } from "../src/lib/zatca/sign";
import { TEST_ONLY_CERTIFICATE_PEM, TEST_ONLY_PRIVATE_KEY_PEM } from "./setup/zatcaTestCredentials";

const seller = { legalName: "Test Seller", vatNumber: "300000000000003", crNumber: null };
const qrFields = { sellerName: seller.legalName, vatNumber: seller.vatNumber, timestampIso: "2026-09-26T10:00:00", invoiceTotal: 115, vatTotal: 15 };

function document(extra: Partial<ZatcaInvoiceInput> = {}): string {
  return buildZatcaInvoiceXml({
    invoiceNumber: `TEST-${randomUUID()}`,
    uuid: randomUUID(),
    issueDate: new Date("2026-09-26T10:00:00Z"),
    currency: "SAR",
    seller,
    buyer: { legalName: "Test Buyer", vatNumber: null },
    lines: [{ description: "C30", volumeM3: 1, unitPrice: 100, lineTotal: 100 }],
    subtotal: 100,
    taxRatePct: 15,
    taxAmount: 15,
    total: 115,
    icv: 7,
    previousInvoiceHash: zatcaGenesisPreviousHash(),
    qrCode: buildZatcaQrPayload(qrFields),
    ...extra,
  });
}

function sign(xml: string) {
  return signInvoiceXml({ xml, certificatePem: TEST_ONLY_CERTIFICATE_PEM, privateKeyPem: TEST_ONLY_PRIVATE_KEY_PEM, qrFields });
}

for (const [kind, xml] of [
  ["invoice", document()],
  ["credit note", document({ documentTypeCode: "381", billingReferenceInvoiceNumber: "INV-1", lines: [{ description: "OTHER", volumeM3: 1, unitCode: "C62", unitPrice: 100, lineTotal: 100 }] })],
] as const) {
  test(`${kind}: the hash signing submits equals the hash generation stored, on the first submission and on a retry`, () => {
    const generated = hashInvoiceXml(xml);
    const first = sign(xml);
    assert.equal(first.invoiceHash, generated, "first submission signs the generated XML");
    assert.notEqual(first.signedXml, xml, "signing did change the document: a signature and the Phase 2 QR were embedded");
    // A retry signs zatcaXml as stored by the first attempt, i.e. already signed.
    assert.equal(sign(first.signedXml).invoiceHash, generated, "re-signing the signed XML hashes to the same value");
  });
}

test("the hash does change when the invoice content changes, so the equality above is not vacuous", () => {
  const same = { uuid: "00000000-0000-4000-8000-000000000001", invoiceNumber: "TEST-FIXED" };
  assert.equal(hashInvoiceXml(document(same)), hashInvoiceXml(document(same)), "identical content hashes identically");
  assert.notEqual(hashInvoiceXml(document({ ...same, total: 116 })), hashInvoiceXml(document(same)));
});
