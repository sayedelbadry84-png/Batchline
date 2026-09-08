import "server-only";
import { prisma } from "@/lib/prisma";
import { writeAudit } from "@/lib/audit";

// The claim-then-write core of recordActuals/recordActualField/
// addTicketComponent/deleteTicketComponent (production/actions.ts),
// extracted so tests can exercise the REAL race-closing logic under real
// Promise.all concurrency against completeBatchTicket, instead of a
// paraphrase of it living only inside the test file — the same reasoning
// that pulled completeBatchTicket/reverseBatchTicket out of their own
// Server Actions in the first place. Each function takes no session/
// formData, just the already-validated ticket/component ids and values,
// plus an explicit actor (never read from the session itself — see
// writeAudit's own comment, PL-R6-P2-01, sixth production-lifecycle
// review); the Server Action wrappers keep permission/scope checks, form
// parsing, and revalidation. The audit event is now written INSIDE the
// same claim transaction, not by the wrapper afterward — a failure on
// that write rolls back the business mutation with it, and a caller can
// never see a "failed" result for a write that actually already
// committed.
export type ComponentEditResult = { status: "OK" } | { status: "TERMINAL" };

type Actor = { id: string | null; role: string };

// PL-R9-P1-03, ninth production-lifecycle review: this bulk path used to
// write actualMassKg/moisturePct unconditionally, bypassing the version
// protocol claimAndRecordActualField enforces entirely — an old page
// still holding a stale reading could silently overwrite a genuinely
// newer per-field autosave with no conflict reported at all. Every
// caller now supplies the expectedActualVersion/expectedMoistureVersion
// it rendered with, checked/incremented by the SAME per-field columns
// (actualVersion/moistureVersion) the single-field path uses — so the
// two writers share one real concurrency unit instead of two competing
// ones. A conflict on ANY component rolls back the WHOLE bulk write
// (one transaction, thrown DomainError-style rejection) rather than
// silently applying some rows and dropping others with no visible
// signal — the review's own "atomic visible conflict" requirement.
export type BulkComponentWrite = { id: string; actualMassKg: number; moisturePct: number | null; expectedActualVersion: number; expectedMoistureVersion: number };

export type BulkRecordActualsResult = { status: "OK" } | { status: "TERMINAL" } | { status: "STALE_READING"; staleIds: string[] };

class StaleBulkWriteError extends Error {
  constructor(public staleIds: string[]) {
    super("One or more components were modified by another save since this page was loaded.");
  }
}

export async function claimAndRecordActuals(ticketId: string, writes: BulkComponentWrite[], actor: Actor): Promise<BulkRecordActualsResult> {
  try {
    return await prisma.$transaction(async (tx) => {
      // Claiming the ticket row (flipping status to BATCHING) is what makes
      // this mutually exclusive with completeBatchTicket's own claim on the
      // same row (src/lib/batchCompletion.ts) — whichever transaction locks
      // the row first is what the other necessarily sees.
      const claim = await tx.batchTicket.updateMany({
        where: { id: ticketId, status: { notIn: ["COMPLETE", "CANCELLED"] } },
        data: { status: "BATCHING" },
      });
      if (claim.count === 0) return { status: "TERMINAL" as const };

      const staleIds: string[] = [];
      for (const w of writes) {
        // moisturePct === null means this component's material isn't an
        // aggregate type (production/actions.ts never sends a moisture
        // reading for it) — the moisture version is still checked (it can
        // only ever be its own untouched default in that case) but never
        // incremented, since no moisture field was actually written.
        const data: Record<string, unknown> = { actualMassKg: w.actualMassKg, actualVersion: { increment: 1 } };
        if (w.moisturePct !== null) {
          data.moisturePct = w.moisturePct;
          data.moistureVersion = { increment: 1 };
        }
        const updated = await tx.batchComponentActual.updateMany({
          where: { id: w.id, actualVersion: w.expectedActualVersion, moistureVersion: w.expectedMoistureVersion },
          data,
        });
        if (updated.count === 0) staleIds.push(w.id);
      }
      // Any stale component aborts the whole write — thrown (not
      // returned) so the transaction rolls back every other component
      // this same submit already applied, instead of leaving a partial
      // bulk write silently committed alongside a reported conflict.
      if (staleIds.length > 0) throw new StaleBulkWriteError(staleIds);

      await writeAudit(tx, actor, { module: "Production", recordId: ticketId, field: "actuals", reasonCode: "ACTUALS_RECORDED" });
      return { status: "OK" as const };
    });
  } catch (e) {
    if (e instanceof StaleBulkWriteError) return { status: "STALE_READING" as const, staleIds: e.staleIds };
    throw e;
  }
}

