"use server";

import type { Prisma } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { logAudit } from "@/lib/audit";
import { getCurrentUser, requireActionPermission } from "@/lib/session";
import { effectiveSiteId, isSiteInScope, resolvePlantIdForSite } from "@/lib/siteScope";
import { withSequentialNumber } from "@/lib/sequence";
import { revalidatePath } from "next/cache";

// Per-record-type action key for the two-stage approval chain — Opportunity
// and FieldVisit go Sales Supervisor -> Sales Manager, Quote goes
// Sales Manager -> Plants Manager (see ACTION_ROLES.sales in
// src/lib/permissions.ts for the actual role lists). See
// approveInitialStage/approveFinalStage below for how the "senior role can
// approve directly, skipping the junior stage" rule uses this.
const APPROVABLE_RECORD_TYPES = ["opportunity", "visit", "quote"] as const;
type ApprovableRecordType = (typeof APPROVABLE_RECORD_TYPES)[number];

const APPROVAL_ACTION_KEY: Record<ApprovableRecordType, { initial: "approveOpportunityInitial" | "approveVisitInitial" | "approveQuoteInitial"; final: "approveOpportunityFinal" | "approveVisitFinal" | "approveQuoteFinal" }> = {
  opportunity: { initial: "approveOpportunityInitial", final: "approveOpportunityFinal" },
  visit: { initial: "approveVisitInitial", final: "approveVisitFinal" },
  quote: { initial: "approveQuoteInitial", final: "approveQuoteFinal" },
};

// BL-CR-P1-02, external-review validation (2026-09-10): every mutation in
// this module took a record id from the form, checked the caller's ROLE,
// and then wrote — with no check that the record belongs to the caller's
// site. Role and scope are different questions: a SALES_REP at one site
// legitimately holds "may send a quote", which is not permission to send
// another site's quote. The scope now travels INSIDE each mutation's own
// WHERE clause, so an out-of-scope id matches no row and the write simply
// does not happen; there is no window between an outer read and the write
// for the record to move sites, and no distinguishable "forbidden" answer
// that would confirm the record exists.
//
// Opportunity and Quote carry their own siteId. FieldVisit does not: its
// site is the opportunity it belongs to, and — for a visit logged against
// a customer with no opportunity — the site of the rep who made it. A
// visit whose rep has no plant assigned matches nothing and is therefore
// approvable only by ADMIN, which is the fail-closed direction.
// One builder per model, rather than one shared object: Prisma's where
// types are model-specific, and a single union-typed predicate cannot be
// handed to three different delegates.
function ownSiteScope(allowedSiteId: string | null): { siteId?: string } {
  return allowedSiteId === null ? {} : { siteId: allowedSiteId }; // null = ADMIN, unrestricted
}

function visitScope(allowedSiteId: string | null): Prisma.FieldVisitWhereInput {
  if (allowedSiteId === null) return {};
  return {
    OR: [
      { opportunity: { siteId: allowedSiteId } },
      { opportunityId: null, visitedBy: { plant: { siteId: allowedSiteId } } },
    ],
  };
}

// Thrown inside promoteProspectToCustomer's transaction when the
// conditional claim loses, so Prisma unwinds the Customer row the same
// transaction had just created. Returning a value instead would commit it.
class PromotionLostError extends Error {}

