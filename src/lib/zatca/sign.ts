import { createHash, createSign, X509Certificate } from "crypto";
import { DOMParser, type Document as XmlDomDocument } from "@xmldom/xmldom";
import { XmlCanonicalizer } from "xmldsigjs";
import { Certificate } from "@fidm/x509";
import { buildZatcaPhase2QrPayload, zatcaTimestamp, type ZatcaQrFields } from "./qr";

// Turns the unsigned XML from invoiceXml.ts into a real XAdES-BES signed
// UBL invoice, per ZATCA's Electronic Invoice Security Features
// Implementation Standard. This is the piece the previous version of
// this integration was missing entirely — submit.ts sent the unsigned
// XML straight to ZATCA's clearance API, which was always going to
// reject it.
//
// The structure and hashing conventions here (which elements get
// stripped before hashing, the certificate-hash double-encoding, the
// signed-properties split between a standalone-hashed form and an
// embedded form) are modeled directly on ZATCA's own published standard
// and cross-checked against a community reference implementation
// (wes4m/zatca-xml-js) rather than reconstructed from memory — XAdES
// canonicalization is exactly the kind of thing that's silently wrong in
// a dozen different ways if guessed at.
//
// What's still unverified: this has not been run against ZATCA's real
// Fatoora sandbox/simulator (no account exists for that yet — see
// settings.ts). The cryptography here (C14N11 canonicalization, SHA256,
// ECDSA/secp256k1) is standards-based and deterministic, so it should be
// correct — but "should be correct" is not the same as "confirmed
// accepted by ZATCA's validator." Confirm against the real sandbox
// before relying on this for production clearance.

function pemBody(pem: string, label: string): string {
  return pem
    .replace(`-----BEGIN ${label}-----`, "")
    .replace(`-----END ${label}-----`, "")
    .replace(/\r/g, "")
    .trim();
}

// Strips the elements ZATCA's standard says must be excluded before
// hashing (the signature extension itself, the Signature reference, and
// the QR — all three would make the hash a moving target otherwise),
// then canonicalizes with XML C14N 1.1 (non-exclusive, no comments), the
// algorithm named in the <ds:CanonicalizationMethod> this file writes
// below. Unlike some reference implementations, this doesn't need extra
// whitespace patches on top of straight C14N — those exist elsewhere to
// compensate for a lossy custom XML serializer between templating and
// hashing; invoiceXml.ts's template is hashed as written, no such
// round-trip in between.
export function getPureInvoiceString(xml: string): string {
  const doc = new DOMParser().parseFromString(xml, "text/xml");

  removeElementsByTagName(doc, "ext:UBLExtensions");
  removeElementsByTagName(doc, "cac:Signature");
  removeAdditionalDocumentReference(doc, "QR");

  // xmldsigjs's canonicalizer is written against the global lib.dom.d.ts
  // Node/Document types, but operates purely through the standard DOM
  // traversal API (nodeType, firstChild, attributes, ...) that
  // @xmldom/xmldom's Document genuinely implements — this cast bridges
  // two structurally-compatible DOM type definitions, not a real type
  // mismatch.
  const canonicalizer = new XmlCanonicalizer(false, false);
  return canonicalizer.Canonicalize(doc as unknown as Node);
}

function removeElementsByTagName(doc: XmlDomDocument, tagName: string): void {
  const nodes = Array.from(doc.getElementsByTagName(tagName));
  for (const node of nodes) node.parentNode?.removeChild(node);
}

function removeAdditionalDocumentReference(doc: XmlDomDocument, id: string): void {
  const nodes = Array.from(doc.getElementsByTagName("cac:AdditionalDocumentReference"));
  for (const node of nodes) {
    const idEl = node.getElementsByTagName("cbc:ID")[0];
    if (idEl?.textContent === id) node.parentNode?.removeChild(node);
  }
}

export function hashInvoiceXml(xml: string): string {
  return createHash("sha256").update(getPureInvoiceString(xml), "utf8").digest("base64");
}

