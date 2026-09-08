"use server";

import { prisma } from "@/lib/prisma";
import { logAudit } from "@/lib/audit";
import { maybeAutoRequisitionMaterial, queuePendingAutoRequisition } from "@/lib/materialRequisition";
import { getCurrentUser, requireActionPermission } from "@/lib/session";
import { isReservationApproved } from "@/lib/reservations";
import { effectiveSiteId, isPlantActive, isPlantInScope, isSiteInScope } from "@/lib/siteScope";
import { AGGREGATE_TYPES } from "@/lib/storageMatching";
import { completeBatchTicket, reverseBatchTicket as reverseBatchTicketDomain, cancelBatchTicket as cancelBatchTicketDomain } from "@/lib/batchCompletion";
import { claimAndRecordActuals, claimAndRecordActualField, claimAndAddTicketComponent, claimAndDeleteTicketComponent } from "@/lib/batchComponentEdits";
import { startTripForTicket, type StartTripResult } from "@/lib/tripDispatch";
import { reassignTrip, type ReassignTripResult } from "@/lib/tripAssignment";
import { releaseTicketForReservation } from "@/lib/reservationRelease";
import { parseReturnTarget, releaseSuccessPath, releaseFailurePath, parseTripReturnTarget, tripReturnPath } from "@/lib/releaseRouting";
import {
  requestShortageOverride as requestShortageOverrideDomain,
  approveShortageOverrideRequest as approveShortageOverrideRequestDomain,
  rejectShortageOverrideRequest as rejectShortageOverrideRequestDomain,
} from "@/lib/shortageOverrideRequests";
import { withSequentialNumber } from "@/lib/sequence";
import { SHORTAGE_OVERRIDE_DECISION_ROLES } from "@/lib/permissions";
import { notify, notifyRoles } from "@/lib/notify";
import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";

// A single mixer truck load, never exceeded regardless of how much of the
// reservation remains — the same ceiling the release form's own input
// max enforces client-side (production/page.tsx); this is the real gate.
const MAX_LOAD_M3 = 15;

// A sanity ceiling for a weighed aggregate moisture reading (PL-P2-06) —
// not a typical real-world value (moisture content is usually a few
// percent of dry mass), just the widest bound past which a reading is
// certainly a data-entry error rather than a real measurement, so it's
// dropped the same way a negative or non-finite one already is.
const MOISTURE_PCT_MAX = 100;

// A reservation's requested volume is a target, not a single truck load —
// a 200 m³ pour goes out as many partial tickets (one per truck), each
// deducting from what's left, until the reservation is fully dispatched.
// Which STATION each of those tickets actually comes from is picked right
// here, per release — not fixed once on the reservation — since capacity
// at a specific line can genuinely differ truck to truck.
export async function releaseBatchTicket(formData: FormData) {
  const user = await getCurrentUser();
  await requireActionPermission(user, "production", "release");

  const reservationId = String(formData.get("reservationId") ?? "");
  const plantId = String(formData.get("plantId") ?? "");
  const requestedVolume = Number(formData.get("volumeM3") ?? 0);
  // Lets the mobile field view (/operator) land back on its own ticket
  // detail page instead of the desktop one after releasing — same action,
  // same business logic, just a different "where do I keep working"
  // target. An allow-listed symbol, not a raw path (RMR-R4-P2-01): the
  // old version concatenated a form-supplied `returnPrefix` string
  // straight into the redirect target, which is an open redirect for
  // any authenticated caller who submits something other than the two
  // values the UI itself ever sends.
  const returnTarget = parseReturnTarget(formData.get("returnTarget"));
  if (!reservationId || !plantId || !requestedVolume || requestedVolume <= 0) return;
  if (requestedVolume > MAX_LOAD_M3) return;

  const reservation = await prisma.reservation.findUnique({ where: { id: reservationId } });
  if (!reservation) return;
  // Re-check server-side — the picker on /production only ever lists
  // reservations that already cleared both sign-offs, but a stale page
  // or a second tab shouldn't be able to release against one that hasn't.
  if (!isReservationApproved(reservation)) return;
  const siteId = effectiveSiteId(user!);
  if (siteId !== null && reservation.siteId !== siteId) return;
  // The chosen station must actually belong to this reservation's plant
  // (site), and must be active — same guards used everywhere else a
  // station gets picked for something new.
  if (!(await isPlantInScope(plantId, reservation.siteId))) return;
  if (!(await isPlantActive(plantId))) return;

  const result = await releaseTicketForReservation(reservationId, requestedVolume, plantId, { id: user!.id, role: user!.role, allowedSiteId: siteId });
  if (result.status !== "OK") {
    // Not silently doing nothing (RMR-P2-07, RMR-R2-P2-03) — logged for
    // every non-OK outcome, and surfaced as a visible banner on the
    // returning page (production/page.tsx and the operator home page
    // both read releaseError) rather than just a silent reload with no
    // explanation.
    await logAudit({
      module: "Production",
      recordId: reservationId,
      reasonCode: `RELEASE_${result.status}`,
      afterValue: result.status === "STORAGE_NOT_CONFIGURED" ? result.material : undefined,
    });
    const params = new URLSearchParams({ releaseError: result.status });
    if (result.status === "STORAGE_NOT_CONFIGURED") params.set("releaseErrorMaterial", result.material);
    redirect(releaseFailurePath(returnTarget, params));
  }

  // The successful-release BATCH_RELEASED audit event is written inside
  // releaseTicketForReservation itself now, atomically with the ticket
  // (RMR-R4-P2-02) — nothing left to log here on success.
  revalidatePath("/production");
  revalidatePath("/operator");
  revalidatePath("/reservations");
  redirect(releaseSuccessPath(returnTarget, result.ticket.id));
}

