import { notFound } from "next/navigation";
import Link from "next/link";
import { prisma } from "@/lib/prisma";
import { ui } from "@/lib/ui";
import { requirePageAccess } from "@/lib/session";
import { getDictionary } from "@/lib/i18n";
import { recordActuals, recordActualField, completeBatch, startTrip, updateTripAssignment } from "../actions";
import { rankTrucksForVolume } from "@/lib/dispatch";
import { AutoSaveField } from "@/components/AutoSaveField";

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

  const ticket = await prisma.batchTicket.findUnique({
    where: { id },
    include: {
      reservation: { include: { project: { include: { customer: true, plant: true } } } },
      mix: { include: { components: true } },
      components: { include: { material: true } },
      trip: { include: { truck: true, driver: true, pump: true } },
    },
  });
  if (!ticket) notFound();

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
        <table className={ui.table}>
          <thead>
            <tr>
              <th className={ui.th}>{d.col.material}</th>
              <th className={ui.th}>{d.col.target}</th>
              <th className={ui.th}>{d.col.actual}</th>
              <th className={ui.th}>{d.col.moisture}</th>
              <th className={ui.th}>{d.col.deviation}</th>
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
            <div>
              <label className={ui.label}>{d.truck}</label>
              <select name="truckId" required className={ui.select}>
                <option value="">{d.selectTruck}</option>
                {trucks.map((t) => (
                  <option key={t.id} value={t.id}>
                    {t.code} ({t.drumCapacityM3} m³)
                    {t.recommended ? ` — ${d.bestFit}` : ""}
                    {t.undersized ? ` — ${d.undersized(t.drumCapacityM3, ticket.volumeM3)}` : ""}
                  </option>
                ))}
              </select>
              {trucks.length === 0 && <p className="mt-1 text-xs text-warn">{d.noTrucksAvailable}</p>}
            </div>
            <div>
              <label className={ui.label}>{d.driver}</label>
              <select name="driverId" required className={ui.select}>
                <option value="">{d.selectDriver}</option>
                {drivers.map((dr) => (
                  <option key={dr.id} value={dr.id}>
                    {dr.name}
                  </option>
                ))}
              </select>
            </div>
          </div>
          {isPumpDelivery && (
            <div className="border-t border-border pt-3">
              <p className="mb-2 text-xs text-ink-muted">{d.pumpDeliveryNote}</p>
              <div className="grid grid-cols-3 gap-3">
                <div>
                  <label className={ui.label}>{d.pump}</label>
                  <select name="pumpId" required className={ui.select}>
                    <option value="">{dict.field.selectPump}</option>
                    {pumps.map((p) => {
                      const insufficientReach =
                        ticket.reservation.minPumpReachM != null &&
                        p.reachM != null &&
                        p.reachM < ticket.reservation.minPumpReachM;
                      return (
                        <option key={p.id} value={p.id}>
                          {p.code} ({dict.pumpTypes[p.pumpType as keyof typeof dict.pumpTypes] ?? p.pumpType}
                          {p.reachM != null ? ` · ${p.reachM}m` : ""})
                          {insufficientReach ? ` — ${d.pumpReachInsufficient}` : ""}
                        </option>
                      );
                    })}
                  </select>
                  {ticket.reservation.minPumpReachM != null && (
                    <p className="mt-1 text-xs text-ink-muted">{d.minPumpReachNote(ticket.reservation.minPumpReachM)}</p>
                  )}
                </div>
                <div>
                  <label className={ui.label}>{d.pumpOperator}</label>
                  <select name="pumpOperatorId" required className={ui.select}>
                    <option value="">{d.selectPumpOperator}</option>
                    {pumpCrew.filter((c) => c.role === "OPERATOR").map((c) => (
                      <option key={c.id} value={c.id}>{c.name}</option>
                    ))}
                  </select>
                </div>
                <div>
                  <label className={ui.label}>{d.pumpAssistant}</label>
                  <select name="pumpAssistantId" className={ui.select}>
                    <option value="">{dict.field.none}</option>
                    {pumpCrew.filter((c) => c.role === "HELPER").map((c) => (
                      <option key={c.id} value={c.id}>{c.name}</option>
                    ))}
                  </select>
                </div>
              </div>
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
            <Link href="/trips" className="rounded-md border border-border px-4 py-2 text-sm hover:bg-surface-alt">
              {d.goToTrips}
            </Link>
          </div>
        </div>
      )}

      {showEditTripForm && ticket.trip && (
        <form action={updateTripAssignment} className={`${ui.card} flex flex-col gap-3`}>
          <input type="hidden" name="tripId" value={ticket.trip.id} />
          <h2 className="font-display text-lg font-semibold">{d.editAssignTitle}</h2>
          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className={ui.label}>{d.truck}</label>
              <select name="truckId" required defaultValue={ticket.trip.truckId} className={ui.select}>
                <option value="">{d.selectTruck}</option>
                {trucks.map((t) => (
                  <option key={t.id} value={t.id}>
                    {t.code} ({t.drumCapacityM3} m³)
                  </option>
                ))}
              </select>
            </div>
            <div>
              <label className={ui.label}>{d.driver}</label>
              <select name="driverId" required defaultValue={ticket.trip.driverId} className={ui.select}>
                <option value="">{d.selectDriver}</option>
                {drivers.map((dr) => (
                  <option key={dr.id} value={dr.id}>
                    {dr.name}
                  </option>
                ))}
              </select>
            </div>
          </div>
          {isPumpDelivery && (
            <div className="border-t border-border pt-3">
              <div className="grid grid-cols-3 gap-3">
                <div>
                  <label className={ui.label}>{d.pump}</label>
                  <select name="pumpId" required defaultValue={ticket.trip.pumpId ?? ""} className={ui.select}>
                    <option value="">{dict.field.selectPump}</option>
                    {pumps.map((p) => (
                      <option key={p.id} value={p.id}>
                        {p.code} ({dict.pumpTypes[p.pumpType as keyof typeof dict.pumpTypes] ?? p.pumpType}
                        {p.reachM != null ? ` · ${p.reachM}m` : ""})
                      </option>
                    ))}
                  </select>
                </div>
                <div>
                  <label className={ui.label}>{d.pumpOperator}</label>
                  <select name="pumpOperatorId" required defaultValue={ticket.trip.pumpOperatorId ?? ""} className={ui.select}>
                    <option value="">{d.selectPumpOperator}</option>
                    {pumpCrew.filter((c) => c.role === "OPERATOR").map((c) => (
                      <option key={c.id} value={c.id}>{c.name}</option>
                    ))}
                  </select>
                </div>
                <div>
                  <label className={ui.label}>{d.pumpAssistant}</label>
                  <select name="pumpAssistantId" defaultValue={ticket.trip.pumpAssistantId ?? ""} className={ui.select}>
                    <option value="">{dict.field.none}</option>
                    {pumpCrew.filter((c) => c.role === "HELPER").map((c) => (
                      <option key={c.id} value={c.id}>{c.name}</option>
                    ))}
                  </select>
                </div>
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