export type ZatcaCertificateInfo = {
  hash: string;
  issuer: string;
  serialNumber: string;
  publicKey: Buffer;
  certificateSignature: Buffer;
};

// The certificate hash ZATCA's standard expects is SHA256 of the base64
// certificate body treated as ASCII text, then the resulting *hex
// digest* is itself base64-encoded as text — a double-encoding that
// looks like a mistake but matches ZATCA's own sample code and every
// independent implementation checked against their validator.
export function getCertificateInfo(certificatePem: string): ZatcaCertificateInfo {
  const certBody = pemBody(certificatePem, "CERTIFICATE");
  const hashHex = createHash("sha256").update(certBody, "ascii").digest("hex");
  const hash = Buffer.from(hashHex, "utf8").toString("base64");

  const wrapped = `-----BEGIN CERTIFICATE-----\n${certBody}\n-----END CERTIFICATE-----\n`;
  const x509 = new X509Certificate(wrapped);
  const parsed = Certificate.fromPEM(Buffer.from(wrapped));

  return {
    hash,
    // ZATCA expects the issuer distinguished name with its RDNs in
    // reversed order relative to Node's own X509Certificate.issuer.
    issuer: x509.issuer.split("\n").reverse().join(", "),
    serialNumber: BigInt(`0x${x509.serialNumber}`).toString(10),
    publicKey: parsed.publicKeyRaw,
    certificateSignature: parsed.signature,
  };
}

// Signs the (already base64) invoice hash with the CSID private key.
// ZATCA's CSID keypair is secp256k1 — the sign() call itself is
// curve-agnostic (it just uses whatever curve the PEM key declares), the
// secp256k1 choice lives entirely in how the key was generated during
// CSR creation, not here.
export function signInvoiceHash(invoiceHashBase64: string, privateKeyPem: string): string {
  const keyBody = pemBody(privateKeyPem, "EC PRIVATE KEY");
  const wrapped = `-----BEGIN EC PRIVATE KEY-----\n${keyBody}\n-----END EC PRIVATE KEY-----\n`;
  const sign = createSign("sha256");
  sign.update(Buffer.from(invoiceHashBase64, "base64"));
  return sign.sign(wrapped).toString("base64");
}

function xadesSignedPropertiesForHashing(props: { signTimestamp: string; certificateHash: string; certificateIssuer: string; certificateSerialNumber: string }): string {
  return `<xades:SignedProperties xmlns:xades="http://uri.etsi.org/01903/v1.3.2#" Id="xadesSignedProperties">
                                    <xades:SignedSignatureProperties>
                                        <xades:SigningTime>${props.signTimestamp}</xades:SigningTime>
                                        <xades:SigningCertificate>
                                            <xades:Cert>
                                                <xades:CertDigest>
                                                    <ds:DigestMethod xmlns:ds="http://www.w3.org/2000/09/xmldsig#" Algorithm="http://www.w3.org/2001/04/xmlenc#sha256"/>
                                                    <ds:DigestValue xmlns:ds="http://www.w3.org/2000/09/xmldsig#">${props.certificateHash}</ds:DigestValue>
                                                </xades:CertDigest>
                                                <xades:IssuerSerial>
                                                    <ds:X509IssuerName xmlns:ds="http://www.w3.org/2000/09/xmldsig#">${props.certificateIssuer}</ds:X509IssuerName>
                                                    <ds:X509SerialNumber xmlns:ds="http://www.w3.org/2000/09/xmldsig#">${props.certificateSerialNumber}</ds:X509SerialNumber>
                                                </xades:IssuerSerial>
                                            </xades:Cert>
                                        </xades:SigningCertificate>
                                    </xades:SignedSignatureProperties>
                                </xades:SignedProperties>`;
}