// A walk-in sale — a customer at the yard with no prior booking. Creates
// the reservation and releases the first ticket against it in one step,
// self-approved by the operator submitting it rather than going through
// the two-stage sign-off gate: that gate exists for a planned pour that
// hasn't happened yet, not a truck idling at the yard waiting to load.
export async function createManualRelease(formData: FormData) {
  const user = await getCurrentUser();
  await requireActionPermission(user, "production", "manualBooking");

  const projectId = String(formData.get("projectId") ?? "");
  const siteId = String(formData.get("siteId") ?? "");
  const plantId = String(formData.get("plantId") ?? "");
  const mixId = String(formData.get("mixId") ?? "");
  const volumeM3 = Number(formData.get("volumeM3") ?? 0);
  if (!projectId || !siteId || !plantId || !mixId || !volumeM3 || volumeM3 <= 0) return;
  if (volumeM3 > MAX_LOAD_M3) return;

  const project = await prisma.project.findUnique({ where: { id: projectId } });
  if (!project) return;
  if (!isSiteInScope(siteId, effectiveSiteId(user!))) return;
  // The chosen station must actually belong to the chosen plant (site).
  if (!(await isPlantInScope(plantId, siteId))) return;
  if (!(await isPlantActive(plantId))) return; // frozen/decommissioned line: no new bookings

  const now = new Date();
  const reservation = await withSequentialNumber(
    "RES",
    (yr) => prisma.reservation.count({ where: { createdAt: yr } }),
    (reservationNumber) =>
      prisma.reservation.create({
        data: {
          reservationNumber,
          projectId,
          siteId,
          mixId,
          requestedVolumeM3: volumeM3,
          pourWindowStart: now,
          status: "CONFIRMED",
          initialApprovedAt: now,
          initialApprovedById: user!.id,
          finalApprovedAt: now,
          finalApprovedById: user!.id,
        },
      }),
  );

  await logAudit({
    module: "Reservations",
    recordId: reservation.id,
    afterValue: `${volumeM3} m3`,
    reasonCode: "MANUAL_BOOKING_CREATED",
  });

  // effectiveSiteId(user!) here, not the form's own `siteId` — that's
  // the site the operator CHOSE to book against (already validated
  // in scope above), not the actor's own authority; allowedSiteId must
  // always be server-derived from the session, never form data
  // (RMR-R5-P1-01).
  const result = await releaseTicketForReservation(reservation.id, volumeM3, plantId, { id: user!.id, role: user!.role, allowedSiteId: effectiveSiteId(user!) });
  if (result.status !== "OK") {
    // Operational decision (RMR-R2-P2-03): the reservation created just
    // above is KEPT, not rolled back or auto-cancelled — it's a real,
    // confirmed, fully-signed-off booking (self-approved, same as any
    // other manual booking), and once whatever blocked release is fixed
    // (e.g. a requisition arrives), it already shows up in the normal
    // "ready to release" list below like any other confirmed reservation,
    // so an operator can just retry it from there — no separate recovery
    // flow needed. What was actually missing was any visible sign that
    // this happened at all; now logged AND surfaced as a banner (with an
    // explicit note that the booking is on file for retry), rather than
    // a walk-in customer's booking silently vanishing from view with no
    // ticket and no explanation.
    await logAudit({
      module: "Production",
      recordId: reservation.id,
      reasonCode: `RELEASE_${result.status}`,
      afterValue: result.status === "STORAGE_NOT_CONFIGURED" ? result.material : undefined,
    });
    revalidatePath("/production");
    revalidatePath("/reservations");
    const params = new URLSearchParams({ releaseError: result.status, manualBookingKept: "1" });
    if (result.status === "STORAGE_NOT_CONFIGURED") params.set("releaseErrorMaterial", result.material);
    redirect(`/production?${params.toString()}`);
  }

  // Same as releaseBatchTicket — the BATCH_RELEASED audit event is
  // written inside releaseTicketForReservation itself, atomically with
  // the ticket (RMR-R4-P2-02).
  revalidatePath("/production");
  revalidatePath("/reservations");
  redirect(`/production/${result.ticket.id}`);
}

// PL-R10-P1-04, tenth production-lifecycle review: was a bare void-
// returning action bound straight to a plain <form action={recordActuals}>
// — a STALE_READING result (the whole bulk write correctly rolled back by
// claimAndRecordActuals, PL-R9-P1-03) had no way to reach the page at all.
// The operator saw the form simply reload with no indication anything had
// gone wrong, recreating exactly the false-success appearance the version
// work was meant to eliminate. Now a typed useActionState action —
// RecordActualsForm.tsx is the Client Component wrapper that actually
// renders NOT_FOUND/TERMINAL/STALE_READING as a visible, localized banner
// on both production and operator ticket pages.
export type RecordActualsActionState = { status: "OK" | "NOT_FOUND" | "TERMINAL" | "STALE_READING" } | null;