export async function createOpportunity(formData: FormData) {
  const actor = await getCurrentUser();
  await requireActionPermission(actor, "sales", "create");

  const customerId = String(formData.get("customerId") ?? "") || null;
  const prospectName = String(formData.get("prospectName") ?? "").trim() || null;
  const prospectPhone = String(formData.get("prospectPhone") ?? "").trim() || null;
  const prospectEmail = String(formData.get("prospectEmail") ?? "").trim() || null;
  const projectId = String(formData.get("projectId") ?? "") || null;
  const siteId = String(formData.get("siteId") ?? "");
  const mixId = String(formData.get("mixId") ?? "") || null;
  const estimatedVolumeM3 = Number(formData.get("estimatedVolumeM3") ?? 0) || null;
  const source = String(formData.get("source") ?? "").trim() || null;
  const expectedCloseDateRaw = String(formData.get("expectedCloseDate") ?? "");
  const notes = String(formData.get("notes") ?? "").trim() || null;

  // Either a real Customer or at least a prospect name — something to call
  // the lead once it's booked in.
  if ((!customerId && !prospectName) || !siteId) return;
  if (!isSiteInScope(siteId, effectiveSiteId(actor))) return;

  const opportunity = await withSequentialNumber(
    "OPP",
    (yr) => prisma.opportunity.count({ where: { createdAt: yr } }),
    (opportunityNumber) =>
      prisma.opportunity.create({
        data: {
          opportunityNumber,
          customerId,
          prospectName,
          prospectPhone,
          prospectEmail,
          projectId,
          siteId,
          mixId,
          estimatedVolumeM3,
          source,
          expectedCloseDate: expectedCloseDateRaw ? new Date(expectedCloseDateRaw) : null,
          notes,
          ownerId: actor!.id,
        },
      }),
  );

  await logAudit({ module: "Sales", recordId: opportunity.id, afterValue: opportunity.opportunityNumber, reasonCode: "OPPORTUNITY_CREATED" });
  revalidatePath("/sales");
}

export async function updateOpportunity(formData: FormData) {
  const actor = await getCurrentUser();
  await requireActionPermission(actor, "sales", "update");

  const id = String(formData.get("id") ?? "");
  const prospectName = String(formData.get("prospectName") ?? "").trim() || null;
  const prospectPhone = String(formData.get("prospectPhone") ?? "").trim() || null;
  const prospectEmail = String(formData.get("prospectEmail") ?? "").trim() || null;
  const projectId = String(formData.get("projectId") ?? "") || null;
  const mixId = String(formData.get("mixId") ?? "") || null;
  const estimatedVolumeM3 = Number(formData.get("estimatedVolumeM3") ?? 0) || null;
  const source = String(formData.get("source") ?? "").trim() || null;
  const expectedCloseDateRaw = String(formData.get("expectedCloseDate") ?? "");
  const notes = String(formData.get("notes") ?? "").trim() || null;
  const ownerId = String(formData.get("ownerId") ?? "") || null;

  if (!id) return;
  const existing = await prisma.opportunity.findUnique({ where: { id } });
  if (!existing) return;
  if (!isSiteInScope(existing.siteId, effectiveSiteId(actor))) return;

  await prisma.opportunity.update({
    where: { id },
    data: {
      prospectName,
      prospectPhone,
      prospectEmail,
      projectId,
      mixId,
      estimatedVolumeM3,
      source,
      expectedCloseDate: expectedCloseDateRaw ? new Date(expectedCloseDateRaw) : null,
      notes,
      ownerId,
    },
  });

  await logAudit({ module: "Sales", recordId: id, afterValue: "opportunity updated", reasonCode: "OPPORTUNITY_UPDATED" });
  revalidatePath("/sales");
}

// NEW -> CONTACTED -> SITE_VISIT -> QUOTED -> NEGOTIATION -> WON/LOST — a
// plain linear pipeline; nothing here enforces the order beyond requiring
// a reason once a deal is marked LOST, so a stage can be skipped or
// revisited freely as the real conversation with the customer requires.
export async function advanceOpportunityStage(formData: FormData) {
  const actor = await getCurrentUser();
  await requireActionPermission(actor, "sales", "advanceStage");

  const id = String(formData.get("id") ?? "");
  const status = String(formData.get("status") ?? "");
  const lostReasonCode = String(formData.get("lostReasonCode") ?? "").trim() || null;
  if (!id || !status) return;
  if (status === "LOST" && !lostReasonCode) return;

  const existing = await prisma.opportunity.findUnique({ where: { id } });
  if (!existing) return;
  if (!isSiteInScope(existing.siteId, effectiveSiteId(actor))) return;
  // A deal only counts as WON once the Sales Manager has signed off (final
  // stage — see the model comment; finalApprovedAt being set also implies
  // initial was either done or covered by the manager's own direct
  // approval). Every other stage transition (including LOST) stays
  // unblocked so the day-to-day pipeline never waits on approval.
  if (status === "WON" && !existing.finalApprovedAt) return;

  await prisma.opportunity.update({
    where: { id },
    data: { status, lostReasonCode: status === "LOST" ? lostReasonCode : null },
  });

  await logAudit({ module: "Sales", recordId: id, afterValue: status, reasonCode: "OPPORTUNITY_STAGE_ADVANCED" });
  revalidatePath("/sales");
}