function xadesSignedPropertiesForEmbedding(props: { signTimestamp: string; certificateHash: string; certificateIssuer: string; certificateSerialNumber: string }): string {
  return `<xades:SignedProperties xmlns:xades="http://uri.etsi.org/01903/v1.3.2#" Id="xadesSignedProperties">
                                <xades:SignedSignatureProperties>
                                    <xades:SigningTime>${props.signTimestamp}</xades:SigningTime>
                                    <xades:SigningCertificate>
                                        <xades:Cert>
                                            <xades:CertDigest>
                                                <ds:DigestMethod Algorithm="http://www.w3.org/2001/04/xmlenc#sha256"></ds:DigestMethod>
                                                <ds:DigestValue>${props.certificateHash}</ds:DigestValue>
                                            </xades:CertDigest>
                                            <xades:IssuerSerial>
                                                <ds:X509IssuerName>${props.certificateIssuer}</ds:X509IssuerName>
                                                <ds:X509SerialNumber>${props.certificateSerialNumber}</ds:X509SerialNumber>
                                            </xades:IssuerSerial>
                                        </xades:Cert>
                                    </xades:SigningCertificate>
                                </xades:SignedSignatureProperties>
                            </xades:SignedProperties>`;
}

function ublSignatureExtension(params: { invoiceHash: string; signedPropertiesHash: string; digitalSignature: string; certificateBody: string; signedPropertiesXml: string }): string {
  return `<ext:UBLExtension>
        <ext:ExtensionURI>urn:oasis:names:specification:ubl:dsig:enveloped:xades</ext:ExtensionURI>
        <ext:ExtensionContent>
            <sig:UBLDocumentSignatures
                    xmlns:sac="urn:oasis:names:specification:ubl:schema:xsd:SignatureAggregateComponents-2"
                    xmlns:sbc="urn:oasis:names:specification:ubl:schema:xsd:SignatureBasicComponents-2"
                    xmlns:sig="urn:oasis:names:specification:ubl:schema:xsd:CommonSignatureComponents-2">
                <sac:SignatureInformation>
                    <cbc:ID>urn:oasis:names:specification:ubl:signature:1</cbc:ID>
                    <sbc:ReferencedSignatureID>urn:oasis:names:specification:ubl:signature:Invoice</sbc:ReferencedSignatureID>
                    <ds:Signature Id="signature" xmlns:ds="http://www.w3.org/2000/09/xmldsig#">
                        <ds:SignedInfo>
                            <ds:CanonicalizationMethod Algorithm="http://www.w3.org/2006/12/xml-c14n11"/>
                            <ds:SignatureMethod Algorithm="http://www.w3.org/2001/04/xmldsig-more#ecdsa-sha256"/>
                            <ds:Reference Id="invoiceSignedData" URI="">
                                <ds:Transforms>
                                    <ds:Transform Algorithm="http://www.w3.org/TR/1999/REC-xpath-19991116">
                                        <ds:XPath>not(//ancestor-or-self::ext:UBLExtensions)</ds:XPath>
                                    </ds:Transform>
                                    <ds:Transform Algorithm="http://www.w3.org/TR/1999/REC-xpath-19991116">
                                        <ds:XPath>not(//ancestor-or-self::cac:Signature)</ds:XPath>
                                    </ds:Transform>
                                    <ds:Transform Algorithm="http://www.w3.org/TR/1999/REC-xpath-19991116">
                                        <ds:XPath>not(//ancestor-or-self::cac:AdditionalDocumentReference[cbc:ID='QR'])</ds:XPath>
                                    </ds:Transform>
                                    <ds:Transform Algorithm="http://www.w3.org/2006/12/xml-c14n11"/>
                                </ds:Transforms>
                                <ds:DigestMethod Algorithm="http://www.w3.org/2001/04/xmlenc#sha256"/>
                                <ds:DigestValue>${params.invoiceHash}</ds:DigestValue>
                            </ds:Reference>
                            <ds:Reference Type="http://www.w3.org/2000/09/xmldsig#SignatureProperties" URI="#xadesSignedProperties">
                                <ds:DigestMethod Algorithm="http://www.w3.org/2001/04/xmlenc#sha256"/>
                                <ds:DigestValue>${params.signedPropertiesHash}</ds:DigestValue>
                            </ds:Reference>
                        </ds:SignedInfo>
                        <ds:SignatureValue>${params.digitalSignature}</ds:SignatureValue>
                        <ds:KeyInfo>
                            <ds:X509Data>
                                <ds:X509Certificate>${params.certificateBody}</ds:X509Certificate>
                            </ds:X509Data>
                        </ds:KeyInfo>
                        <ds:Object>
                            <xades:QualifyingProperties Target="signature" xmlns:xades="http://uri.etsi.org/01903/v1.3.2#">
                                ${params.signedPropertiesXml}
                            </xades:QualifyingProperties>
                        </ds:Object>
                    </ds:Signature>
                </sac:SignatureInformation>
            </sig:UBLDocumentSignatures>
        </ext:ExtensionContent>
    </ext:UBLExtension>`;
}