export async function recordActuals(_prevState: RecordActualsActionState, formData: FormData): Promise<RecordActualsActionState> {
  const user = await getCurrentUser();
  await requireActionPermission(user, "production", "recordActuals");

  const batchTicketId = String(formData.get("batchTicketId") ?? "");
  if (!batchTicketId) return { status: "NOT_FOUND" };

  // Same COMPLETE boundary recordActualField already enforces (line ~337
  // below) — this bulk sibling was missing it entirely. Without this guard,
  // saving readings on an already-COMPLETE ticket flips it back to
  // BATCHING, which clears completeBatch's own `status === "COMPLETE"`
  // guard and lets a resubmit deduct the same materials from inventory a
  // second time.
  const ticket = await prisma.batchTicket.findUnique({ where: { id: batchTicketId } });
  if (!ticket) return { status: "NOT_FOUND" };
  if (ticket.status === "COMPLETE" || ticket.status === "CANCELLED") return { status: "TERMINAL" };
  if (!(await isPlantInScope(ticket.plantId, effectiveSiteId(user)))) return { status: "NOT_FOUND" };

  const components = await prisma.batchComponentActual.findMany({
    where: { batchTicketId },
    include: { material: true },
  });

  // Validate/parse first (no writes yet), then commit everything —
  // including the ticket's own status flip — inside one transaction that
  // claims the ticket row atomically before touching anything. Without
  // this, completeBatchTicket's own claim (src/lib/batchCompletion.ts)
  // could commit COMPLETE in the gap between the plain status read above
  // and these writes, letting a reading land on an already-completed
  // ticket whose ledger was posted from whatever the components showed
  // at claim time — this closes that race the same way completion's own
  // claim already closes double-completion.
  const writes: { id: string; actualMassKg: number; moisturePct: number | null; expectedActualVersion: number; expectedMoistureVersion: number }[] = [];
  for (const c of components) {
    const rawActual = formData.get(`actual_${c.id}`);
    const rawMoisture = formData.get(`moisture_${c.id}`);
    // A blank field means "not weighed yet", not "weighed at 0kg" — Number("")
    // is 0, which would otherwise record a real (and wildly wrong) reading.
    if (rawActual === null || rawActual === "") continue;

    // Same "blank means unknown, not zero" reasoning as actual mass above
    // (PL-P2-06) — the old version's `rawMoisture !== null` check let a
    // submitted-but-empty field (FormData returns "", never null, for an
    // empty input) coerce straight to Number("") === 0, recording a real
    // "measured bone-dry" reading for a field the operator just left
    // blank. MOISTURE_PCT_MAX (100) is a sanity ceiling, not a real-world
    // typical value — moisture content this app records is a percentage
    // of dry mass, so it's bounded but not tightly; a genuinely invalid
    // reading (negative, non-finite, or absurdly large) is dropped rather
    // than written, same as a bad actual mass is skipped rather than
    // recorded.
    let moisturePct: number | null = null;
    if (AGGREGATE_TYPES.has(c.material.type) && rawMoisture !== null && rawMoisture !== "") {
      const parsedMoisture = Number(rawMoisture);
      if (!Number.isFinite(parsedMoisture) || parsedMoisture < 0 || parsedMoisture > MOISTURE_PCT_MAX) continue;
      moisturePct = parsedMoisture;
    }
    const enteredMass = Number(rawActual);
    // A negative weighed mass (typo, scale glitch) would later be summed
    // into `currentLevelTons - massTons` in completeBatch and INCREASE the
    // silo/hopper reading instead of decreasing it.
    if (!Number.isFinite(enteredMass) || enteredMass < 0) continue;

    // PL-R9-P1-03: the hidden per-component version inputs the page
    // renders alongside each AutoSaveField (see production/[id]/page.tsx
    // and operator/ticket/[id]/page.tsx) — this bulk submit is the only
    // writer that previously bypassed the version protocol entirely.
    // Missing/malformed defaults to the component's own already-loaded
    // c.actualVersion/c.moistureVersion rather than 0, so a real bulk
    // submit can never be misread as "expects version 0" against a
    // component that has moved on.
    const rawActualVersion = formData.get(`actualVersion_${c.id}`);
    const rawMoistureVersion = formData.get(`moistureVersion_${c.id}`);
    const expectedActualVersion = Number.isInteger(Number(rawActualVersion)) && rawActualVersion !== null ? Number(rawActualVersion) : c.actualVersion;
    const expectedMoistureVersion = Number.isInteger(Number(rawMoistureVersion)) && rawMoistureVersion !== null ? Number(rawMoistureVersion) : c.moistureVersion;

    writes.push({ id: c.id, actualMassKg: enteredMass, moisturePct, expectedActualVersion, expectedMoistureVersion });
  }

  // Audit now written inside claimAndRecordActuals' own claim transaction
  // (PL-R6-P2-01) — no separate logAudit call needed here any more. A
  // STALE_READING result means the whole bulk write was rolled back
  // (PL-R9-P1-03) — still revalidate so the page re-renders with the
  // authoritative current versions instead of leaving the form holding
  // the same stale ones that would just fail again on retry.
  const result = await claimAndRecordActuals(batchTicketId, writes, { id: user!.id, role: user!.role });
  if (result.status === "TERMINAL") return { status: "TERMINAL" };
  if (result.status === "STALE_READING") return { status: "STALE_READING" };

  revalidatePath(`/production/${batchTicketId}`);
  revalidatePath(`/operator/ticket/${batchTicketId}`);
  return { status: "OK" };
}

// One field, saved the instant it's entered — called from AutoSaveField's
// onBlur handler rather than waiting for the whole "Save readings" form to
// be submitted, so a reading typed on the batching floor isn't lost to a
// tab switch or an interrupted operator before that button gets pressed.
// recordActuals (above) still exists for the explicit bulk save/status-flip.
// Every early return below used to be a bare `return;` — AutoSaveField
// treated ANY resolved promise as success, so a rejected save (the
// ticket went COMPLETE/CANCELLED under an autosave in flight, a stale
// component id, an out-of-range value) showed a green checkmark for a
// write that never happened (PL-R6-P2-02, sixth production-lifecycle
// review). Worse, on reconnect the SAME silent-resolve shape made
// flushQueue treat a rejected queued reading as flushed and permanently
// drop it — real, silent measurement loss, not just a cosmetic status
// bug. Every caller (AutoSaveField's own action prop, and the offline
// replay handler in OfflineSyncBanner.tsx) now inspects this typed
// result instead of assuming resolution means success.
export type RecordActualFieldResult =
  | { status: "OK"; version: number }
  | { status: "MISSING_FIELDS" }
  | { status: "INVALID_VALUE" }
  | { status: "NOT_FOUND" }
  | { status: "TERMINAL" }
  // PL-R8-P1-03, eighth production-lifecycle review: a write whose
  // expectedVersion no longer matches the component's real current
  // version — someone/something else's newer write already landed,
  // from any tab/device/offline replay. Rendered through the exact same
  // "rejected" visual path as every other non-OK status (AutoSaveField
  // never special-cased individual reasons) and the exact same REJECTED
  // dead-letter path on offline replay — no new UI branch needed for it.
  | { status: "STALE_READING" };

