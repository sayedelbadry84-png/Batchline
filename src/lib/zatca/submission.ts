import { randomUUID } from "node:crypto";
import { prisma } from "@/lib/prisma";
import { writeAudit, type AuditActor } from "@/lib/audit";
import type { Prisma } from "@prisma/client";

export type SubmissionResult = { ok: true } | { ok: false; reason: "NOT_CONFIGURED" | "NOT_GENERATED" | "ALREADY_CLEARED" | "NOT_FOUND" | "IN_PROGRESS" | "RECONCILIATION_REQUIRED" | "PREPARATION_FAILED" };
type Kind = "INVOICE" | "CREDIT_NOTE";
type Prepared = { signedXml: string; invoiceHash: string; qrCode: string; url: string; authorization: string };
function document(db: Prisma.TransactionClient, kind: Kind) {
  return {
    update: (where: Prisma.InvoiceWhereInput, data: Prisma.InvoiceUpdateManyMutationInput) => kind === "INVOICE"
      ? db.invoice.updateMany({ where, data })
      : db.creditNote.updateMany({ where: where as Prisma.CreditNoteWhereInput, data: data as Prisma.CreditNoteUpdateManyMutationInput }),
    count: (where: Prisma.InvoiceWhereInput) => kind === "INVOICE"
      ? db.invoice.count({ where })
      : db.creditNote.count({ where: where as Prisma.CreditNoteWhereInput }),
  };
}

