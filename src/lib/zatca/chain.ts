import type { Prisma } from "@prisma/client";
import { zatcaGenesisPreviousHash } from "./invoiceXml";

// ZATCA's ICV (invoice counter value) and PIH (previous invoice hash)
// chain runs across every e-invoicing document a taxpayer issues — Tax
// Invoices AND Credit/Debit Notes together, in issuance order — not one
// chain per document type. Both generateZatcaDocuments (invoices) and
// generateZatcaCreditNoteDocuments (credit notes) call this so neither
// type can silently form its own separate chain.
// Both document types must hold this same lock until their XML is saved.
// Use ReadCommitted so a waiter reads the predecessor that just committed,
// not a Serializable snapshot taken before it acquired the lock.
export async function lockSiteChain(tx: Prisma.TransactionClient, siteId: string): Promise<void> {
  await tx.$queryRaw`SELECT "id" FROM "Site" WHERE "id" = ${siteId} FOR UPDATE`;
}

export async function getNextZatcaChainPosition(prisma: Prisma.TransactionClient, siteId: string): Promise<{ icv: number; previousHash: string; generatedAt: Date }> {
  const [lastInvoice, lastCreditNote, invoiceCount, creditNoteCount] = await Promise.all([
    prisma.invoice.findFirst({
      where: { plant: { siteId }, zatcaInvoiceHash: { not: null } },
      orderBy: { zatcaGeneratedAt: "desc" },
      select: { zatcaInvoiceHash: true, zatcaGeneratedAt: true },
    }),
    prisma.creditNote.findFirst({
      where: { invoice: { plant: { siteId } }, zatcaInvoiceHash: { not: null } },
      orderBy: { zatcaGeneratedAt: "desc" },
      select: { zatcaInvoiceHash: true, zatcaGeneratedAt: true },
    }),
    prisma.invoice.count({ where: { plant: { siteId }, zatcaInvoiceHash: { not: null } } }),
    prisma.creditNote.count({ where: { invoice: { plant: { siteId } }, zatcaInvoiceHash: { not: null } } }),
  ]);

  const candidates = [lastInvoice, lastCreditNote].filter((d): d is { zatcaInvoiceHash: string | null; zatcaGeneratedAt: Date | null } => d !== null && d.zatcaGeneratedAt !== null);
  candidates.sort((a, b) => b.zatcaGeneratedAt!.getTime() - a.zatcaGeneratedAt!.getTime());
  const previousHash = candidates[0]?.zatcaInvoiceHash ?? zatcaGenesisPreviousHash();

  // Millisecond ties (or clocks on different application instances) must
  // not make the next lookup choose an older document as the predecessor.
  const generatedAt = new Date(Math.max(Date.now(), (candidates[0]?.zatcaGeneratedAt?.getTime() ?? 0) + 1));
  return { icv: invoiceCount + creditNoteCount + 1, previousHash, generatedAt };
}