export async function recordActualField(formData: FormData): Promise<RecordActualFieldResult> {
  const user = await getCurrentUser();
  await requireActionPermission(user, "production", "recordActualField");

  const batchTicketId = String(formData.get("batchTicketId") ?? "");
  const componentId = String(formData.get("componentId") ?? "");
  const field = String(formData.get("field") ?? "");
  const rawValue = formData.get("value");
  const rawVersion = formData.get("expectedVersion");
  if (!batchTicketId || !componentId || rawValue === null || rawValue === "" || rawVersion === null) return { status: "MISSING_FIELDS" };
  if (field !== "actual" && field !== "moisture") return { status: "MISSING_FIELDS" };

  const value = Number(rawValue);
  if (!Number.isFinite(value) || value < 0) return { status: "INVALID_VALUE" };
  if (field === "moisture" && value > MOISTURE_PCT_MAX) return { status: "INVALID_VALUE" };
  const expectedVersion = Number(rawVersion);
  if (!Number.isInteger(expectedVersion) || expectedVersion < 0) return { status: "INVALID_VALUE" };

  const component = await prisma.batchComponentActual.findUnique({
    where: { id: componentId },
    include: { batchTicket: true },
  });
  if (!component || component.batchTicketId !== batchTicketId) return { status: "NOT_FOUND" };
  if (component.batchTicket.status === "COMPLETE" || component.batchTicket.status === "CANCELLED") return { status: "TERMINAL" };
  if (!(await isPlantInScope(component.batchTicket.plantId, effectiveSiteId(user)))) return { status: "NOT_FOUND" };

  // Same claim-then-write shape as recordActuals above: the status flip
  // to BATCHING doubles as the atomic claim that closes the race against
  // completeBatchTicket's own claim on this row (a completion committed
  // in the gap between the plain read above and this write would
  // otherwise let this autosave land on an already-COMPLETE ticket).
  // Always setting "BATCHING" (not conditionally, like the old
  // status !== "BATCHING" check) is harmless when it's already BATCHING
  // — the WHERE clause is what does the real work.
  // Audit now written inside claimAndRecordActualField's own claim
  // transaction (PL-R6-P2-01) — no separate logAudit call needed here.
  const result = await claimAndRecordActualField(batchTicketId, componentId, field, value, expectedVersion, { id: user!.id, role: user!.role });
  if (result.status === "TERMINAL") return { status: "TERMINAL" };
  if (result.status === "STALE_READING") return { status: "STALE_READING" };

  revalidatePath(`/production/${batchTicketId}`);
  revalidatePath(`/operator/ticket/${batchTicketId}`);
  return { status: "OK", version: result.version };
}

// The typed result useActionState (see CompleteBatchForm.tsx) renders —
// mirrors CompleteBatchResult's own status set 1:1 (src/lib/
// batchCompletion.ts) plus NOT_FOUND (wrapper-only) so the UI can show an
// actual reason instead of nothing happening, per this review's HI-05.
export type CompleteBatchActionState = {
  status: "SUCCESS" | "ALREADY_COMPLETED" | "INVALID_STATE" | "INSUFFICIENT_STOCK" | "CONCURRENT_CONFLICT" | "STORAGE_NOT_CONFIGURED" | "NOT_FOUND";
  detail?: string;
} | null;

// Thin Server Action wrapper around completeBatchTicket (src/lib/
// batchCompletion.ts) — the actual claim/deduct/ledger-post logic lives
// there now, as a pure domain service with no session/formData access
// (so it's callable from tests directly). This wrapper's only jobs:
// permission/scope checks, calling the domain service, and turning its
// typed result into the same audit trail and revalidation this action
// always produced, PLUS a returned state useActionState can render (see
// CompleteBatchForm.tsx) — previously every non-SUCCESS status was a
// silent return with nothing shown to the operator.
//
// P1-04: this no longer accepts a shortageOverrideNote field at all — a
// shortage can only be pushed through by an APPROVED
// ShortageOverrideRequest tied to this exact ticket, which
// completeBatchTicket itself looks up and (if actually needed) consumes.
// See requestShortageOverride/approveShortageOverrideRequest/
// rejectShortageOverrideRequest below for that workflow.
export async function completeBatch(_prevState: CompleteBatchActionState, formData: FormData): Promise<CompleteBatchActionState> {
  const user = await getCurrentUser();
  await requireActionPermission(user, "production", "complete");

  const batchTicketId = String(formData.get("batchTicketId") ?? "");
  if (!batchTicketId) return { status: "NOT_FOUND" };

  const ticket = await prisma.batchTicket.findUnique({ where: { id: batchTicketId }, select: { plantId: true } });
  if (!ticket) return { status: "NOT_FOUND" };
  if (!(await isPlantInScope(ticket.plantId, effectiveSiteId(user)))) return { status: "NOT_FOUND" };

  // actorRole now threaded through — completeBatchTicket writes its own
  // audit event(s) inside the SAME transaction as the completion itself
  // (PL-R6-P2-01, sixth production-lifecycle review), so this wrapper no
  // longer writes a separate post-commit logAudit call.
  const result = await completeBatchTicket(batchTicketId, { actorId: user!.id, actorRole: user!.role });
  if (result.status !== "SUCCESS") {
    if (result.status === "INSUFFICIENT_STOCK") return { status: "INSUFFICIENT_STOCK", detail: result.shortages.join("; ") };
    if (result.status === "STORAGE_NOT_CONFIGURED") return { status: "STORAGE_NOT_CONFIGURED", detail: result.material };
    return { status: result.status };
  }

  // The ticket, its inventory ledger, and its own audit event have
  // ALREADY committed successfully by this point — auto-requisition is a
  // best-effort follow-up, not part of what "the batch completed" means.
  // A failure here used to propagate as an uncaught exception, making
  // this whole Server Action look like it failed to the caller even
  // though the actual completion already succeeded — a retry would then
  // see ALREADY_COMPLETED and never get a second chance to open the
  // requisition (PL-R7-P2-02, seventh production-lifecycle review). The
  // new partial-unique DB index on MaterialRequisition (migration
  // harden_production_lifecycle_round7) makes a genuine concurrent
  // duplicate a caught, safe no-op here instead of a silent race.
  for (const r of result.requisitionCandidates) {
    try {
      const toKg = r.unit === "LITERS" ? (liters: number) => liters * (r.specificGravity ?? 1) : (tons: number) => tons * 1000;
      await maybeAutoRequisitionMaterial(r.materialId, r.siteId, r.newLevel, r.capacity, r.minThresholdPct, toKg);
    } catch (e) {
      console.error(`[completeBatch] auto-requisition follow-up failed for material ${r.materialId} (ticket ${batchTicketId}) — the batch itself is still COMPLETE:`, e);
      // PL-R9-P2-03, ninth production-lifecycle review: this used to be
      // just the log line above — a genuine failure here (a transient DB
      // error, or one inside maybeAutoRequisitionMaterial's own
      // notifyRoles call after the requisition row itself already
      // committed) left no durable trace that this shortage never
      // actually got followed up. Queued for the same daily cron sweep
      // (api/cron/cleanup) that already drains PendingBlobDeletion.
      await queuePendingAutoRequisition(batchTicketId, r, e);
    }
  }

  revalidatePath(`/production/${batchTicketId}`);
  revalidatePath(`/operator/ticket/${batchTicketId}`);
  revalidatePath("/operator");
  revalidatePath("/warehouses");
  revalidatePath("/");
  return { status: "SUCCESS" };
}

