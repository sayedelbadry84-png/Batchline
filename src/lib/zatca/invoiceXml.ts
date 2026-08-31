import { createHash } from "crypto";

// Builds a ZATCA-shaped UBL 2.1 Standard Tax Invoice XML — structured
// after ZATCA's published e-invoicing implementation standard (itself an
// extension of UBL 2.1's Invoice document), covering the elements every
// sample in that standard carries: supplier/customer party identification
// and tax registration, the invoice counter (ICV) and previous-invoice-
// hash (PIH) chain, line-level and document-level tax totals, and the
// QR/PIH AdditionalDocumentReference blocks ZATCA's own validator expects.
//
// What this does NOT do: XAdES digital signing or the cryptographic
// stamp — both require the private key issued during CSID onboarding
// (see src/lib/zatca/submit.ts), which doesn't exist until a real ZATCA
// account is connected. The XML built here is therefore always
// "unsigned" — genuinely useful for a Phase 1 QR-compliant invoice (QR
// doesn't need signing), and structurally ready for Phase 2 clearance
// once signing is layered on, but not itself proof this exact structure
// will pass ZATCA's schema validator — that needs checking against the
// real Fatoora simulator once sandbox access exists, this hasn't been
// validated against it.

export type ZatcaInvoiceLineInput = {
  description: string;
  volumeM3: number;
  unitPrice: number;
  lineTotal: number;
};

export type ZatcaInvoiceInput = {
  invoiceNumber: string;
  uuid: string;
  issueDate: Date;
  currency: string;
  seller: { legalName: string; vatNumber: string; crNumber: string | null };
  buyer: { legalName: string; vatNumber: string | null };
  lines: ZatcaInvoiceLineInput[];
  subtotal: number;
  taxRatePct: number;
  taxAmount: number;
  total: number;
  icv: number;
  previousInvoiceHash: string;
};

// ZATCA's documented convention for the very first invoice in a
// taxpayer's chain: the PIH is the SHA256 of the ASCII string "0",
// base64-encoded — computed here rather than hardcoded so it's obviously
// derived, not a magic string.
export function zatcaGenesisPreviousHash(): string {
  return createHash("sha256").update("0", "ascii").digest("base64");
}

function escapeXml(value: string): string {
  return value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&apos;");
}

function isoDate(d: Date): string {
  return d.toISOString().slice(0, 10);
}
function isoTime(d: Date): string {
  return d.toISOString().slice(11, 19);
}