// Direct parallel to releaseTicketForReservation's "convert X into Y"
// shape in production/actions.ts — a prospect becomes a real Customer once
// the deal is real enough to need one (a quote, an invoice), without
// losing the opportunity's own history by re-creating it from scratch.
export async function promoteProspectToCustomer(formData: FormData) {
  const actor = await getCurrentUser();
  await requireActionPermission(actor, "sales", "promoteProspect");

  const id = String(formData.get("id") ?? "");
  if (!id) return;

  // BL-CR-P1-02: read and write are one transaction, and BOTH carry the
  // scope — the read so another site's prospect is never even seen, the
  // conditional write so a concurrent promotion cannot produce a second
  // Customer for the same prospect. A claim that matches no row rolls the
  // just-created Customer back with it rather than leaving an orphan.
  const allowedSiteId = effectiveSiteId(actor);
  const customer = await prisma.$transaction(async (tx) => {
    const opportunity = await tx.opportunity.findFirst({
      where: { id, customerId: null, ...ownSiteScope(allowedSiteId) },
    });
    if (!opportunity || !opportunity.prospectName) return null;

    const created = await tx.customer.create({
      data: {
        legalName: opportunity.prospectName,
        contactEmail: opportunity.prospectEmail,
        contactPhone: opportunity.prospectPhone,
      },
    });
    const claimed = await tx.opportunity.updateMany({ where: { id, customerId: null }, data: { customerId: created.id } });
    if (claimed.count !== 1) throw new PromotionLostError();
    return created;
  }).catch((e) => {
    if (e instanceof PromotionLostError) return null;
    throw e;
  });
  if (!customer) return;

  await logAudit({ module: "Sales", recordId: id, afterValue: `promoted to customer ${customer.id}`, reasonCode: "PROSPECT_PROMOTED" });
  revalidatePath("/sales");
  revalidatePath("/customers");
}

export async function logFieldVisit(formData: FormData) {
  const actor = await getCurrentUser();
  await requireActionPermission(actor, "sales", "logVisit");

  const opportunityId = String(formData.get("opportunityId") ?? "") || null;
  const customerId = String(formData.get("customerId") ?? "") || null;
  const visitDateRaw = String(formData.get("visitDate") ?? "");
  const purpose = String(formData.get("purpose") ?? "").trim() || null;
  const locationName = String(formData.get("locationName") ?? "").trim() || null;
  const locationUrl = String(formData.get("locationUrl") ?? "").trim() || null;
  const notes = String(formData.get("notes") ?? "").trim();
  const photoDataUrl = String(formData.get("photoDataUrl") ?? "").trim() || null;
  const followUpDateRaw = String(formData.get("followUpDate") ?? "");

  if (!notes) return;

  // BL-CR-P1-02: opportunityId arrives from the form and is written
  // straight onto the visit — and the block further down advances that
  // opportunity's own status. Both are refused unless the opportunity is
  // in the caller's scope; an out-of-scope id is dropped rather than
  // reported, exactly like a nonexistent one.
  const allowedSiteId = effectiveSiteId(actor);
  if (opportunityId) {
    const inScope = await prisma.opportunity.findFirst({
      where: { id: opportunityId, ...ownSiteScope(allowedSiteId) },
      select: { id: true },
    });
    if (!inScope) return;
  }

  const visit = await withSequentialNumber(
    "FV",
    (yr) => prisma.fieldVisit.count({ where: { visitDate: yr } }),
    (visitNumber) =>
      prisma.fieldVisit.create({
        data: {
          visitNumber,
          opportunityId,
          customerId,
          visitedById: actor!.id,
          visitDate: visitDateRaw ? new Date(visitDateRaw) : new Date(),
          purpose,
          locationName,
          locationUrl,
          notes,
          photoDataUrl,
          followUpDate: followUpDateRaw ? new Date(followUpDateRaw) : null,
        },
      }),
  );

  // A visit logged against an opportunity still sitting at NEW is a strong
  // enough signal to move it forward on its own — same "the action IS the
  // stage change" reasoning as approveReservationFinal clearing ON_HOLD.
  if (opportunityId) {
    // Conditional, so the status only advances from the two states this
    // rule covers — and only for an opportunity still in scope.
    await prisma.opportunity.updateMany({
      where: { id: opportunityId, status: { in: ["NEW", "CONTACTED"] }, ...ownSiteScope(allowedSiteId) },
      data: { status: "SITE_VISIT" },
    });
  }

  await logAudit({ module: "Sales", recordId: visit.id, reasonCode: "FIELD_VISIT_LOGGED" });
  revalidatePath("/sales");
}