// ---------------------------------------------------------------------
// P1-04 — shortage override request/approval workflow
// ---------------------------------------------------------------------
// Domain logic lives in src/lib/shortageOverrideRequests.ts (pure, no
// session/formData access, callable from tests directly) — same split as
// completeBatchTicket/reverseBatchTicket above. These wrappers only do
// permission/scope checks, call the domain service, and turn the typed
// result into an audit trail, notifications, and a useActionState-shaped
// return.

export type RequestShortageOverrideActionState = {
  status: "OK" | "NOT_FOUND" | "TICKET_TERMINAL" | "ALREADY_PENDING" | "ALREADY_APPROVED" | "NO_SHORTAGE" | "STORAGE_NOT_CONFIGURED";
  detail?: string;
} | null;

// Anyone who can complete a batch can request an override after hitting a
// real shortage — the roster is deliberately the same as `complete`, not
// `overrideShortage`, since the whole point of this workflow is letting an
// operator who does NOT hold override authority ask for it instead of
// silently being stuck.
export async function requestShortageOverride(_prevState: RequestShortageOverrideActionState, formData: FormData): Promise<RequestShortageOverrideActionState> {
  const user = await getCurrentUser();
  await requireActionPermission(user, "production", "requestShortageOverride");

  const batchTicketId = String(formData.get("batchTicketId") ?? "");
  const reason = String(formData.get("reason") ?? "").trim();
  if (!batchTicketId || !reason) return { status: "NOT_FOUND" };

  const ticket = await prisma.batchTicket.findUnique({ where: { id: batchTicketId }, select: { plantId: true, ticketNumber: true, plant: { select: { siteId: true } } } });
  if (!ticket) return { status: "NOT_FOUND" };
  if (!(await isPlantInScope(ticket.plantId, effectiveSiteId(user)))) return { status: "NOT_FOUND" };

  const result = await requestShortageOverrideDomain(batchTicketId, { reason, requestedById: user!.id });
  if (result.status === "OK") {
    await logAudit({ module: "Production", recordId: batchTicketId, field: "shortageOverrideRequestId", afterValue: result.requestId, reasonCode: "SHORTAGE_OVERRIDE_REQUESTED" });
    // Site-scoped (FR-P1-02, third review) — a manager at a different site
    // has no business reasons/decision-authority over this ticket, so they
    // must not be paged about it either.
    await notifyRoles(
      SHORTAGE_OVERRIDE_DECISION_ROLES,
      {
        module: "Production",
        title: `Shortage override requested — ${ticket.ticketNumber}`,
        body: reason,
        link: `/production/${batchTicketId}`,
      },
      { siteId: ticket.plant.siteId },
    );
    revalidatePath(`/production/${batchTicketId}`);
    revalidatePath("/production");
    return { status: "OK" };
  }
  if (result.status === "STORAGE_NOT_CONFIGURED") return { status: "STORAGE_NOT_CONFIGURED", detail: result.material };
  return { status: result.status };
}

export type DecideShortageOverrideActionState = { status: "OK" | "NOT_FOUND" | "NOT_PENDING" } | null;

export async function approveShortageOverrideRequest(_prevState: DecideShortageOverrideActionState, formData: FormData): Promise<DecideShortageOverrideActionState> {
  const user = await getCurrentUser();
  await requireActionPermission(user, "production", "approveShortageOverrideRequest");

  const requestId = String(formData.get("requestId") ?? "");
  if (!requestId) return { status: "NOT_FOUND" };

  const request = await prisma.shortageOverrideRequest.findUnique({ where: { id: requestId }, include: { batchTicket: { select: { plantId: true, ticketNumber: true } } } });
  if (!request) return { status: "NOT_FOUND" };
  if (!(await isPlantInScope(request.batchTicket.plantId, effectiveSiteId(user)))) return { status: "NOT_FOUND" };

  const result = await approveShortageOverrideRequestDomain(requestId, user!.id);
  if (result.status === "OK") {
    await logAudit({ module: "Production", recordId: request.batchTicketId, field: "shortageOverrideRequestId", afterValue: requestId, reasonCode: "SHORTAGE_OVERRIDE_APPROVED" });
    await notify([request.requestedById], {
      module: "Production",
      title: `Shortage override approved — ${request.batchTicket.ticketNumber}`,
      link: `/production/${request.batchTicketId}`,
    });
    revalidatePath(`/production/${request.batchTicketId}`);
    revalidatePath("/production");
  }
  return { status: result.status };
}