export type ZatcaSignInput = {
  xml: string; // the unsigned XML from buildZatcaInvoiceXml, QR already embedded (Phase 1 shape)
  certificatePem: string;
  privateKeyPem: string;
  qrFields: ZatcaQrFields; // to rebuild the QR at the 9-tag Phase 2 shape
};

export type ZatcaSignResult = {
  signedXml: string;
  invoiceHash: string;
  qrCode: string; // base64, 9-tag TLV
};

// Produces a fully XAdES-BES-signed invoice: computes the invoice hash
// over the pure (unsigned-elements-stripped) XML, signs it with the CSID
// private key, builds the XAdES SignedProperties and their own hash,
// assembles the <ext:UBLExtensions> signature block, and re-embeds the
// QR at its 9-tag Phase 2 shape (with the invoice hash, signature,
// public key and certificate signature baked in) — everything ZATCA's
// clearance API requires that submit.ts previously sent unsigned.
export function signInvoiceXml(input: ZatcaSignInput): ZatcaSignResult {
  const invoiceHash = hashInvoiceXml(input.xml);
  const certInfo = getCertificateInfo(input.certificatePem);
  const digitalSignature = signInvoiceHash(invoiceHash, input.privateKeyPem);

  const signTimestamp = zatcaTimestamp(new Date());
  const signedPropsCommon = {
    signTimestamp,
    certificateHash: certInfo.hash,
    certificateIssuer: certInfo.issuer,
    certificateSerialNumber: certInfo.serialNumber,
  };
  const signedPropertiesForHashing = xadesSignedPropertiesForHashing(signedPropsCommon);
  const signedPropertiesHash = Buffer.from(createHash("sha256").update(signedPropertiesForHashing, "utf8").digest("hex"), "utf8").toString("base64");
  const signedPropertiesForEmbedding = xadesSignedPropertiesForEmbedding(signedPropsCommon);

  const signatureExtension = ublSignatureExtension({
    invoiceHash,
    signedPropertiesHash,
    digitalSignature,
    certificateBody: pemBody(input.certificatePem, "CERTIFICATE"),
    signedPropertiesXml: signedPropertiesForEmbedding,
  });

  const qrCode = buildZatcaPhase2QrPayload({
    ...input.qrFields,
    invoiceHash,
    digitalSignature,
    publicKey: certInfo.publicKey,
    certificateSignature: certInfo.certificateSignature,
  });

  let signedXml = input.xml.replace(
    /<ext:UBLExtensions>[\s\S]*?<\/ext:UBLExtensions>/,
    `<ext:UBLExtensions>\n    ${signatureExtension}\n  </ext:UBLExtensions>`,
  );
  signedXml = signedXml.replace(
    /(<cac:AdditionalDocumentReference>\s*<cbc:ID>QR<\/cbc:ID>\s*<cac:Attachment>\s*<cbc:EmbeddedDocumentBinaryObject mimeCode="text\/plain">)[^<]*(<\/cbc:EmbeddedDocumentBinaryObject>)/,
    `$1${qrCode}$2`,
  );

  return { signedXml, invoiceHash, qrCode };
}
