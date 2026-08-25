import { notFound } from "next/navigation";
import Link from "next/link";
import { prisma } from "@/lib/prisma";
import { ui } from "@/lib/ui";
import { requirePageAccess } from "@/lib/session";
import { getDictionary } from "@/lib/i18n";
import {
  recordActuals,
  recordActualField,
  completeBatch,
  startTrip,
  updateTripAssignment,
  addTicketComponent,
  deleteTicketComponent,
  deleteBatchTicket,
} from "../actions";
import { rankTrucksForVolume } from "@/lib/dispatch";
import { AutoSaveField } from "@/components/AutoSaveField";
import { EquipmentAssignPicker } from "@/components/EquipmentAssignPicker";

const AGGREGATE_TYPES = new Set(["SAND", "COARSE_AGGREGATE"]);

export default async function BatchTicketPage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<{ editTrip?: string }>;
}) {
  await requirePageAccess("production");
  const { id } = await params;
  const { editTrip } = await searchParams;
  const { dict } = await getDictionary();
  const m = dict.modules.production;
  const d = m.detail;

  const [ticket, materials] = await Promise.all([
    prisma.batchTicket.findUnique({
      where: { id },
      include: {
        reservation: { include: { project: { include: { customer: true } } } },
        mix: { include: { components: true } },
        components: { include: { material: true } },
        trip: { include: { truck: true, driver: true, pump: true } },
      },
    }),
    prisma.material.findMany({ orderBy: { name: "asc" } }),
  ]);
  if (!ticket) notFound();

  const canEditComponents = ticket.status !== "COMPLETE";
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
          // A truck already on an open trip elsewhere can't be assigned
          // here too — matches the guarantee the Fleet page's own intro
          // text makes ("can't be double-booked from Production"). When
          // editing an existing trip, that trip's own truck doesn't count
          // as "busy" against itself.
          where: {
            plantId: ticket.plantId,
            status: "ACTIVE",
            trips: { none: { status: { not: "CLOSED" }, ...(ticket.trip ? { id: { not: ticket.trip.id } } : {}) } },
          },
          orderBy: { code: "asc" },
        }),
        prisma.employee.findMany({ where: { plantId: ticket.plantId, role: "DRIVER" }, orderBy: { name: "asc" } }),
        isPumpDelivery
          ? prisma.pump.findMany({ where: { plantId: ticket.plantId, status: "ACTIVE" }, orderBy: { code: "asc" } })
          : Promise.resolve([]),
        isPumpDelivery
          ? prisma.pumpCrewMember.findMany({ where: { plantId: ticket.plantId, status: "ACTIVE" }, orderBy: { name: "asc" } })
          : Promise.resolve([]),
      ])
    : [[], [], [], []];

  const trucks = rankTrucksForVolume(trucksRaw, ticket.volumeM3);

  // Selecting the equipment pre-fills its registered default person(s) —
  // still freely editable afterward — via EquipmentAssignPicker.
  const truckOptions = trucks.map((t) => ({
    value: t.id,
    label: `${t.code} (${t.drumCapacityM3} m³)${t.recommended ? ` — ${d.bestFit}` : ""}${t.undersized ? ` — ${d.undersized(t.drumCapacityM3, ticket.volumeM3)}` : ""}`,
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

      <form action={recordActuals} className={ui.card}>
        <input type="hidden" name="batchTicketId" value={ticket.id} />
        <h2 className="mb-3 font-display text-lg font-semibold">{d.targetVsActual}</h2>
        {canEditComponents &&
          ticket.components.map((c) => (
            <form key={c.id} id={`delcomp-${c.id}`} action={deleteTicketComponent} className="hidden">
              <input type="hidden" name="id" value={c.id} />
              <input type="hidden" name="batchTicketId" value={ticket.id} />
            </form>
          ))}
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
        {ticket.status !== "COMPLETE" && (
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

      {ticket.status !== "COMPLETE" && (
        <form action={completeBatch} className={`${ui.card} flex items-center justify-between`}>
          <input type="hidden" name="batchTicketId" value={ticket.id} />
          <div>
            <h2 className="font-display text-lg font-semibold">{d.completeTitle}</h2>
            <p className="text-sm text-ink-muted">{d.completeIntro}</p>
          </div>
          <button type="submit" className={ui.button}>
            {d.completeButton}
          </button>
        </form>
      )}

      {ticket.status === "COMPLETE" && !ticket.trip && (
        <form action={startTrip} className={`${ui.card} flex flex-col gap-3`}>
          <input type="hidden" name="batchTicketId" value={ticket.id} />
          <h2 className="font-display text-lg font-semibold">{d.assignTitle}</h2>
          <div className="grid grid-cols-2 gap-3">
            <EquipmentAssignPicker
              equipment={{ name: "truckId", label: d.truck, placeholder: d.selectTruck, required: true, className: ui.select, options: truckOptions }}
              dependents={[{ key: "driverId", name: "driverId", label: d.driver, placeholder: d.selectDriver, required: true, className: ui.select, options: driverOptions }]}
            />
          </div>
          {trucks.length === 0 && <p className="text-xs text-warn">{d.noTrucksAvailable}</p>}
          {isPumpDelivery && (
            <div className="border-t border-border pt-3">
              <p className="mb-2 text-xs text-ink-muted">{d.pumpDeliveryNote}</p>
              <div className="grid grid-cols-3 gap-3">
                <EquipmentAssignPicker
                  equipment={{ name: "pumpId", label: d.pump, placeholder: dict.field.selectPump, required: true, className: ui.select, options: pumpOptions }}
                  dependents={[
                    { key: "pumpOperatorId", name: "pumpOperatorId", label: d.pumpOperator, placeholder: d.selectPumpOperator, required: true, className: ui.select, options: operatorOptions },
                    { key: "pumpAssistantId", name: "pumpAssistantId", label: d.pumpAssistant, placeholder: dict.field.none, className: ui.select, options: assistantOptions },
                  ]}
                />
              </div>
              {ticket.reservation.minPumpReachM != null && (
                <p className="mt-1 text-xs text-ink-muted">{d.minPumpReachNote(ticket.reservation.minPumpReachM)}</p>
              )}
            </div>
          )}
          <button type="submit" className={`${ui.button} self-start`}>
            {d.startTrip}
          </button>
        </form>
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

      {!ticket.trip && (
        <form action={deleteBatchTicket} className={`${ui.card} flex items-center justify-between`}>
          <input type="hidden" name="id" value={ticket.id} />
          <div>
            <h2 className="font-display text-lg font-semibold">{d.deleteTicket}</h2>
            <p className="text-sm text-ink-muted">{d.deleteTicketHint}</p>
          </div>
          <button type="submit" className="rounded-md border border-critical px-4 py-2 text-sm font-medium text-critical hover:bg-critical-soft">
            {d.deleteTicket}
          </button>
        </form>
      )}

      {showEditTripForm && ticket.trip && (
        <form action={updateTripAssignment} className={`${ui.card} flex flex-col gap-3`}>
          <input type="hidden" name="tripId" value={ticket.trip.id} />
          <h2 className="font-display text-lg font-semibold">{d.editAssignTitle}</h2>
          <div className="grid grid-cols-2 gap-3">
            <EquipmentAssignPicker
              equipment={{ name: "truckId", label: d.truck, placeholder: d.selectTruck, required: true, className: ui.select, defaultValue: ticket.trip.truckId, options: truckOptions }}
              dependents={[{ key: "driverId", name: "driverId", label: d.driver, placeholder: d.selectDriver, required: true, className: ui.select, defaultValue: ticket.trip.driverId, options: driverOptions }]}
            />
          </div>
          {isPumpDelivery && (
            <div className="border-t border-border pt-3">
              <div className="grid grid-cols-3 gap-3">
                <EquipmentAssignPicker
                  equipment={{ name: "pumpId", label: d.pump, placeholder: dict.field.selectPump, required: true, className: ui.select, defaultValue: ticket.trip.pumpId ?? "", options: pumpOptions }}
                  dependents={[
                    { key: "pumpOperatorId", name: "pumpOperatorId", label: d.pumpOperator, placeholder: d.selectPumpOperator, required: true, className: ui.select, defaultValue: ticket.trip.pumpOperatorId ?? "", options: operatorOptions },
                    { key: "pumpAssistantId", name: "pumpAssistantId", label: d.pumpAssistant, placeholder: dict.field.none, className: ui.select, defaultValue: ticket.trip.pumpAssistantId ?? "", options: assistantOptions },
                  ]}
                />
              </div>
            </div>
          )}
          <div className="flex gap-3">
            <button type="submit" className={ui.button}>{dict.field.save}</button>
            <Link href={`/production/${ticket.id}`} className="rounded-md border border-border px-4 py-2 text-sm hover:bg-surface-alt">
              {dict.field.cancel}
            </Link>
          </div>
        </form>
      )}
    </div>
  );
}
