import { notFound } from "next/navigation";
import Link from "next/link";
import { prisma } from "@/lib/prisma";
import { ui } from "@/lib/ui";
import { getCurrentUser, requirePageAccess } from "@/lib/session";
import { canPerformAction } from "@/lib/permissions";
import { effectiveSiteId, plantScopeWhere } from "@/lib/siteScope";
import { getDictionary } from "@/lib/i18n";
import {
  recordActuals,
  recordActualField,
  addTicketComponent,
  deleteTicketComponent,
} from "../actions";
import { rankTrucksForVolume } from "@/lib/dispatch";
import { AutoSaveField } from "@/components/AutoSaveField";
import { CompleteBatchForm } from "@/components/CompleteBatchForm";
import { ReverseBatchForm } from "@/components/ReverseBatchForm";
import { ShortageOverridePanel, type ShortageSnapshotEntry } from "@/components/ShortageOverridePanel";
import { CancelBatchTicketForm } from "@/components/CancelBatchTicketForm";
import { StartTripForm } from "@/components/StartTripForm";
import { UpdateTripAssignmentForm } from "@/components/UpdateTripAssignmentForm";

const AGGREGATE_TYPES = new Set(["SAND", "COARSE_AGGREGATE"]);

export default async function BatchTicketPage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<{ editTrip?: string }>;
}) {
  await requirePageAccess("production");
  const user = await getCurrentUser();
  const canReverseBatch = !!user && (await canPerformAction(user.role, "production", "reverseBatch"));
  const canRequestShortageOverride = !!user && (await canPerformAction(user.role, "production", "requestShortageOverride"));
  const canApproveShortageOverride = !!user && (await canPerformAction(user.role, "production", "approveShortageOverrideRequest"));
  const canRejectShortageOverride = !!user && (await canPerformAction(user.role, "production", "rejectShortageOverrideRequest"));
  const { id } = await params;
  const { editTrip } = await searchParams;
  const { dict } = await getDictionary();
  const m = dict.modules.production;
  const d = m.detail;

  // PL-R5-P1-03, fifth production-lifecycle review: this loader used to
  // fetch the ticket by id alone — module access was checked, but not
  // whether this SPECIFIC ticket belongs to the acting user's own site,
  // so a plant-scoped user who knew or guessed another site's ticket id
  // could still read its full detail (customer, project, trip, returns,
  // shortage overrides). findFirst + plantScopeWhere folds that same
  // scope check the write actions already re-check into the read itself
  // — a cross-site id now behaves exactly like a nonexistent one.
  const allowedSiteId = effectiveSiteId(user);
  const [ticket, materials] = await Promise.all([
    prisma.batchTicket.findFirst({
      where: { id, ...plantScopeWhere(allowedSiteId) },
      include: {
        plant: { select: { siteId: true } },
        reservation: { include: { project: { include: { customer: true } } } },
        mix: { include: { components: true } },
        components: { include: { material: true } },
        trip: { include: { truck: true, driver: true, pump: true, drumReturn: { include: { wasteMemo: { include: { approvedBy: true } } } } } },
        shortageOverrideRequests: { orderBy: { createdAt: "desc" }, take: 1, include: { requestedBy: true } },
      },
    }),
    prisma.material.findMany({ orderBy: { name: "asc" } }),
  ]);
  if (!ticket) notFound();

  // Matches the domain-layer guard every write path already enforces
  // (recordActuals/recordActualField/addTicketComponent/
  // deleteTicketComponent/completeBatchTicket all reject both COMPLETE
  // and CANCELLED) — the UI used to only hide these for COMPLETE, so a
  // CANCELLED ticket (nothing sets this today, but the schema and every
  // domain guard already treat it as terminal) would still show a
  // weighing/completion form that could only ever fail.
  const isTerminal = ticket.status === "COMPLETE" || ticket.status === "CANCELLED";
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
  const canEditComponents = !isTerminal;
  const componentMaterialIds = new Set(ticket.components.map((c) => c.materialId));
  const addableMaterials = materials.filter((mt) => !componentMaterialIds.has(mt.id));

  const toleranceByMaterial = new Map(ticket.mix.components.map((c) => [c.materialId, c.tolerancePct]));
  const isPumpDelivery = ticket.reservation.deliveryMethod === "PUMP";
  // A trip's truck/driver/pump crew is only correctable up until it leaves
  // the yard — same boundary updateTripAssignment enforces server-side.
  const canEditTrip = ticket.trip?.status === "LOADING";
  const showAssignForm = ticket.status === "COMPLETE" && !ticket.trip;
  const showEditTripForm = canEditTrip && editTrip === "1";

  const [trucksRaw, drivers, pumps, pumpCrew] = showAssignForm || showEditTripForm
    ? await Promise.all([
        prisma.truck.findMany({
          // Scoped to this ticket's own SITE, not its specific plant — a
          // truck commonly works more than one plant, so whoever is
          // dispatching can still pull in any truck registered at ANY
          // plant sharing this ticket's site, not just the one nominally
          // registered here. But never a truck from a DIFFERENT site:
          // claimTripResources' own TRUCK_OUT_OF_SCOPE check has always
          // enforced exactly that boundary — this picker used to offer
          // company-wide choices the domain guard would then always
          // refuse for a cross-site pick (PL-R5-P2-05, fifth production-
          // lifecycle review). A truck already on an open trip elsewhere
          // still can't be assigned here too — matches the guarantee the
          // Fleet page's own intro text makes ("can't be double-booked
          // from Production"). When editing an existing trip, that trip's
          // own truck doesn't count as "busy" against itself.
          where: {
            status: "ACTIVE",
            plant: { siteId: ticket.plant.siteId },
            trips: { none: { status: { not: "CLOSED" }, ...(ticket.trip ? { id: { not: ticket.trip.id } } : {}) } },
          },
          orderBy: { code: "asc" },
          // Each truck's own most recent CLOSED trip — used below to tell
          // whether it's still carrying an unconsumed RECLAIMED load for
          // this same mix (see getAvailableReclaimForTruck in
          // src/lib/reclaim.ts, which startTrip re-checks server-side;
          // this is just the picker's own informational badge).
          include: {
            trips: {
              where: { status: "CLOSED" },
              orderBy: { createdAt: "desc" },
              take: 1,
              select: { drumReturn: { select: { fate: true, consumedAt: true, returnedVolumeM3: true } }, batchTicket: { select: { mixId: true } } },
            },
          },
        }),
        // Drivers and pump crew stay company-wide on purpose — unlike
        // truck/pump, claimTripResources never checks either against the
        // ticket's site (PL-R5-P2-05's own finding was specific to truck
        // and pump; drivers and crew genuinely do work across sites).
        // status: "ACTIVE" filters the same way trucks/pumps already do
        // above (PL-R6-P2-03, sixth production-lifecycle review) —
        // claimTripResources always rejects an inactive driver with
        // DRIVER_INACTIVE, so offering one here was a guaranteed-to-fail
        // choice, the same picker/domain mismatch already fixed for
        // cross-site trucks and pumps.
        prisma.employee.findMany({ where: { role: "DRIVER", status: "ACTIVE" }, orderBy: { name: "asc" } }),
        isPumpDelivery
          ? prisma.pump.findMany({ where: { status: "ACTIVE", plant: { siteId: ticket.plant.siteId } }, orderBy: { code: "asc" } })
          : Promise.resolve([]),
        isPumpDelivery
          ? prisma.pumpCrewMember.findMany({ where: { status: "ACTIVE" }, orderBy: { name: "asc" } })
          : Promise.resolve([]),
      ])
    : [[], [], [], []];

  // Same match rule as getAvailableReclaimForTruck: the truck's last
  // CLOSED trip has to be an unconsumed RECLAIMED return for THIS ticket's
  // own mix — a different mix, an already-consumed return, or no return
  // at all all mean "nothing usable in the drum."
  const trucksWithReclaim = trucksRaw.map((t) => {
    const lastReturn = t.trips[0]?.drumReturn;
    const reclaimedVolumeM3 =
      lastReturn && lastReturn.fate === "RECLAIMED" && !lastReturn.consumedAt && t.trips[0]?.batchTicket.mixId === ticket.mixId
        ? lastReturn.returnedVolumeM3
        : null;
    return { ...t, reclaimedVolumeM3 };
  });
  const trucks = rankTrucksForVolume(trucksWithReclaim, ticket.volumeM3);

  // Selecting the equipment pre-fills its registered default person(s) —
  // still freely editable afterward — via EquipmentAssignPicker.
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
    <div className="flex flex-col gap-8">
      <header className="flex items-start justify-between">
        <div>
          <div className={ui.eyebrow}>{m.eyebrow}</div>
          <h1 className={ui.h1} dir="ltr">{ticket.ticketNumber}</h1>
          <p className={ui.intro}>
            {ticket.reservation.project.name} — {ticket.reservation.project.customer.legalName} · {ticket.mix.code} ·{" "}
            {ticket.volumeM3} m³
          </p>
        </div>
        <span
          className={`${ui.chip} ${
            ticket.status === "COMPLETE" ? "bg-good-soft text-good" : "bg-accent-soft text-accent-strong"
          }`}
        >
          {dict.status[ticket.status as keyof typeof dict.status] ?? ticket.status}
        </span>
      </header>

      {/* Each "remove" button below submits one of these via the HTML5
          form="delcomp-<id>" attribute rather than DOM containment — kept
          as siblings of, not nested inside, the recordActuals form just
          below, since a <form> can never validly contain another <form>
          (nesting them here caused a real hydration mismatch/remount on
          every load). */}
      {canEditComponents &&
        ticket.components.map((c) => (
          <form key={c.id} id={`delcomp-${c.id}`} action={deleteTicketComponent} className="hidden">
            <input type="hidden" name="id" value={c.id} />
            <input type="hidden" name="batchTicketId" value={ticket.id} />
          </form>
        ))}

      <form action={recordActuals} className={ui.card}>
        <input type="hidden" name="batchTicketId" value={ticket.id} />
        <h2 className="mb-3 font-display text-lg font-semibold">{d.targetVsActual}</h2>
        <table className={ui.table}>
          <thead>
            <tr>
              <th className={ui.th}>{d.col.material}</th>
              <th className={ui.th}>{d.col.target}</th>
              <th className={ui.th}>{d.col.actual}</th>
              <th className={ui.th}>{d.col.moisture}</th>
              <th className={ui.th}>{d.col.deviation}</th>
              {canEditComponents && <th className={ui.th}></th>}
            </tr>
          </thead>
          <tbody>
            {ticket.components.map((c) => {
              const tolerance = toleranceByMaterial.get(c.materialId) ?? 2;
              const deviationPct =
                c.actualMassKg != null ? ((c.actualMassKg - c.targetMassKg) / c.targetMassKg) * 100 : null;
              const outOfTolerance = deviationPct != null && Math.abs(deviationPct) > tolerance;
              return (
                <tr key={c.id}>
                  <td className={`${ui.td} font-medium`}>
                    {c.material.name}
                    <div className="text-xs text-ink-muted">{d.toleranceNote(tolerance)}</div>
                  </td>
                  <td className={`${ui.td} font-mono tabular`}>{c.targetMassKg.toFixed(1)}</td>
                  <td className={ui.td}>
                    <AutoSaveField
                      action={recordActualField}
                      hiddenFields={{ batchTicketId: ticket.id, componentId: c.id, field: "actual" }}
                      valueField="value"
                      name={`actual_${c.id}`}
                      step="0.1"
                      defaultValue={c.actualMassKg ?? undefined}
                      disabled={ticket.status === "COMPLETE"}
                      className="w-24 rounded-md border border-border bg-surface px-2 py-1 font-mono text-xs disabled:opacity-60"
                      rejectedLabel={d.autosaveRejected}
                      storageErrorLabel={d.autosaveStorageError}
                      defaultVersion={c.version}
                    />
                  </td>
                  <td className={ui.td}>
                    {AGGREGATE_TYPES.has(c.material.type) ? (
                      <AutoSaveField
                        action={recordActualField}
                        hiddenFields={{ batchTicketId: ticket.id, componentId: c.id, field: "moisture" }}
                        valueField="value"
                        name={`moisture_${c.id}`}
                        step="0.1"
                        defaultValue={c.moisturePct ?? undefined}
                        disabled={ticket.status === "COMPLETE"}
                        className="w-20 rounded-md border border-border bg-surface px-2 py-1 font-mono text-xs disabled:opacity-60"
                        rejectedLabel={d.autosaveRejected}
                      storageErrorLabel={d.autosaveStorageError}
                      defaultVersion={c.version}
                      />
                    ) : (
                      <span className="text-ink-faint">—</span>
                    )}
                  </td>
                  <td className={ui.td}>
                    {deviationPct != null ? (
                      <span className={outOfTolerance ? "font-mono text-xs text-critical" : "font-mono text-xs text-good"}>
                        {deviationPct > 0 ? "+" : ""}
                        {deviationPct.toFixed(1)}%
                      </span>
                    ) : (
                      <span className="text-ink-faint">—</span>
                    )}
                  </td>
                  {canEditComponents && (
                    <td className={ui.td}>
                      <button form={`delcomp-${c.id}`} type="submit" className="text-xs font-medium text-critical hover:underline">
                        {d.removeComponent}
                      </button>
                    </td>
                  )}
                </tr>
              );
            })}
          </tbody>
        </table>
        {!isTerminal && (
          <div className="mt-4 flex gap-3">
            <button type="submit" className="rounded-md border border-border px-4 py-2 text-sm hover:bg-surface-alt">
              {d.saveReadings}
            </button>
          </div>
        )}
        <p className="mt-3 text-xs text-ink-muted">{d.moistureHint}</p>
      </form>

      {canEditComponents && addableMaterials.length > 0 && (
        <form action={addTicketComponent} className={`${ui.card} flex flex-wrap items-end gap-3`}>
          <input type="hidden" name="batchTicketId" value={ticket.id} />
          <h2 className="w-full font-display text-lg font-semibold">{d.addComponentTitle}</h2>
          <div>
            <label className={ui.label}>{d.col.material}</label>
            <select name="materialId" required className={`${ui.select} w-48`}>
              {addableMaterials.map((mt) => (
                <option key={mt.id} value={mt.id}>{mt.name}</option>
              ))}
            </select>
          </div>
          <div>
            <label className={ui.label}>{d.col.target}</label>
            <input name="targetMassKg" type="number" step="0.1" required className={`${ui.input} w-28`} />
          </div>
          <button type="submit" className={ui.button}>{d.addComponentButton}</button>
        </form>
      )}

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
          cardClassName={`${ui.card} flex flex-col gap-3`}
          titleClassName="font-display text-lg font-semibold"
          introClassName="text-sm text-ink-muted"
          buttonClassName={ui.button}
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
          cardClassName={`${ui.card} flex flex-col gap-3`}
          titleClassName="font-display text-lg font-semibold"
          hintClassName="text-sm text-ink-muted"
          labelClassName={ui.label}
          inputClassName={`${ui.input} w-full`}
          buttonClassName={ui.button}
          secondaryButtonClassName={ui.button}
        />
      )}

      {ticket.status === "COMPLETE" && !ticket.trip && (
        <StartTripForm
          batchTicketId={ticket.id}
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
          cardClassName={`${ui.card} flex flex-col gap-3`}
          titleClassName="font-display text-lg font-semibold"
          selectClassName={ui.select}
          buttonClassName={ui.button}
        />
      )}

      {ticket.trip && !showEditTripForm && (
        <div className={`${ui.card} flex items-center justify-between`}>
          <div>
            <h2 className="font-display text-lg font-semibold">{d.tripStatus(dict.status[ticket.trip.status as keyof typeof dict.status] ?? ticket.trip.status)}</h2>
            <p className="text-sm text-ink-muted">
              {ticket.trip.truck.code} · {ticket.trip.driver.name}
              {ticket.trip.pump && (
                <>
                  {" · "}
                  {ticket.trip.pump.code}
                  {ticket.trip.pumpOperatorName && ` · ${ticket.trip.pumpOperatorName}`}
                  {ticket.trip.pumpAssistantName && ` · ${ticket.trip.pumpAssistantName}`}
                </>
              )}
            </p>
            {/* Internal-only note — never printed on the customer-facing
                delivery note, which always shows the full ticket volume. */}
            {ticket.trip.reclaimedVolumeM3 != null && (
              <p className={`${ui.chip} bg-good-soft text-good mt-1 inline-block`}>{d.reclaimedNote(ticket.trip.reclaimedVolumeM3)}</p>
            )}
            {ticket.trip.drumReturn?.reasonCode === "QUALITY_REJECTED" && (
              <div className="mt-1 flex flex-col items-start gap-1">
                <div className="flex flex-wrap items-center gap-1">
                  <span className={`${ui.chip} bg-critical-soft text-critical inline-block`}>{d.wasteNote(ticket.trip.drumReturn.returnedVolumeM3)}</span>
                  <span className={`${ui.chip} ${ticket.trip.drumReturn.wasteMemo?.status === "APPROVED" ? "bg-good-soft text-good" : "bg-warn-soft text-warn"} inline-block`}>
                    {ticket.trip.drumReturn.wasteMemo?.status === "APPROVED" && ticket.trip.drumReturn.wasteMemo.approvedBy
                      ? d.wasteMemoApproved(ticket.trip.drumReturn.wasteMemo.approvedBy.name, new Date(ticket.trip.drumReturn.wasteMemo.approvedAt!).toLocaleDateString())
                      : d.wasteMemoPending}
                  </span>
                </div>
                {ticket.trip.drumReturn.wasteMemo?.approvalNote && (
                  <p className="max-w-md text-xs text-ink-muted">{d.wasteMemoNote}: {ticket.trip.drumReturn.wasteMemo.approvalNote}</p>
                )}
              </div>
            )}
          </div>
          <div className="flex items-center gap-3">
            {canEditTrip && (
              <Link href={`/production/${ticket.id}?editTrip=1`} className="text-sm font-medium text-accent-strong hover:underline">
                {dict.field.edit}
              </Link>
            )}
            <Link href={`/production/${ticket.id}/delivery-note`} className="text-sm font-medium text-accent-strong hover:underline">
              {d.printTicket}
            </Link>
            {ticket.trip.drumReturn?.reasonCode === "QUALITY_REJECTED" && (
              <Link href={`/production/${ticket.id}/delivery-note/supplement`} className="text-sm font-medium text-accent-strong hover:underline">
                {d.printSupplement}
              </Link>
            )}
            <Link href="/trips" className="rounded-md border border-border px-4 py-2 text-sm hover:bg-surface-alt">
              {d.goToTrips}
            </Link>
          </div>
        </div>
      )}

      {ticket.trip && (
        <div className={ui.card}>
          <h2 className="mb-3 font-display text-lg font-semibold">{d.deliveryStagesTitle}</h2>
          <ol className="flex flex-col gap-2">
            {[
              { label: d.stageLoading, at: ticket.trip.batchTime as Date | null },
              { label: d.stageInTransit, at: ticket.trip.departTime },
              { label: d.stageOnSite, at: ticket.trip.arriveTime },
              { label: d.stageDischarging, at: ticket.trip.dischargeStart },
              { label: d.stageClosed, at: ticket.trip.dischargeEnd },
            ].map((stage, i) => {
              const reached = stage.at != null;
              return (
                <li key={i} className="flex items-center gap-3 text-sm">
                  <span className={`h-2 w-2 shrink-0 rounded-full ${reached ? "bg-good" : "bg-border"}`} />
                  <span className={reached ? "font-medium" : "text-ink-muted"}>{stage.label}</span>
                  {reached && (
                    <span className="font-mono text-xs text-ink-muted" dir="ltr">{new Date(stage.at!).toLocaleString()}</span>
                  )}
                </li>
              );
            })}
          </ol>
        </div>
      )}

      {/* The only way to remove a non-terminal, not-yet-dispatched ticket
          now (PL-P1-04, first production-lifecycle review) — a separate
          hard-delete action used to sit here instead whenever the ticket
          had no ShortageOverrideRequest on file, but its own pre-check
          ran outside any transaction or row lock, so a concurrent
          completeBatchTicket claim landing in that gap could post real
          inventory movements and still have the row hard-deleted out from
          under them. cancelBatchTicket already claims the row atomically
          and never posts or reverses inventory, so it now covers this
          entire scope on its own. !isTerminal, not a COMPLETE-only check
          — a CANCELLED ticket was still showing this form otherwise,
          which would just fail with INVALID_STATE on submit (P2-03,
          sixth review). */}
      {!ticket.trip && !isTerminal && (
        <CancelBatchTicketForm
          ticketId={ticket.id}
          messages={{
            title: d.cancelTicket.title,
            hint: d.cancelTicket.hint,
            reasonLabel: d.cancelTicket.reasonLabel,
            reasonPlaceholder: d.cancelTicket.reasonPlaceholder,
            confirmPrompt: d.cancelTicket.confirmPrompt,
            button: d.cancelTicket.button,
            errorInvalidState: d.cancelTicket.errorInvalidState,
            errorNotFound: d.cancelTicket.errorNotFound,
          }}
          cardClassName={`${ui.card} flex flex-col gap-3`}
          titleClassName="font-display text-lg font-semibold"
          hintClassName="text-sm text-ink-muted"
          labelClassName={ui.label}
          inputClassName={`${ui.input} w-full`}
          buttonClassName="self-start rounded-md border border-critical px-4 py-2 text-sm font-medium text-critical hover:bg-critical-soft"
        />
      )}

      {/* ADMIN-only (production.reverseBatch in src/lib/permissions.ts) —
          canReverseBatch below already gates this render, so nothing
          double-checks the permission here beyond what the Server Action
          itself re-verifies. Available whenever the ticket is COMPLETE,
          hasn't already been reversed, and hasn't been dispatched yet
          (reversing a dispatched ticket needs its own flow — see
          reverseBatchTicket's own guard in src/lib/batchCompletion.ts). */}
      {canReverseBatch && ticket.status === "COMPLETE" && !ticket.trip && !ticket.reversedAt && (
        <ReverseBatchForm
          ticketId={ticket.id}
          messages={d.reverse}
          cardClassName={`${ui.card} flex flex-col gap-3 border-warn`}
          titleClassName="font-display text-lg font-semibold"
          hintClassName="text-sm text-ink-muted"
          labelClassName={ui.label}
          inputClassName={`${ui.input} w-full`}
          buttonClassName="self-start rounded-md border border-warn px-4 py-2 text-sm font-medium text-warn hover:bg-warn/10"
        />
      )}

      {showEditTripForm && ticket.trip && (
        <UpdateTripAssignmentForm
          tripId={ticket.trip.id}
          cancelHref={`/production/${ticket.id}`}
          isPumpDelivery={isPumpDelivery}
          defaultTruckId={ticket.trip.truckId}
          defaultDriverId={ticket.trip.driverId}
          defaultPumpId={ticket.trip.pumpId ?? ""}
          defaultPumpOperatorId={ticket.trip.pumpOperatorId ?? ""}
          defaultPumpAssistantId={ticket.trip.pumpAssistantId ?? ""}
          truckOptions={truckOptions}
          driverOptions={driverOptions}
          pumpOptions={pumpOptions}
          operatorOptions={operatorOptions}
          assistantOptions={assistantOptions}
          messages={{
            editAssignTitle: d.editAssignTitle,
            truck: d.truck,
            selectTruck: d.selectTruck,
            driver: d.driver,
            selectDriver: d.selectDriver,
            pump: d.pump,
            selectPump: dict.field.selectPump,
            pumpOperator: d.pumpOperator,
            selectPumpOperator: d.selectPumpOperator,
            pumpAssistant: d.pumpAssistant,
            none: dict.field.none,
            save: dict.field.save,
            cancel: dict.field.cancel,
            errors: d.dispatchErrors,
          }}
          cardClassName={`${ui.card} flex flex-col gap-3`}
          titleClassName="font-display text-lg font-semibold"
          selectClassName={ui.select}
          buttonClassName={ui.button}
          cancelClassName="rounded-md border border-border px-4 py-2 text-sm hover:bg-surface-alt"
        />
      )}
    </div>
  );
}