// A quote can only exist as the next step of a real opportunity — never
// created standalone (see the model comment on Quote.opportunityId).
// customerId is derived from the opportunity's own customer rather than
// picked independently, which is also why the opportunity must already
// have a real Customer (not just a prospect) on file: promoteProspectTo
// Customer is the required step before a quote can be built for it.
export async function createQuote(formData: FormData) {
  const actor = await getCurrentUser();
  await requireActionPermission(actor, "sales", "createQuote");

  const opportunityId = String(formData.get("opportunityId") ?? "");
  const projectId = String(formData.get("projectId") ?? "") || null;
  const siteId = String(formData.get("siteId") ?? "");
  const validUntilRaw = String(formData.get("validUntil") ?? "");
  const notes = String(formData.get("notes") ?? "").trim() || null;

  const mixIds = formData.getAll("mixId").map(String);
  const volumes = formData.getAll("estimatedVolumeM3").map(Number);
  const unitPrices = formData.getAll("unitPrice").map(Number);
  const lines = mixIds
    .map((mixId, i) => ({ mixId, estimatedVolumeM3: volumes[i] || 0, unitPrice: unitPrices[i] || 0 }))
    .filter((l) => l.mixId && l.estimatedVolumeM3 > 0 && l.unitPrice > 0)
    .map((l) => ({ ...l, lineTotal: l.estimatedVolumeM3 * l.unitPrice }));

  if (!opportunityId || !siteId || lines.length === 0) return;
  if (!isSiteInScope(siteId, effectiveSiteId(actor))) return;

  const opportunity = await prisma.opportunity.findUnique({ where: { id: opportunityId } });
  if (!opportunity || !opportunity.customerId) return;
  const customerId = opportunity.customerId;

  const plantId = await resolvePlantIdForSite(siteId);
  const plant = plantId ? await prisma.plant.findUnique({ where: { id: plantId } }) : null;
  const currency = plant?.currency ?? "EGP";
  const taxRatePct = plant?.taxRatePct ?? 0;
  const taxLabel = plant?.taxLabel ?? "VAT";

  const subtotal = lines.reduce((sum, l) => sum + l.lineTotal, 0);
  const taxAmount = subtotal * (taxRatePct / 100);
  const total = subtotal + taxAmount;

  const quote = await withSequentialNumber(
    "QT",
    (yr) => prisma.quote.count({ where: { createdAt: yr } }),
    (quoteNumber) =>
      prisma.quote.create({
        data: {
          quoteNumber,
          opportunityId,
          customerId,
          projectId,
          siteId,
          validUntil: validUntilRaw ? new Date(validUntilRaw) : null,
          currency,
          subtotal,
          taxRatePct,
          taxLabel,
          taxAmount,
          total,
          notes,
          preparedById: actor!.id,
          lines: { create: lines },
        },
      }),
  );

  // Same "the action IS the stage change" reasoning as logFieldVisit above
  // — a quote going out is what "QUOTED" means.
  await prisma.opportunity.update({ where: { id: opportunityId }, data: { status: "QUOTED" } }).catch(() => {});

  await logAudit({ module: "Sales", recordId: quote.id, afterValue: `${quote.quoteNumber} — ${total} ${currency}`, reasonCode: "QUOTE_CREATED" });
  revalidatePath("/sales");
}