export async function rejectShortageOverrideRequest(_prevState: DecideShortageOverrideActionState, formData: FormData): Promise<DecideShortageOverrideActionState> {
  const user = await getCurrentUser();
  await requireActionPermission(user, "production", "rejectShortageOverrideRequest");

  const requestId = String(formData.get("requestId") ?? "");
  const rejectionNote = String(formData.get("rejectionNote") ?? "").trim();
  if (!requestId || !rejectionNote) return { status: "NOT_FOUND" };

  const request = await prisma.shortageOverrideRequest.findUnique({ where: { id: requestId }, include: { batchTicket: { select: { plantId: true, ticketNumber: true } } } });
  if (!request) return { status: "NOT_FOUND" };
  if (!(await isPlantInScope(request.batchTicket.plantId, effectiveSiteId(user)))) return { status: "NOT_FOUND" };

  const result = await rejectShortageOverrideRequestDomain(requestId, user!.id, rejectionNote);
  if (result.status === "OK") {
    await logAudit({ module: "Production", recordId: request.batchTicketId, field: "shortageOverrideRequestId", afterValue: `${requestId} — ${rejectionNote}`, reasonCode: "SHORTAGE_OVERRIDE_REJECTED" });
    await notify([request.requestedById], {
      module: "Production",
      title: `Shortage override rejected — ${request.batchTicket.ticketNumber}`,
      body: rejectionNote,
      link: `/production/${request.batchTicketId}`,
    });
    revalidatePath(`/production/${request.batchTicketId}`);
    revalidatePath("/production");
  }
  return { status: result.status };
}

// Both dispatch actions below used to silently return on every non-OK
// outcome — a refused dispatch or reassignment looked identical to the
// button simply not having been pressed (PL-R4-P2-02, fourth production-
// lifecycle review, closing part of the same finding PL-R3-P2-01/
// PL-R2-P2-01/PL-P2-01 already raised for the trip/quality pages). Both
// now return their domain result's own typed status, useActionState-
// shaped, same convention as trips/actions.ts. startTrip still redirects
// on success — useActionState tolerates a redirect from inside the
// action perfectly well, since redirect() throws and never reaches the
// return statement below it.
export type StartTripActionState = { status: StartTripResult["status"] } | { status: "MISSING_FIELDS" } | { status: "NOT_FOUND" } | null;
export type UpdateTripAssignmentActionState = { status: ReassignTripResult["status"] } | { status: "MISSING_FIELDS" } | null;

export async function startTrip(_prevState: StartTripActionState, formData: FormData): Promise<StartTripActionState> {
  const user = await getCurrentUser();
  await requireActionPermission(user, "production", "startTrip");

  const batchTicketId = String(formData.get("batchTicketId") ?? "");
  const truckId = String(formData.get("truckId") ?? "");
  const driverId = String(formData.get("driverId") ?? "");
  // A closed two-value target, not a raw path (PL-P2-02): the old version
  // read a form-supplied `returnTo` straight into redirect(), which
  // Next.js will follow even to an absolute external URL — an
  // authenticated open redirect for any caller who submits something
  // other than the one value the field view's own form ever sends.
  const returnTarget = parseTripReturnTarget(formData.get("returnTarget"));
  if (!batchTicketId || !truckId || !driverId) return { status: "MISSING_FIELDS" };

  // Cheap pre-transaction read, purely to know whether this is a pump
  // delivery so the right form fields get parsed — the page only ever
  // renders this form once the ticket is COMPLETE and in scope (see
  // production/[id]/page.tsx's showAssignForm), so this is just a fast-
  // path check for an obviously stale/crafted request. The AUTHORITATIVE
  // re-check of every one of these — ticket state, site scope (including
  // a concurrent Plant transfer, PL-R2-P1-03), and every resource's own
  // existence/status/site/capacity/reach/busy state — happens fresh,
  // inside startTripForTicket's own transaction (src/lib/tripDispatch.ts),
  // the one real domain command the Server Action and the integration
  // suite both call (PL-R2-P2-06).
  const ticket = await prisma.batchTicket.findUnique({ where: { id: batchTicketId }, select: { reservation: { select: { deliveryMethod: true } } } });
  if (!ticket) return { status: "NOT_FOUND" };

  const isPumpDelivery = ticket.reservation.deliveryMethod === "PUMP";
  const pumpId = isPumpDelivery ? String(formData.get("pumpId") ?? "").trim() || null : null;
  const pumpOperatorId = isPumpDelivery ? String(formData.get("pumpOperatorId") ?? "").trim() || null : null;
  const pumpAssistantId = isPumpDelivery ? String(formData.get("pumpAssistantId") ?? "").trim() || null : null;

  const result = await startTripForTicket(batchTicketId, {
    truckId,
    driverId,
    pumpId,
    pumpOperatorId,
    pumpAssistantId,
    allowedSiteId: effectiveSiteId(user),
    actorId: user!.id,
    actorRole: user!.role,
  });
  if (result.status !== "OK") return result;

  // Real push notification (see src/lib/push.ts) the instant this driver
  // is actually dispatched — the whole point of the driver app knowing
  // about a trip the moment it exists, not whenever they next happen to
  // open it. A driver with no linked User account (or none subscribed to
  // push yet) simply gets nothing here — same silent no-op notify() and
  // sendPushToUser() already are in every other case.
  const dispatched = await prisma.batchTicket.findUniqueOrThrow({ where: { id: batchTicketId }, select: { ticketNumber: true, volumeM3: true, reservation: { select: { reservationNumber: true } } } });
  const driverUser = await prisma.user.findUnique({ where: { employeeId: driverId } });
  if (driverUser) {
    await notify([driverUser.id], {
      title: dispatched.reservation.reservationNumber,
      body: `${dispatched.ticketNumber} — ${dispatched.volumeM3} m³`,
      link: `/driver/trip/${result.tripId}`,
      module: "Fleet",
    });
  }

  // Same real push for whichever pump crew just got assigned — /pump-crew
  // has no per-trip detail page (see that page's own comment on why it
  // stays read-only), so the link opens straight to their job list, where
  // this trip now shows up.
  const pumpCrewIds = [pumpOperatorId, pumpAssistantId].filter((id): id is string => Boolean(id));
  if (pumpCrewIds.length > 0) {
    const pumpCrewUsers = await prisma.user.findMany({ where: { pumpCrewMemberId: { in: pumpCrewIds } } });
    if (pumpCrewUsers.length > 0) {
      await notify(pumpCrewUsers.map((u) => u.id), {
        title: dispatched.reservation.reservationNumber,
        body: `${dispatched.ticketNumber} — ${dispatched.volumeM3} m³`,
        link: "/pump-crew",
        module: "Fleet",
      });
    }
  }

  revalidatePath(`/production/${batchTicketId}`);
  revalidatePath("/operator");
  revalidatePath("/trips");
  redirect(tripReturnPath(returnTarget));
}

