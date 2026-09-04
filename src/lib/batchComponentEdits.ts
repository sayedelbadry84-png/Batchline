import "server-only";
import { prisma } from "@/lib/prisma";

// The claim-then-write core of recordActuals/recordActualField/
// addTicketComponent/deleteTicketComponent (production/actions.ts),
// extracted so tests can exercise the REAL race-closing logic under real
// Promise.all concurrency against completeBatchTicket, instead of a
// paraphrase of it living only inside the test file — the same reasoning
// that pulled completeBatchTicket/reverseBatchTicket out of their own
// Server Actions in the first place. Each function takes no session/
// formData, just the already-validated ticket/component ids and values;
// the Server Action wrappers keep permission/scope checks, form parsing,
// audit logging, and revalidation.
export type ComponentEditResult = { status: "OK" } | { status: "TERMINAL" };

export async function claimAndRecordActuals(
  ticketId: string,
  writes: { id: string; actualMassKg: number; moisturePct: number | null }[],
): Promise<ComponentEditResult> {
  const claimed = await prisma.$transaction(async (tx) => {
    // Claiming the ticket row (flipping status to BATCHING) is what makes
    // this mutually exclusive with completeBatchTicket's own claim on the
    // same row (src/lib/batchCompletion.ts) — whichever transaction locks
    // the row first is what the other necessarily sees.
    const claim = await tx.batchTicket.updateMany({
      where: { id: ticketId, status: { notIn: ["COMPLETE", "CANCELLED"] } },
      data: { status: "BATCHING" },
    });
    if (claim.count === 0) return false;
    for (const w of writes) {
      await tx.batchComponentActual.update({ where: { id: w.id }, data: { actualMassKg: w.actualMassKg, moisturePct: w.moisturePct } });
    }
    return true;
  });
  return claimed ? { status: "OK" } : { status: "TERMINAL" };
}

export async function claimAndRecordActualField(
  ticketId: string,
  componentId: string,
  field: "actual" | "moisture",
  value: number,
): Promise<ComponentEditResult> {
  const claimed = await prisma.$transaction(async (tx) => {
    // Always sets "BATCHING" (not conditionally) — harmless when it's
    // already BATCHING, since the WHERE clause is what does the real work.
    const claim = await tx.batchTicket.updateMany({
      where: { id: ticketId, status: { notIn: ["COMPLETE", "CANCELLED"] } },
      data: { status: "BATCHING" },
    });
    if (claim.count === 0) return false;
    await tx.batchComponentActual.update({
      where: { id: componentId },
      data: field === "actual" ? { actualMassKg: value } : { moisturePct: value },
    });
    return true;
  });
  return claimed ? { status: "OK" } : { status: "TERMINAL" };
}

export async function claimAndAddTicketComponent(ticketId: string, materialId: string, targetMassKg: number): Promise<ComponentEditResult> {
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
    return true;
  });
  return claimed ? { status: "OK" } : { status: "TERMINAL" };
}

export async function claimAndDeleteTicketComponent(ticketId: string, componentId: string): Promise<ComponentEditResult> {
  const claimed = await prisma.$transaction(async (tx) => {
    const claim = await tx.batchTicket.updateMany({ where: { id: ticketId, status: { notIn: ["COMPLETE", "CANCELLED"] } }, data: { updatedAt: new Date() } });
    if (claim.count === 0) return false;
    await tx.batchComponentActual.delete({ where: { id: componentId } });
    return true;
  });
  return claimed ? { status: "OK" } : { status: "TERMINAL" };
}