// Header fields only, and only while still DRAFT — once a quote has gone
// out (markQuoteSent) its numbers must stay exactly what the customer saw;
// nothing here touches line items or totals.
export async function updateQuote(formData: FormData) {
  const actor = await getCurrentUser();
  await requireActionPermission(actor, "sales", "updateQuote");

  const id = String(formData.get("id") ?? "");
  const validUntilRaw = String(formData.get("validUntil") ?? "");
  const notes = String(formData.get("notes") ?? "").trim() || null;
  if (!id) return;

  const quote = await prisma.quote.findUnique({ where: { id } });
  if (!quote || quote.status !== "DRAFT") return;
  if (!isSiteInScope(quote.siteId, effectiveSiteId(actor))) return;

  await prisma.quote.update({
    where: { id },
    data: { validUntil: validUntilRaw ? new Date(validUntilRaw) : null, notes },
  });

  await logAudit({ module: "Sales", recordId: id, reasonCode: "QUOTE_UPDATED" });
  revalidatePath("/sales");
}

export async function markQuoteSent(formData: FormData) {
  const actor = await getCurrentUser();
  await requireActionPermission(actor, "sales", "markQuoteSent");

  const id = String(formData.get("id") ?? "");
  if (!id) return;

  // BL-CR-P1-02: the whole precondition — this quote, in this caller's
  // scope, still DRAFT, and finally approved — is the WHERE clause of the
  // write itself. A price offer never reaches the customer without final
  // (Plants Manager) sign-off on file: same reasoning as Reservation
  // approval gating production release, see the model comment on Quote.
  const allowedSiteId = effectiveSiteId(actor);
  const sent = await prisma.quote.updateMany({
    where: { id, status: "DRAFT", finalApprovedAt: { not: null }, ...ownSiteScope(allowedSiteId) },
    data: { status: "SENT", sentAt: new Date() },
  });
  if (sent.count !== 1) return;

  // Safe to read unconditionally now: this call owns the transition.
  const quote = await prisma.quote.findUniqueOrThrow({ where: { id }, include: { lines: true } });

  // The moment a fully-approved quote goes out is exactly "last quote
  // submitted to the customer, approved, and still valid" — so this is
  // where it becomes the customer's standing per-m3 price for billing and
  // for suggesting future quote lines (see QuoteLineRows' suggestedPrice),
  // until a later quote's own send supersedes it the same way.
  if (!quote.validUntil || quote.validUntil >= new Date()) {
    for (const line of quote.lines) {
      await prisma.priceListEntry.upsert({
        where: { customerId_mixId: { customerId: quote.customerId, mixId: line.mixId } },
        create: { customerId: quote.customerId, mixId: line.mixId, pricePerM3: line.unitPrice },
        update: { pricePerM3: line.unitPrice },
      });
    }
  }

  await logAudit({ module: "Sales", recordId: id, afterValue: "SENT", reasonCode: "QUOTE_SENT" });
  revalidatePath("/sales");
  revalidatePath(`/sales/quotes/${id}`);
  revalidatePath("/finance");
}