// A truck, driver, or pump crew name picked wrong at dispatch shouldn't
// need the trip cancelled and re-started — correctable up until it actually
// leaves the yard (status LOADING), same "pre-dispatch only" boundary the
// reservation editor uses for its own fields.
//
// PL-P1-01/PL-P1-02 (first production-lifecycle review): the old version
// never checked the trip's own site against the actor's allowed scope at
// all — a plant-scoped operator who knew or guessed another site's trip
// id could reassign it — and validated almost nothing about the chosen
// resources beyond whether the truck itself was already busy. Every
// check below now runs fresh, inside the same row-locked transaction
// that writes the reassignment, via claimTripResources (the same shared
// validator startTrip itself uses).
export async function updateTripAssignment(_prevState: UpdateTripAssignmentActionState, formData: FormData): Promise<UpdateTripAssignmentActionState> {
  const user = await getCurrentUser();
  await requireActionPermission(user, "production", "updateTripAssignment");

  const tripId = String(formData.get("tripId") ?? "");
  const truckId = String(formData.get("truckId") ?? "");
  const driverId = String(formData.get("driverId") ?? "");
  if (!tripId || !truckId || !driverId) return { status: "MISSING_FIELDS" };

  const pumpId = String(formData.get("pumpId") ?? "").trim() || null;
  const pumpOperatorId = String(formData.get("pumpOperatorId") ?? "").trim() || null;
  const pumpAssistantId = String(formData.get("pumpAssistantId") ?? "").trim() || null;

  const result = await reassignTrip(tripId, {
    truckId,
    driverId,
    pumpId,
    pumpOperatorId,
    pumpAssistantId,
    allowedSiteId: effectiveSiteId(user),
    actorId: user!.id,
    actorRole: user!.role,
  });
  if (result.status !== "OK") return result;

  const trip = await prisma.trip.findUnique({ where: { id: tripId }, select: { batchTicketId: true } });
  revalidatePath(`/production/${trip?.batchTicketId}`);
  revalidatePath("/operator");
  revalidatePath("/trips");
  return { status: "OK" };
}

// A component missed at release time (or a last-minute site addition —
// an extra admixture dose, say) can still be added onto an already-
// released ticket, right up until it's marked COMPLETE and its mass is
// actually deducted from inventory.
export async function addTicketComponent(formData: FormData) {
  const user = await getCurrentUser();
  await requireActionPermission(user, "production", "addTicketComponent");

  const batchTicketId = String(formData.get("batchTicketId") ?? "");
  const materialId = String(formData.get("materialId") ?? "");
  const targetMassKg = Number(formData.get("targetMassKg") ?? 0);
  // !Number.isFinite catches Infinity too (PL-P2-06) — the old
  // `!targetMassKg || targetMassKg <= 0` check alone let an Infinity
  // target mass through (it's truthy and > 0), which would then flow
  // straight into a real inventory deduction at completion time.
  if (!batchTicketId || !materialId || !targetMassKg || targetMassKg <= 0 || !Number.isFinite(targetMassKg)) return;

  const ticket = await prisma.batchTicket.findUnique({ where: { id: batchTicketId } });
  if (!ticket || ticket.status === "COMPLETE" || ticket.status === "CANCELLED") return;
  if (!(await isPlantInScope(ticket.plantId, effectiveSiteId(user)))) return;

  // Touch-claim the ticket row before writing the component — no field
  // here means anything on its own (updatedAt is purely the lock), but
  // taking this row's lock is what makes this write and
  // completeBatchTicket's own claim (src/lib/batchCompletion.ts)
  // mutually exclusive: whichever transaction locks the row first is
  // what the other necessarily sees once it gets its turn.
  // Audit now written inside claimAndAddTicketComponent's own claim
  // transaction (PL-R6-P2-01) — no separate logAudit call needed here.
  const result = await claimAndAddTicketComponent(batchTicketId, materialId, targetMassKg, { id: user!.id, role: user!.role });
  if (result.status !== "OK") return;

  revalidatePath(`/production/${batchTicketId}`);
  revalidatePath(`/operator/ticket/${batchTicketId}`);
}

