import { prisma } from "@/lib/prisma";
import { zatcaGenesisPreviousHash } from "./invoiceXml";

// ZATCA's ICV (invoice counter value) and PIH (previous invoice hash)
// chain runs across every e-invoicing document a taxpayer issues — Tax
// Invoices AND Credit/Debit Notes together, in issuance order — not one
// chain per document type. Both generateZatcaDocuments (invoices) and
// generateZatcaCreditNoteDocuments (credit notes) call this so neither
// type can silently form its own separate chain.
export async function getNextZatcaChainPosition(siteId: string): Promise<{ icv: number; previousHash: string }> {
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

  return { icv: invoiceCount + creditNoteCount + 1, previousHash };
}