export function buildZatcaInvoiceXml(input: ZatcaInvoiceInput): string {
  const lineItems = input.lines
    .map((l, i) => {
      const lineTaxAmount = l.lineTotal * (input.taxRatePct / 100);
      return `
  <cac:InvoiceLine>
    <cbc:ID>${i + 1}</cbc:ID>
    <cbc:InvoicedQuantity unitCode="MTQ">${l.volumeM3}</cbc:InvoicedQuantity>
    <cbc:LineExtensionAmount currencyID="${input.currency}">${l.lineTotal.toFixed(2)}</cbc:LineExtensionAmount>
    <cac:TaxTotal>
      <cbc:TaxAmount currencyID="${input.currency}">${lineTaxAmount.toFixed(2)}</cbc:TaxAmount>
      <cbc:RoundingAmount currencyID="${input.currency}">${(l.lineTotal + lineTaxAmount).toFixed(2)}</cbc:RoundingAmount>
    </cac:TaxTotal>
    <cac:Item>
      <cbc:Name>${escapeXml(l.description)}</cbc:Name>
      <cac:ClassifiedTaxCategory>
        <cbc:ID>S</cbc:ID>
        <cbc:Percent>${input.taxRatePct}</cbc:Percent>
        <cac:TaxScheme>
          <cbc:ID>VAT</cbc:ID>
        </cac:TaxScheme>
      </cac:ClassifiedTaxCategory>
    </cac:Item>
    <cac:Price>
      <cbc:PriceAmount currencyID="${input.currency}">${l.unitPrice.toFixed(2)}</cbc:PriceAmount>
    </cac:Price>
  </cac:InvoiceLine>`;
    })
    .join("");

  const buyerTaxScheme = input.buyer.vatNumber
    ? `
      <cac:PartyTaxScheme>
        <cbc:CompanyID>${escapeXml(input.buyer.vatNumber)}</cbc:CompanyID>
        <cac:TaxScheme>
          <cbc:ID>VAT</cbc:ID>
        </cac:TaxScheme>
      </cac:PartyTaxScheme>`
    : "";

  return `<?xml version="1.0" encoding="UTF-8"?>
<Invoice xmlns="urn:oasis:names:specification:ubl:schema:xsd:Invoice-2"
         xmlns:cac="urn:oasis:names:specification:ubl:schema:xsd:CommonAggregateComponents-2"
         xmlns:cbc="urn:oasis:names:specification:ubl:schema:xsd:CommonBasicComponents-2"
         xmlns:ext="urn:oasis:names:specification:ubl:schema:xsd:CommonExtensionComponents-2">
  <ext:UBLExtensions>
    <!-- The XAdES signature extension is inserted here once this invoice
         is signed with an onboarded CSID — see src/lib/zatca/submit.ts. -->
  </ext:UBLExtensions>
  <cbc:ProfileID>reporting:1.0</cbc:ProfileID>
  <cbc:ID>${escapeXml(input.invoiceNumber)}</cbc:ID>
  <cbc:UUID>${input.uuid}</cbc:UUID>
  <cbc:IssueDate>${isoDate(input.issueDate)}</cbc:IssueDate>
  <cbc:IssueTime>${isoTime(input.issueDate)}</cbc:IssueTime>
  <cbc:InvoiceTypeCode name="0100000">388</cbc:InvoiceTypeCode>
  <cbc:DocumentCurrencyCode>${input.currency}</cbc:DocumentCurrencyCode>
  <cbc:TaxCurrencyCode>${input.currency}</cbc:TaxCurrencyCode>
  <cac:AdditionalDocumentReference>
    <cbc:ID>ICV</cbc:ID>
    <cbc:UUID>${input.icv}</cbc:UUID>
  </cac:AdditionalDocumentReference>
  <cac:AdditionalDocumentReference>
    <cbc:ID>PIH</cbc:ID>
    <cac:Attachment>
      <cbc:EmbeddedDocumentBinaryObject mimeCode="text/plain">${input.previousInvoiceHash}</cbc:EmbeddedDocumentBinaryObject>
    </cac:Attachment>
  </cac:AdditionalDocumentReference>
  <cac:AccountingSupplierParty>
    <cac:Party>
      <cac:PartyIdentification>
        <cbc:ID schemeID="CRN">${escapeXml(input.seller.crNumber ?? "")}</cbc:ID>
      </cac:PartyIdentification>
      <cac:PartyTaxScheme>
        <cbc:CompanyID>${escapeXml(input.seller.vatNumber)}</cbc:CompanyID>
        <cac:TaxScheme>
          <cbc:ID>VAT</cbc:ID>
        </cac:TaxScheme>
      </cac:PartyTaxScheme>
      <cac:PartyLegalEntity>
        <cbc:RegistrationName>${escapeXml(input.seller.legalName)}</cbc:RegistrationName>
      </cac:PartyLegalEntity>
    </cac:Party>
  </cac:AccountingSupplierParty>
  <cac:AccountingCustomerParty>
    <cac:Party>${buyerTaxScheme}
      <cac:PartyLegalEntity>
        <cbc:RegistrationName>${escapeXml(input.buyer.legalName)}</cbc:RegistrationName>
      </cac:PartyLegalEntity>
    </cac:Party>
  </cac:AccountingCustomerParty>
  <cac:PaymentMeans>
    <cbc:PaymentMeansCode>30</cbc:PaymentMeansCode>
  </cac:PaymentMeans>
  <cac:TaxTotal>
    <cbc:TaxAmount currencyID="${input.currency}">${input.taxAmount.toFixed(2)}</cbc:TaxAmount>
    <cac:TaxSubtotal>
      <cbc:TaxableAmount currencyID="${input.currency}">${input.subtotal.toFixed(2)}</cbc:TaxableAmount>
      <cbc:TaxAmount currencyID="${input.currency}">${input.taxAmount.toFixed(2)}</cbc:TaxAmount>
      <cac:TaxCategory>
        <cbc:ID>S</cbc:ID>
        <cbc:Percent>${input.taxRatePct}</cbc:Percent>
        <cac:TaxScheme>
          <cbc:ID>VAT</cbc:ID>
        </cac:TaxScheme>
      </cac:TaxCategory>
    </cac:TaxSubtotal>
  </cac:TaxTotal>
  <cac:LegalMonetaryTotal>
    <cbc:LineExtensionAmount currencyID="${input.currency}">${input.subtotal.toFixed(2)}</cbc:LineExtensionAmount>
    <cbc:TaxExclusiveAmount currencyID="${input.currency}">${input.subtotal.toFixed(2)}</cbc:TaxExclusiveAmount>
    <cbc:TaxInclusiveAmount currencyID="${input.currency}">${input.total.toFixed(2)}</cbc:TaxInclusiveAmount>
    <cbc:PayableAmount currencyID="${input.currency}">${input.total.toFixed(2)}</cbc:PayableAmount>
  </cac:LegalMonetaryTotal>${lineItems}
</Invoice>`;
}

export function hashZatcaXml(xml: string): string {
  return createHash("sha256").update(xml, "utf8").digest("base64");
}