// Same COMPLETE boundary as addTicketComponent above — once a component's
// mass has actually been deducted from a silo or hopper, removing the row
// would leave that deduction unexplained rather than undoing it.
export async function deleteTicketComponent(formData: FormData) {
  const user = await getCurrentUser();
  await requireActionPermission(user, "production", "deleteTicketComponent");

  const id = String(formData.get("id") ?? "");
  const batchTicketId = String(formData.get("batchTicketId") ?? "");
  if (!id || !batchTicketId) return;

  const component = await prisma.batchComponentActual.findUnique({ where: { id }, include: { batchTicket: true } });
  if (!component || component.batchTicketId !== batchTicketId || component.batchTicket.status === "COMPLETE" || component.batchTicket.status === "CANCELLED") return;
  if (!(await isPlantInScope(component.batchTicket.plantId, effectiveSiteId(user)))) return;

  // Same touch-claim as addTicketComponent above, same reason.
  // Audit now written inside claimAndDeleteTicketComponent's own claim
  // transaction (PL-R6-P2-01) — no separate logAudit call needed here.
  const result = await claimAndDeleteTicketComponent(batchTicketId, id, { id: user!.id, role: user!.role });
  if (result.status !== "OK") return;

  revalidatePath(`/production/${batchTicketId}`);
  revalidatePath(`/operator/ticket/${batchTicketId}`);
}

// Typed result so CancelBatchTicketForm.tsx can show why a cancellation
// was refused instead of nothing happening (same HI-05 posture as
// completeBatch/reverseBatchTicket). Mirrors CancelBatchTicketResult's own
// status set 1:1 (src/lib/batchCompletion.ts) plus NOT_FOUND for this
// wrapper's own missing-id/scope case.
export type CancelBatchTicketActionState = { status: "SUCCESS" | "NOT_FOUND" | "INVALID_STATE" } | null;

// The soft-cancel path for a non-terminal ticket with a ShortageOverrideRequest
// on file, which deleteBatchTicket can no longer actually delete (P2-01,
// fourth review) — see cancelBatchTicket's own comment in batchCompletion.ts.
export async function cancelBatchTicket(_prevState: CancelBatchTicketActionState, formData: FormData): Promise<CancelBatchTicketActionState> {
  const user = await getCurrentUser();
  await requireActionPermission(user, "production", "cancelTicket");

  const batchTicketId = String(formData.get("batchTicketId") ?? "");
  const reason = String(formData.get("reason") ?? "").trim();
  if (!batchTicketId || !reason) return { status: "NOT_FOUND" };

  const ticket = await prisma.batchTicket.findUnique({ where: { id: batchTicketId }, select: { plantId: true, ticketNumber: true } });
  if (!ticket) return { status: "NOT_FOUND" };
  if (!(await isPlantInScope(ticket.plantId, effectiveSiteId(user)))) return { status: "NOT_FOUND" };

  // Audit now written inside cancelBatchTicketDomain's own transaction
  // (PL-R6-P2-01) — no separate logAudit call needed here any more.
  const result = await cancelBatchTicketDomain(batchTicketId, { actorId: user!.id, actorRole: user!.role, reason });
  if (result.status === "SUCCESS") {
    revalidatePath(`/production/${batchTicketId}`);
    revalidatePath("/production");
    revalidatePath("/reservations");
    revalidatePath("/");
  }
  return result;
}

// Mirrors ReverseBatchResult's status set 1:1 (src/lib/batchCompletion.ts)
// plus NOT_FOUND for this wrapper's own missing-id/scope case, so
// ReverseBatchForm.tsx (HI-06) can show an actual reason for a rejected
// reversal instead of nothing happening.
export type ReverseBatchActionState = {
  status: "SUCCESS" | "NOT_FOUND" | "INVALID_STATE" | "ALREADY_REVERSED" | "CONCURRENT_CONFLICT" | "CAPACITY_EXCEEDED" | "STORAGE_NOT_CONFIGURED" | "NO_POSTED_MOVEMENTS";
  detail?: string;
} | null;

// Undoes a COMPLETE ticket's posted inventory movements without deleting
// the ticket — the row and its full posting history stay on file, unlike
// deleteBatchTicket's old COMPLETE-ticket path. See reverseBatchTicket in
// src/lib/batchCompletion.ts for the actual reversal logic; this wrapper
// only handles permission/scope, the reason field, and returning a typed
// state useActionState can render (see ReverseBatchForm.tsx).
export async function reverseBatchTicket(_prevState: ReverseBatchActionState, formData: FormData): Promise<ReverseBatchActionState> {
  const user = await getCurrentUser();
  await requireActionPermission(user, "production", "reverseBatch");

  const id = String(formData.get("id") ?? "");
  const reason = String(formData.get("reason") ?? "").trim();
  if (!id || !reason) return { status: "NOT_FOUND" };

  const ticket = await prisma.batchTicket.findUnique({ where: { id }, select: { plantId: true } });
  if (!ticket) return { status: "NOT_FOUND" };
  if (!(await isPlantInScope(ticket.plantId, effectiveSiteId(user)))) return { status: "NOT_FOUND" };

  // Audit now written inside reverseBatchTicketDomain's own transaction
  // (PL-R6-P2-01) — no separate logAudit call needed here any more.
  const result = await reverseBatchTicketDomain(id, { actorId: user!.id, actorRole: user!.role, reason });
  if (result.status !== "SUCCESS") {
    if (result.status === "STORAGE_NOT_CONFIGURED") return { status: "STORAGE_NOT_CONFIGURED", detail: result.material };
    if (result.status === "CAPACITY_EXCEEDED") return { status: "CAPACITY_EXCEEDED", detail: result.storage };
    if (result.status === "NOT_FOUND") return { status: "NOT_FOUND" };
    return { status: result.status };
  }

  revalidatePath("/production");
  revalidatePath(`/production/${id}`);
  revalidatePath("/warehouses");
  revalidatePath("/");
  return { status: "SUCCESS" };
}