export type RecordActualFieldClaimResult = { status: "OK"; version: number } | { status: "TERMINAL" } | { status: "STALE_READING" };

// expectedVersion is the optimistic-concurrency token PL-R8-P1-03
// (eighth production-lifecycle review) added specifically for this
// function, split per field in PL-R9-P1-03 (ninth review) — see the
// actualVersion/moistureVersion comment in schema.prisma for why a
// single shared column made two independent AutoSaveField instances
// falsely collide on an ordinary sequential save. AutoSaveField's own
// per-instance in-flight coalescing only serializes requests ONE
// mounted component ever issues; it has no idea about another browser
// tab, another device, or a queued offline replay landing later. The
// database is the actual authority: the matching field's version column
// in the WHERE clause means a write whose expectedVersion no longer
// matches that field's real current version — because a NEWER write to
// THAT SAME FIELD already landed, from anywhere — is rejected outright
// as STALE_READING rather than silently applied on top of a value the
// caller never actually saw. A sibling field's own version never enters
// this WHERE clause at all, so it can never cause a false conflict here.
export async function claimAndRecordActualField(
  ticketId: string,
  componentId: string,
  field: "actual" | "moisture",
  value: number,
  expectedVersion: number,
  actor: Actor,
): Promise<RecordActualFieldClaimResult> {
  return prisma.$transaction(async (tx) => {
    // Always sets "BATCHING" (not conditionally) — harmless when it's
    // already BATCHING, since the WHERE clause is what does the real work.
    const claim = await tx.batchTicket.updateMany({
      where: { id: ticketId, status: { notIn: ["COMPLETE", "CANCELLED"] } },
      data: { status: "BATCHING" },
    });
    if (claim.count === 0) return { status: "TERMINAL" as const };

    const updated = await tx.batchComponentActual.updateMany({
      where: field === "actual" ? { id: componentId, actualVersion: expectedVersion } : { id: componentId, moistureVersion: expectedVersion },
      data: field === "actual" ? { actualMassKg: value, actualVersion: { increment: 1 } } : { moisturePct: value, moistureVersion: { increment: 1 } },
    });
    if (updated.count === 0) return { status: "STALE_READING" as const };

    await writeAudit(tx, actor, {
      module: "Production",
      recordId: ticketId,
      field: `component:${componentId}:${field}`,
      afterValue: String(value),
      reasonCode: "ACTUAL_FIELD_AUTOSAVED",
    });
    return { status: "OK" as const, version: expectedVersion + 1 };
  });
}

export async function claimAndAddTicketComponent(ticketId: string, materialId: string, targetMassKg: number, actor: Actor): Promise<ComponentEditResult> {
  const claimed = await prisma.$transaction(async (tx) => {
    // A touch-only claim (no field here means anything on its own —
    // updatedAt is purely the lock) since add/delete-component has no
    // status transition of its own to double as the claim.
    const claim = await tx.batchTicket.updateMany({ where: { id: ticketId, status: { notIn: ["COMPLETE", "CANCELLED"] } }, data: { updatedAt: new Date() } });
    if (claim.count === 0) return false;
    await tx.batchComponentActual.upsert({
      where: { batchTicketId_materialId: { batchTicketId: ticketId, materialId } },
      create: { batchTicketId: ticketId, materialId, targetMassKg },
      update: { targetMassKg },
    });
    await writeAudit(tx, actor, {
      module: "Production",
      recordId: ticketId,
      field: "component",
      afterValue: `${materialId}: ${targetMassKg} kg`,
      reasonCode: "TICKET_COMPONENT_ADDED",
    });
    return true;
  });
  return claimed ? { status: "OK" } : { status: "TERMINAL" };
}

export async function claimAndDeleteTicketComponent(ticketId: string, componentId: string, actor: Actor): Promise<ComponentEditResult> {
  const claimed = await prisma.$transaction(async (tx) => {
    const claim = await tx.batchTicket.updateMany({ where: { id: ticketId, status: { notIn: ["COMPLETE", "CANCELLED"] } }, data: { updatedAt: new Date() } });
    if (claim.count === 0) return false;
    await tx.batchComponentActual.delete({ where: { id: componentId } });
    await writeAudit(tx, actor, { module: "Production", recordId: ticketId, field: "component", reasonCode: "TICKET_COMPONENT_REMOVED" });
    return true;
  });
  return claimed ? { status: "OK" } : { status: "TERMINAL" };
}