export async function recordQuoteResponse(formData: FormData) {
  const actor = await getCurrentUser();
  await requireActionPermission(actor, "sales", "recordQuoteResponse");

  const id = String(formData.get("id") ?? "");
  const response = String(formData.get("response") ?? "");
  if (!id || !["ACCEPTED", "DECLINED"].includes(response)) return;

  // BL-CR-P1-02: scope and state are both in the write's own WHERE, so a
  // quote from another site (or one already answered) matches nothing.
  const allowedSiteId = effectiveSiteId(actor);
  const answered = await prisma.quote.updateMany({
    where: { id, status: "SENT", ...ownSiteScope(allowedSiteId) },
    data: { status: response, respondedAt: new Date() },
  });
  if (answered.count !== 1) return;
  const quote = await prisma.quote.findUniqueOrThrow({ where: { id } });

  if (response === "ACCEPTED" && quote.opportunityId) {
    await prisma.opportunity.update({ where: { id: quote.opportunityId }, data: { status: "WON" } }).catch(() => {});
  }

  await logAudit({ module: "Sales", recordId: id, afterValue: response, reasonCode: "QUOTE_RESPONSE_RECORDED" });
  revalidatePath("/sales");
  revalidatePath(`/sales/quotes/${id}`);
}

// Second, simpler reservation-creation path alongside createReservation —
// same relationship createManualRelease already has to createReservation
// in production/actions.ts: not a shared helper, a self-approved booking
// created directly from an already-accepted price offer rather than going
// through the normal two-stage approval flow, since accepting the quote
// already WAS the customer's and the sales side's sign-off.
export async function convertQuoteLineToReservation(formData: FormData) {
  const actor = await getCurrentUser();
  await requireActionPermission(actor, "sales", "convertQuoteToReservation");

  const quoteLineId = String(formData.get("quoteLineId") ?? "");
  if (!quoteLineId) return;

  const line = await prisma.quoteLine.findUnique({
    where: { id: quoteLineId },
    include: { quote: true, reservation: true },
  });
  if (!line || line.reservation) return; // already converted
  if (line.quote.status !== "ACCEPTED") return;
  if (!line.quote.projectId) return; // Reservation.projectId is required
  if (!isSiteInScope(line.quote.siteId, effectiveSiteId(actor))) return;

  const now = new Date();
  const reservation = await withSequentialNumber(
    "RES",
    (yr) => prisma.reservation.count({ where: { createdAt: yr } }),
    (reservationNumber) =>
      prisma.reservation.create({
        data: {
          reservationNumber,
          projectId: line.quote.projectId!,
          siteId: line.quote.siteId,
          mixId: line.mixId,
          requestedVolumeM3: line.estimatedVolumeM3,
          originalVolumeM3: line.estimatedVolumeM3,
          pourWindowStart: now,
          status: "CONFIRMED",
          initialApprovedAt: now,
          initialApprovedById: actor!.id,
          finalApprovedAt: now,
          finalApprovedById: actor!.id,
          quoteLineId: line.id,
        },
      }),
  );

  await logAudit({
    module: "Reservations",
    recordId: reservation.id,
    afterValue: `${line.estimatedVolumeM3} m3 (from ${line.quote.quoteNumber})`,
    reasonCode: "RESERVATION_CREATED_FROM_QUOTE",
  });

  revalidatePath("/sales");
  revalidatePath(`/sales/quotes/${line.quoteId}`);
  revalidatePath("/reservations");
}

// --- Two-stage approval (role pair depends on record type — see
// APPROVAL_CONFIG above) --------------------------------------------------
// One generic pair of actions across all three Sales record types rather
// than six near-identical ones, mirroring how reconcileMovement in the
// Finance module handles three money-movement kinds through one action.
// Each model's own field names (initialApprovedAt/By, finalApprovedAt/By)
// are identical by design so this can stay generic.

// Prisma's per-model delegates aren't polymorphically callable through a
// single union-typed reference (each has its own where/data shape), so
// this branches explicitly per type rather than trying to share one
// generic delegate call — still one pair of exported actions, just an
// internal switch instead of a shared client reference.
// BL-CR-P1-02: both halves carry the scope. The read is what the final
// stage needs in order to decide whether to backfill the junior stage;
// the write re-states the same scope AND the "not already approved"
// precondition, so the decision made from the read can never be applied
// to a record that moved out of scope (or got approved by someone else)
// in between.
type ApprovalStageWrite = { initialApprovedAt?: Date; initialApprovedById?: string; finalApprovedAt?: Date; finalApprovedById?: string };

