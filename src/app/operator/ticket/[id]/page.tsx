import { redirect, notFound } from "next/navigation";
import Link from "next/link";
import { prisma } from "@/lib/prisma";
import { getCurrentUser } from "@/lib/session";
import { getDictionary } from "@/lib/i18n";
import { recordActualField } from "@/app/(app)/production/actions";
import { rankTrucksForVolume } from "@/lib/dispatch";
import { AutoSaveField } from "@/components/AutoSaveField";
import { RecordActualsForm } from "@/components/RecordActualsForm";
import { OfflineSyncBanner } from "@/components/OfflineSyncBanner";
import { CompleteBatchForm } from "@/components/CompleteBatchForm";
import { StartTripForm } from "@/components/StartTripForm";
import { ShortageOverridePanel, type ShortageSnapshotEntry } from "@/components/ShortageOverridePanel";
import { canPerformAction } from "@/lib/permissions";
import { effectiveSiteId, plantScopeWhere } from "@/lib/siteScope";

const AGGREGATE_TYPES = new Set(["SAND", "COARSE_AGGREGATE"]);

export default async function OperatorTicketPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const user = await getCurrentUser();
  if (!user) redirect("/login");
  if (user.role !== "PLANT_OPERATOR" && user.role !== "ADMIN") redirect("/");

  const { id } = await params;
  const { dict } = await getDictionary();
  const o = dict.operator;
  const m = dict.modules.production;
  const d = m.detail;

  // PL-R5-P1-03, fifth production-lifecycle review: this checked
  // authentication and role, but never whether THIS ticket belongs to
  // the operator's own site — same unscoped-read gap as the desktop
  // production detail page (see that page's own comment).
  const allowedSiteId = effectiveSiteId(user);
  // BL-CR-P1-04, external-review validation (2026-09-10): the local
  // offline queue is partitioned by this string, so a reading saved on a
  // shared plant tablet can never be replayed later under a different
  // person's session (and therefore never audited under the wrong name).
  // Derived on the server from the real session, never from anything the
  // browser could set.
  const queueIdentity = `${user.id}:${allowedSiteId ?? "all-sites"}`;
  const ticket = await prisma.batchTicket.findFirst({
    where: { id, ...plantScopeWhere(allowedSiteId) },
    include: {
      plant: { select: { siteId: true } },
      reservation: { include: { project: { include: { customer: true } } } },
      mix: { include: { components: true } },
      components: { include: { material: true } },
      trip: { include: { truck: true, driver: true, pump: true, drumReturn: { include: { wasteMemo: { include: { approvedBy: true } } } } } },
      shortageOverrideRequests: { orderBy: { createdAt: "desc" }, take: 1, include: { requestedBy: true } },
    },
  });
  if (!ticket) notFound();

  // Same terminal-state guard every write path already enforces — see
  // production/[id]/page.tsx's own isTerminal for the full reasoning.
  const isTerminal = ticket.status === "COMPLETE" || ticket.status === "CANCELLED";
  const canRequestShortageOverride = await canPerformAction(user.role, "production", "requestShortageOverride");
  const canApproveShortageOverride = await canPerformAction(user.role, "production", "approveShortageOverrideRequest");
  const canRejectShortageOverride = await canPerformAction(user.role, "production", "rejectShortageOverrideRequest");
  const latestOverrideRequest = ticket.shortageOverrideRequests[0]
    ? {
        id: ticket.shortageOverrideRequests[0].id,
        status: ticket.shortageOverrideRequests[0].status as "PENDING" | "APPROVED" | "REJECTED" | "CONSUMED" | "EXPIRED",
        reason: ticket.shortageOverrideRequests[0].reason,
        requestedByName: ticket.shortageOverrideRequests[0].requestedBy.name,
        rejectionNote: ticket.shortageOverrideRequests[0].rejectionNote,
        shortageSnapshot: ticket.shortageOverrideRequests[0].shortageSnapshot as ShortageSnapshotEntry[] | null,
      }
    : null;
  const toleranceByMaterial = new Map(ticket.mix.components.map((c) => [c.materialId, c.tolerancePct]));
  const isPumpDelivery = ticket.reservation.deliveryMethod === "PUMP";

  // Truck/pump scoped to this ticket's own SITE (not just its plant);
  // driver/pump-crew stay company-wide — see the same comment and
  // PL-R5-P2-05 reasoning in production/[id]/page.tsx.
  const [trucksRaw, drivers, pumps, pumpCrew] = ticket.status === "COMPLETE" && !ticket.trip
    ? await Promise.all([
        prisma.truck.findMany({
          where: { status: "ACTIVE", plant: { siteId: ticket.plant.siteId }, trips: { none: { status: { not: "CLOSED" } } } },
          orderBy: { code: "asc" },
          // Each truck's own most recent CLOSED trip — see the same badge
          // in production/[id]/page.tsx and getAvailableReclaimForTruck
          // in src/lib/reclaim.ts.
          include: {
            trips: {
              where: { status: "CLOSED" },
              orderBy: { createdAt: "desc" },
              take: 1,
              select: { drumReturn: { select: { fate: true, consumedAt: true, returnedVolumeM3: true } }, batchTicket: { select: { mixId: true } } },
            },
          },
        }),
        // status: "ACTIVE" — see the same PL-R6-P2-03 comment in
        // production/[id]/page.tsx.
        prisma.employee.findMany({ where: { role: "DRIVER", status: "ACTIVE" }, orderBy: { name: "asc" } }),
        isPumpDelivery
          ? prisma.pump.findMany({ where: { status: "ACTIVE", plant: { siteId: ticket.plant.siteId } }, orderBy: { code: "asc" } })
          : Promise.resolve([]),
        isPumpDelivery
          ? prisma.pumpCrewMember.findMany({ where: { status: "ACTIVE" }, orderBy: { name: "asc" } })
          : Promise.resolve([]),
      ])
    : [[], [], [], []];

  const trucksWithReclaim = trucksRaw.map((t) => {
    const lastReturn = t.trips[0]?.drumReturn;
    const reclaimedVolumeM3 =
      lastReturn && lastReturn.fate === "RECLAIMED" && !lastReturn.consumedAt && t.trips[0]?.batchTicket.mixId === ticket.mixId
        ? lastReturn.returnedVolumeM3
        : null;
    return { ...t, reclaimedVolumeM3 };
  });
  const trucks = rankTrucksForVolume(trucksWithReclaim, ticket.volumeM3);

  const mobileSelect = "w-full rounded-md border border-border bg-bg px-2 py-2 text-sm";
  const truckOptions = trucks.map((t) => ({
    value: t.id,
    label: `${t.code} (${t.drumCapacityM3} m³)${t.recommended ? ` — ${d.bestFit}` : ""}${t.undersized ? ` — ${d.undersized(t.drumCapacityM3, ticket.volumeM3)}` : ""}${t.reclaimedVolumeM3 ? ` — ${d.reclaimedInDrum(t.reclaimedVolumeM3)}` : ""}`,
    defaults: { driverId: t.defaultDriverId ?? "" },
  }));
  const driverOptions = drivers.map((dr) => ({ value: dr.id, label: dr.name }));
  const pumpOptions = pumps.map((p) => {
    const insufficientReach =
      ticket.reservation.minPumpReachM != null && p.reachM != null && p.reachM < ticket.reservation.minPumpReachM;
    return {
      value: p.id,
      label: `${p.code} (${dict.pumpTypes[p.pumpType as keyof typeof dict.pumpTypes] ?? p.pumpType}${p.reachM != null ? ` · ${p.reachM}m` : ""})${insufficientReach ? ` — ${d.pumpReachInsufficient}` : ""}`,
      defaults: { pumpOperatorId: p.defaultOperatorId ?? "", pumpAssistantId: p.defaultAssistantId ?? "" },
    };
  });
  const operatorOptions = pumpCrew.filter((c) => c.role === "OPERATOR").map((c) => ({ value: c.id, label: c.name }));
  const assistantOptions = pumpCrew.filter((c) => c.role === "HELPER").map((c) => ({ value: c.id, label: c.name }));

  return (
    <div className="mx-auto flex min-h-screen max-w-sm flex-col gap-5 bg-bg px-5 py-6">
      <div className="flex items-center justify-between">
        <Link href="/operator" className="text-sm text-ink-muted">
          ← {o.backToList}
        </Link>
        <span
          className={`rounded-full px-2.5 py-1 font-mono text-xs ${
            ticket.status === "COMPLETE" ? "bg-good-soft text-good" : "bg-accent-soft text-accent-strong"
          }`}
        >
          {dict.status[ticket.status as keyof typeof dict.status] ?? ticket.status}
        </span>
      </div>

      <div>
        <h1 className="font-display text-lg font-semibold" dir="ltr">{ticket.ticketNumber}</h1>
        <p className="text-sm text-ink-muted">
          {ticket.reservation.project.name} · {ticket.reservation.reservationNumber} · {ticket.mix.code} ({ticket.mix.grade}) · {ticket.volumeM3} m³
        </p>
        {ticket.reservation.siteLocation && (
          <p className="text-xs text-ink-muted">{ticket.reservation.siteLocation}</p>
        )}
      </div>

      <OfflineSyncBanner
        labels={{
          offline: o.offlineBanner,
          pendingOne: o.offlinePendingOne,
          pendingOther: o.offlinePendingOther,
          synced: o.offlineSynced,
          rejectedOne: o.offlineRejectedOne,
          rejectedOther: o.offlineRejectedOther,
          fieldLabels: o.offlineRejectedField,
          reasonLabels: o.offlineRejectedReasons,
          dismiss: o.offlineRejectedDismiss,
          storageError: o.offlineStorageError,
          corruptionRecovered: o.offlineCorruptionRecovered,
          foreignPending: o.offlineForeignPending,
          foreignAdopt: o.offlineForeignAdopt,
          foreignAdoptFailed: o.offlineForeignAdoptFailed,
        }}
        queueIdentity={queueIdentity}
      />

      <RecordActualsForm
        ticketId={ticket.id}
        messages={{ staleConflict: d.recordActualsStaleConflict, terminal: d.recordActualsTerminal, notFound: d.recordActualsNotFound, genericFailure: d.recordActualsGenericFailure }}
        className="flex flex-col gap-3 rounded-xl border border-border bg-surface p-4 shadow-sm"
      >
        <h2 className="font-display text-base font-semibold">{d.targetVsActual}</h2>
        {ticket.components.map((c) => {
          const tolerance = toleranceByMaterial.get(c.materialId) ?? 2;
          const deviationPct =
            c.actualMassKg != null ? ((c.actualMassKg - c.targetMassKg) / c.targetMassKg) * 100 : null;
          const outOfTolerance = deviationPct != null && Math.abs(deviationPct) > tolerance;
          return (
            <div key={c.id} className="border-t border-border pt-3 first:border-t-0 first:pt-0">
              <div className="flex items-center justify-between">
                <span className="text-sm font-medium">{c.material.name}</span>
                <span className="font-mono text-xs text-ink-muted" dir="ltr">{c.targetMassKg.toFixed(1)} kg</span>
              </div>
              <div className="mt-2 flex items-center gap-2" dir="ltr">
                {/* PL-R9-P1-03: field-specific version, not the old shared
                    c.version — see schema.prisma's actualVersion/
                    moistureVersion comment. The hidden input carries the
                    same value for the bulk "Save readings" submit this
                    component list is wrapped in. */}
                <input type="hidden" name={`actualVersion_${c.id}`} value={c.actualVersion} />
                <AutoSaveField
                  action={recordActualField}
                  offlineQueueKind="recordActualField"
                  queueIdentity={queueIdentity}
                  hiddenFields={{ batchTicketId: ticket.id, componentId: c.id, field: "actual" }}
                  valueField="value"
                  name={`actual_${c.id}`}
                  step="0.1"
                  placeholder={d.col.actual}
                  defaultValue={c.actualMassKg ?? undefined}
                  disabled={ticket.status === "COMPLETE"}
                  className="w-full rounded-md border border-border bg-bg px-2 py-2 font-mono text-sm disabled:opacity-60"
                  rejectedLabel={d.autosaveRejected}
                  storageErrorLabel={d.autosaveStorageError}
                  defaultVersion={c.actualVersion}
                />
                {AGGREGATE_TYPES.has(c.material.type) && (
                  <>
                    <input type="hidden" name={`moistureVersion_${c.id}`} value={c.moistureVersion} />
                    <AutoSaveField
                      action={recordActualField}
                      offlineQueueKind="recordActualField"
                      queueIdentity={queueIdentity}
                      hiddenFields={{ batchTicketId: ticket.id, componentId: c.id, field: "moisture" }}
                      valueField="value"
                      name={`moisture_${c.id}`}
                      step="0.1"
                      placeholder={d.col.moisture}
                      defaultValue={c.moisturePct ?? undefined}
                      disabled={ticket.status === "COMPLETE"}
                      className="w-24 shrink-0 rounded-md border border-border bg-bg px-2 py-2 font-mono text-sm disabled:opacity-60"
                      rejectedLabel={d.autosaveRejected}
                      storageErrorLabel={d.autosaveStorageError}
                      defaultVersion={c.moistureVersion}
                    />
                  </>
                )}
              </div>
              {deviationPct != null && (
                <div className={`mt-1 font-mono text-xs ${outOfTolerance ? "text-critical" : "text-good"}`} dir="ltr">
                  {deviationPct > 0 ? "+" : ""}
                  {deviationPct.toFixed(1)}%
                </div>
              )}
            </div>
          );
        })}
        {!isTerminal && (
          <button type="submit" className="mt-1 rounded-md border border-border py-2.5 text-sm font-medium">
            {d.saveReadings}
          </button>
        )}
      </RecordActualsForm>

      {!isTerminal && (
        <CompleteBatchForm
          ticketId={ticket.id}
          messages={{
            completeTitle: d.completeTitle,
            completeIntro: d.completeIntro,
            completeButton: d.completeButton,
            errorInsufficientStock: d.errorInsufficientStock,
            errorStorageNotConfigured: d.errorStorageNotConfigured,
            errorAlreadyCompleted: d.errorAlreadyCompleted,
            errorInvalidState: d.errorInvalidState,
            errorConcurrentConflict: d.errorConcurrentConflict,
            errorNotFound: d.errorNotFound,
          }}
          cardClassName="flex flex-col gap-2 rounded-xl border border-border bg-surface p-4 shadow-sm"
          titleClassName="font-display text-base font-semibold"
          introClassName="text-xs text-ink-muted"
          buttonClassName="rounded-md bg-accent py-2.5 text-sm font-medium text-white"
        />
      )}

      {(canRequestShortageOverride || canApproveShortageOverride || canRejectShortageOverride || latestOverrideRequest) && (
        <ShortageOverridePanel
          ticketId={ticket.id}
          latestRequest={latestOverrideRequest}
          canRequest={canRequestShortageOverride}
          canApprove={canApproveShortageOverride}
          canReject={canRejectShortageOverride}
          isTerminal={isTerminal}
          messages={{
            title: d.shortageOverride.title,
            noneHint: d.shortageOverride.noneHint,
            requestedByPrefix: d.shortageOverride.requestedByPrefix,
            pendingStatus: d.shortageOverride.pendingStatus,
            approvedStatus: d.shortageOverride.approvedStatus,
            rejectedStatus: d.shortageOverride.rejectedStatus,
            consumedStatus: d.shortageOverride.consumedStatus,
            expiredStatus: d.shortageOverride.expiredStatus,
            snapshotMaterial: d.shortageOverride.snapshotMaterial,
            snapshotRequired: d.shortageOverride.snapshotRequired,
            snapshotAvailable: d.shortageOverride.snapshotAvailable,
            snapshotShortage: d.shortageOverride.snapshotShortage,
            requestLabel: d.shortageOverride.requestLabel,
            requestPlaceholder: d.shortageOverride.requestPlaceholder,
            requestButton: d.shortageOverride.requestButton,
            approveButton: d.shortageOverride.approveButton,
            rejectButton: d.shortageOverride.rejectButton,
            rejectionNoteLabel: d.shortageOverride.rejectionNoteLabel,
            rejectionNotePlaceholder: d.shortageOverride.rejectionNotePlaceholder,
            errorNotFound: d.shortageOverride.errorNotFound,
            errorTicketTerminal: d.shortageOverride.errorTicketTerminal,
            errorAlreadyPending: d.shortageOverride.errorAlreadyPending,
            errorAlreadyApproved: d.shortageOverride.errorAlreadyApproved,
            errorNoShortage: d.shortageOverride.errorNoShortage,
            errorStorageNotConfigured: d.shortageOverride.errorStorageNotConfigured,
            errorNotPending: d.shortageOverride.errorNotPending,
          }}
          cardClassName="flex flex-col gap-2 rounded-xl border border-border bg-surface p-4 shadow-sm"
          titleClassName="font-display text-base font-semibold"
          hintClassName="text-xs text-ink-muted"
          labelClassName="block text-xs font-medium text-ink-muted mb-1"
          inputClassName="w-full rounded-md border border-border bg-surface px-3 py-2 text-sm"
          buttonClassName="rounded-md bg-accent py-2.5 text-sm font-medium text-white"
          secondaryButtonClassName="rounded-md bg-accent py-2.5 text-sm font-medium text-white"
        />
      )}

      {ticket.status === "COMPLETE" && !ticket.trip && (
        <StartTripForm
          batchTicketId={ticket.id}
          returnTarget="operator"
          isPumpDelivery={isPumpDelivery}
          trucksAvailable={trucks.length > 0}
          truckOptions={truckOptions}
          driverOptions={driverOptions}
          pumpOptions={pumpOptions}
          operatorOptions={operatorOptions}
          assistantOptions={assistantOptions}
          messages={{
            assignTitle: d.assignTitle,
            truck: d.truck,
            selectTruck: d.selectTruck,
            driver: d.driver,
            selectDriver: d.selectDriver,
            noTrucksAvailable: d.noTrucksAvailable,
            pumpDeliveryNote: d.pumpDeliveryNote,
            pump: d.pump,
            selectPump: dict.field.selectPump,
            pumpOperator: d.pumpOperator,
            selectPumpOperator: d.selectPumpOperator,
            pumpAssistant: d.pumpAssistant,
            none: dict.field.none,
            minPumpReachNote: ticket.reservation.minPumpReachM == null ? null : d.minPumpReachNote(ticket.reservation.minPumpReachM),
            startTripButton: d.startTrip,
            errors: d.dispatchErrors,
          }}
          cardClassName="flex flex-col gap-3 rounded-xl border border-border bg-surface p-4 shadow-sm"
          titleClassName="font-display text-base font-semibold"
          selectClassName={mobileSelect}
          buttonClassName="rounded-md bg-accent py-2.5 text-sm font-medium text-white"
        />
      )}

      {ticket.trip && (
        <div className="flex flex-col gap-1 rounded-xl border border-border bg-surface p-4 shadow-sm">
          <h2 className="font-display text-base font-semibold">
            {d.tripStatus(dict.status[ticket.trip.status as keyof typeof dict.status] ?? ticket.trip.status)}
          </h2>
          <p className="text-sm text-ink-muted">
            {ticket.trip.truck.code} · {ticket.trip.driver.name}
            {ticket.trip.pump && (
              <>
                {" · "}
                {ticket.trip.pump.code}
                {ticket.trip.pumpOperatorName && ` · ${ticket.trip.pumpOperatorName}`}
              </>
            )}
          </p>
          {ticket.trip.reclaimedVolumeM3 != null && (
            <p className="mt-1 inline-block rounded-full bg-good-soft px-2.5 py-0.5 font-mono text-xs text-good">{d.reclaimedNote(ticket.trip.reclaimedVolumeM3)}</p>
          )}
          {ticket.trip.drumReturn?.reasonCode === "QUALITY_REJECTED" && (
            <div className="mt-1 flex flex-wrap gap-1">
              <span className="inline-block rounded-full bg-critical-soft px-2.5 py-0.5 font-mono text-xs text-critical">
                {d.wasteNote(ticket.trip.drumReturn.returnedVolumeM3)}
              </span>
              <span className={`inline-block rounded-full px-2.5 py-0.5 font-mono text-xs ${ticket.trip.drumReturn.wasteMemo?.status === "APPROVED" ? "bg-good-soft text-good" : "bg-warn-soft text-warn"}`}>
                {ticket.trip.drumReturn.wasteMemo?.status === "APPROVED" && ticket.trip.drumReturn.wasteMemo.approvedBy
                  ? d.wasteMemoApproved(ticket.trip.drumReturn.wasteMemo.approvedBy.name, new Date(ticket.trip.drumReturn.wasteMemo.approvedAt!).toLocaleDateString())
                  : d.wasteMemoPending}
              </span>
            </div>
          )}
          {ticket.trip.drumReturn?.wasteMemo?.approvalNote && (
            <p className="text-xs text-ink-muted">{d.wasteMemoNote}: {ticket.trip.drumReturn.wasteMemo.approvalNote}</p>
          )}
        </div>
      )}
    </div>
  );
}