// No automatic retry after transport has started: external idempotency is
// NOT assumed. UUID, signed payload/hash and bounded response are durable.
export async function submitDocument(input: {
  kind: Kind; id: string; uuid: string; actor: AuditActor;
  prepare: () => Promise<Prepared>;
}, transport: typeof fetch = fetch): Promise<SubmissionResult> {
  const { kind, id, uuid, actor } = input;
  const attemptId = randomUUID();
  const claimed = await prisma.$transaction(async tx => {
    const stale = await document(tx, kind).update({ id, zatcaStatus: "SUBMITTING", zatcaSubmittedAt: { lt: new Date(Date.now() - 5 * 60000) } }, { zatcaStatus: "UNKNOWN", zatcaErrorMessage: "Stale submission: reconcile externally before any retry." });
    if (stale.count) {
      await tx.zatcaSubmissionAttempt.updateMany({ where: { documentId: id, kind, state: "SUBMITTING" }, data: { state: "UNKNOWN", finishedAt: new Date() } });
      await writeAudit(tx, actor, { module: "Billing", recordId: id, reasonCode: "ZATCA_RECONCILIATION_REQUIRED" });
    }
    const claim = await document(tx, kind).update({ id, zatcaUuid: uuid, zatcaStatus: { in: ["GENERATED", "FAILED"] } }, { zatcaStatus: "SUBMITTING", zatcaAttemptId: attemptId, zatcaSubmittedAt: new Date(), zatcaErrorMessage: null });
    if (!claim.count) return false;
    await tx.zatcaSubmissionAttempt.create({ data: { id: attemptId, documentId: id, kind, uuid, state: "SUBMITTING" } });
    await writeAudit(tx, actor, { module: "Billing", recordId: id, reasonCode: "ZATCA_SUBMISSION_CLAIMED", afterValue: attemptId });
    return true;
  });
  if (!claimed) return { ok: false, reason: "RECONCILIATION_REQUIRED" };

  async function finish(state: "CLEARED" | "FAILED" | "UNKNOWN", status?: number, response?: string, errorMessage?: string) {
    return prisma.$transaction(async tx => {
      const changed = await document(tx, kind).update({ id, zatcaAttemptId: attemptId, zatcaStatus: "SUBMITTING" }, {
        zatcaStatus: state, zatcaErrorMessage: state === "CLEARED" ? null : (errorMessage ?? `${state}: see submission attempt ${attemptId}`),
        ...(state === "CLEARED" ? { zatcaClearedAt: new Date() } : {}),
      });
      if (!changed.count) {
        // Keep late transport evidence on the original UNKNOWN attempt,
        // without changing the document or any terminal CLEARED state.
        if (response !== undefined) await tx.zatcaSubmissionAttempt.updateMany({
          where: { id: attemptId, state: "UNKNOWN" },
          data: { httpStatus: status, response: response.slice(0, 16000) },
        });
        return false;
      }
      await tx.zatcaSubmissionAttempt.update({ where: { id: attemptId }, data: { state, httpStatus: status, response: response?.slice(0, 16000), finishedAt: new Date() } });
      await writeAudit(tx, actor, { module: "Billing", recordId: id, reasonCode: `ZATCA_${state}`, afterValue: attemptId });
      return true;
    });
  }

  let prepared: Prepared;
  try { prepared = await input.prepare(); }
  catch {
    // No network request happened. This is the only safely retryable failure.
    await finish("FAILED");
    return { ok: false, reason: "PREPARATION_FAILED" };
  }
  // zatcaInvoiceHash is a link in the site's PIH chain: the next document
  // generated at this site stored it as its previous hash. Signing hashes
  // the XML with the signature and QR stripped, which is exactly what
  // generation hashed, so the prepared hash must equal the stored one
  // (tests/zatcaInvoiceHash.test.ts). This write takes no site lock, so it
  // must never be the thing that changes a chain link: it only fills an
  // empty hash or rewrites the same value. A different hash means the
  // stored XML no longer matches the chain; nothing is sent, and the
  // document is marked FAILED with the reason, before any network request.
  const ours = { id, zatcaAttemptId: attemptId, zatcaStatus: "SUBMITTING" };
  const ready = await prisma.$transaction(async tx => {
    const changed = await document(tx, kind).update(
      { ...ours, OR: [{ zatcaInvoiceHash: null }, { zatcaInvoiceHash: prepared.invoiceHash }] },
      { zatcaXml: prepared.signedXml, zatcaInvoiceHash: prepared.invoiceHash, zatcaQrCode: prepared.qrCode },
    );
    if (!changed.count) return (await document(tx, kind).count(ours)) ? "HASH_MISMATCH" : "LOST";
    await tx.zatcaSubmissionAttempt.update({ where: { id: attemptId }, data: { invoiceHash: prepared.invoiceHash, signedXml: prepared.signedXml } });
    return "READY";
  });
  if (ready === "HASH_MISMATCH") {
    await finish("FAILED", undefined, undefined, `HASH_MISMATCH: the signed invoice hash differs from the hash stored at generation, which the PIH chain links to. Nothing was sent; see submission attempt ${attemptId}.`);
    return { ok: false, reason: "PREPARATION_FAILED" };
  }
  if (ready === "LOST") return { ok: false, reason: "RECONCILIATION_REQUIRED" };
  let res: Response, body: string;
  try {
    res = await transport(prepared.url, {
      method: "POST", signal: AbortSignal.timeout(60000),
      headers: { "Content-Type": "application/json", Accept: "application/json", "Accept-Language": "en", "Accept-Version": "V2", Authorization: prepared.authorization },
      body: JSON.stringify({ uuid, invoiceHash: prepared.invoiceHash, invoice: Buffer.from(prepared.signedXml).toString("base64") }),
    });
    body = await res.text();
  } catch {
    await finish("UNKNOWN");
    return { ok: false, reason: "RECONCILIATION_REQUIRED" };
  }
  let accepted = false;
  try { accepted = res.ok && JSON.parse(body).clearanceStatus === "CLEARED"; } catch { /* ambiguous response */ }
  // DB failure here deliberately escapes; the durable SUBMITTING attempt
  // remains reconcilable, never falsely converted to a retryable failure.
  const completed = await finish(accepted ? "CLEARED" : "UNKNOWN", res.status, body);
  return accepted && completed ? { ok: true } : { ok: false, reason: "RECONCILIATION_REQUIRED" };
}