async function findApprovable(recordType: ApprovableRecordType, id: string, allowedSiteId: string | null) {
  if (recordType === "opportunity") return prisma.opportunity.findFirst({ where: { id, ...ownSiteScope(allowedSiteId) } });
  if (recordType === "visit") return prisma.fieldVisit.findFirst({ where: { id, ...visitScope(allowedSiteId) } });
  return prisma.quote.findFirst({ where: { id, ...ownSiteScope(allowedSiteId) } });
}

async function claimApprovable(
  recordType: ApprovableRecordType,
  id: string,
  allowedSiteId: string | null,
  stage: "initial" | "final",
  data: ApprovalStageWrite,
): Promise<boolean> {
  const unapproved = stage === "initial" ? { initialApprovedAt: null } : { finalApprovedAt: null };
  const claimed =
    recordType === "opportunity"
      ? await prisma.opportunity.updateMany({ where: { id, ...unapproved, ...ownSiteScope(allowedSiteId) }, data })
      : recordType === "visit"
        ? await prisma.fieldVisit.updateMany({ where: { id, ...unapproved, ...visitScope(allowedSiteId) }, data })
        : await prisma.quote.updateMany({ where: { id, ...unapproved, ...ownSiteScope(allowedSiteId) }, data });
  return claimed.count === 1;
}

// First (junior) stage — Sales Supervisor for Opportunity/FieldVisit,
// Sales Manager for Quote. Anyone holding that role may sign off,
// regardless of who created the record — a manager approving their own
// team's work is the point, not a conflict to guard against.
export async function approveInitialStage(formData: FormData) {
  const actor = await getCurrentUser();

  const recordType = String(formData.get("recordType") ?? "");
  const id = String(formData.get("id") ?? "");
  if (!APPROVABLE_RECORD_TYPES.includes(recordType as ApprovableRecordType) || !id) return;
  const type = recordType as ApprovableRecordType;
  await requireActionPermission(actor, "sales", APPROVAL_ACTION_KEY[type].initial);

  const claimed = await claimApprovable(type, id, effectiveSiteId(actor), "initial", {
    initialApprovedAt: new Date(),
    initialApprovedById: actor!.id,
  });
  if (!claimed) return;

  await logAudit({ module: "Sales", recordId: id, afterValue: `${type} initial approved`, reasonCode: "SALES_INITIAL_APPROVED" });
  revalidatePath("/sales");
}

// Second (senior) stage — Sales Manager for Opportunity/FieldVisit,
// Plants Manager for Quote. Doesn't require the first stage to already be
// on file: a senior approving directly covers both at once (backfilled
// here with the same actor/timestamp) — the senior role's sign-off
// satisfies the junior stage's requirement, it doesn't depend on it.
export async function approveFinalStage(formData: FormData) {
  const actor = await getCurrentUser();

  const recordType = String(formData.get("recordType") ?? "");
  const id = String(formData.get("id") ?? "");
  if (!APPROVABLE_RECORD_TYPES.includes(recordType as ApprovableRecordType) || !id) return;
  const type = recordType as ApprovableRecordType;
  await requireActionPermission(actor, "sales", APPROVAL_ACTION_KEY[type].final);

  const allowedSiteId = effectiveSiteId(actor);
  const existing = await findApprovable(type, id, allowedSiteId);
  if (!existing || existing.finalApprovedAt) return;

  const now = new Date();
  const claimed = await claimApprovable(type, id, allowedSiteId, "final", {
    finalApprovedAt: now,
    finalApprovedById: actor!.id,
    ...(!existing.initialApprovedAt ? { initialApprovedAt: now, initialApprovedById: actor!.id } : {}),
  });
  if (!claimed) return;

  await logAudit({ module: "Sales", recordId: id, afterValue: `${type} final approved`, reasonCode: "SALES_FINAL_APPROVED" });
  revalidatePath("/sales");
}
