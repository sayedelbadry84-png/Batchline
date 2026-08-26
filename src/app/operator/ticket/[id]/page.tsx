import { redirect, notFound } from "next/navigation";
import Link from "next/link";
import { prisma } from "@/lib/prisma";
import { getCurrentUser } from "@/lib/session";
import { getDictionary } from "@/lib/i18n";
import { recordActuals, recordActualField, completeBatch, startTrip } from "@/app/(app)/production/actions";
import { rankTrucksForVolume } from "@/lib/dispatch";
import { AutoSaveField } from "@/components/AutoSaveField";
import { EquipmentAssignPicker } from "@/components/EquipmentAssignPicker";
import { OfflineSyncBanner } from "@/components/OfflineSyncBanner";

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

  const ticket = await prisma.batchTicket.findUnique({
    where: { id },
    include: {
      reservation: { include: { project: { include: { customer: true } } } },
      mix: { include: { components: true } },
      components: { include: { material: true } },
      trip: { include: { truck: true, driver: true, pump: true } },
    },
  });
  if (!ticket) notFound();

  const toleranceByMaterial = new Map(ticket.mix.components.map((c) => [c.materialId, c.tolerancePct]));
  const isPumpDelivery = ticket.reservation.deliveryMethod === "PUMP";

  // Company-wide, not scoped to this ticket's own plant — see the same
  // comment in production/[id]/page.tsx.
  const [trucksRaw, drivers, pumps, pumpCrew] = ticket.status === "COMPLETE" && !ticket.trip
    ? await Promise.all([
        prisma.truck.findMany({
          where: { status: "ACTIVE", trips: { none: { status: { not: "CLOSED" } } } },
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
        prisma.employee.findMany({ where: { role: "DRIVER" }, orderBy: { name: "asc" } }),
        isPumpDelivery
          ? prisma.pump.findMany({ where: { status: "ACTIVE" }, orderBy: { code: "asc" } })
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
          {ticket.reservation.project.name} · {ticket.mix.code} · {ticket.volumeM3} m³
        </p>
      </div>

      <OfflineSyncBanner labels={{ offline: o.offlineBanner, pending: o.offlinePending, synced: o.offlineSynced }} />

      <form action={recordActuals} className="flex flex-col gap-3 rounded-xl border border-border bg-surface p-4 shadow-sm">
        <input type="hidden" name="batchTicketId" value={ticket.id} />
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
                <AutoSaveField
                  action={recordActualField}
                  offlineQueueKind="recordActualField"
                  hiddenFields={{ batchTicketId: ticket.id, componentId: c.id, field: "actual" }}
                  valueField="value"
                  name={`actual_${c.id}`}
                  step="0.1"
                  placeholder={d.col.actual}
                  defaultValue={c.actualMassKg ?? undefined}
                  disabled={ticket.status === "COMPLETE"}
                  className="w-full rounded-md border border-border bg-bg px-2 py-2 font-mono text-sm disabled:opacity-60"
                />
                {AGGREGATE_TYPES.has(c.material.type) && (
                  <AutoSaveField
                    action={recordActualField}
                    offlineQueueKind="recordActualField"
                    hiddenFields={{ batchTicketId: ticket.id, componentId: c.id, field: "moisture" }}
                    valueField="value"
                    name={`moisture_${c.id}`}
                    step="0.1"
                    placeholder={d.col.moisture}
                    defaultValue={c.moisturePct ?? undefined}
                    disabled={ticket.status === "COMPLETE"}
                    className="w-24 shrink-0 rounded-md border border-border bg-bg px-2 py-2 font-mono text-sm disabled:opacity-60"
                  />
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
        {ticket.status !== "COMPLETE" && (
          <button type="submit" className="mt-1 rounded-md border border-border py-2.5 text-sm font-medium">
            {d.saveReadings}
          </button>
        )}
      </form>

      {ticket.status !== "COMPLETE" && (
        <form action={completeBatch} className="flex flex-col gap-2 rounded-xl border border-border bg-surface p-4 shadow-sm">
          <input type="hidden" name="batchTicketId" value={ticket.id} />
          <h2 className="font-display text-base font-semibold">{d.completeTitle}</h2>
          <p className="text-xs text-ink-muted">{d.completeIntro}</p>
          <button type="submit" className="rounded-md bg-accent py-2.5 text-sm font-medium text-white">
            {d.completeButton}
          </button>
        </form>
      )}

      {ticket.status === "COMPLETE" && !ticket.trip && (
        <form action={startTrip} className="flex flex-col gap-3 rounded-xl border border-border bg-surface p-4 shadow-sm">
          <input type="hidden" name="batchTicketId" value={ticket.id} />
          <input type="hidden" name="returnTo" value="/operator" />
          <h2 className="font-display text-base font-semibold">{d.assignTitle}</h2>
          <EquipmentAssignPicker
            equipment={{ name: "truckId", label: d.truck, placeholder: d.selectTruck, required: true, className: mobileSelect, options: truckOptions }}
            dependents={[{ key: "driverId", name: "driverId", label: d.driver, placeholder: d.selectDriver, required: true, className: mobileSelect, options: driverOptions }]}
          />
          {trucks.length === 0 && <p className="text-xs text-warn">{d.noTrucksAvailable}</p>}
          {isPumpDelivery && (
            <div className="flex flex-col gap-3 border-t border-border pt-3">
              <p className="text-xs text-ink-muted">{d.pumpDeliveryNote}</p>
              <EquipmentAssignPicker
                equipment={{ name: "pumpId", label: d.pump, placeholder: dict.field.selectPump, required: true, className: mobileSelect, options: pumpOptions }}
                dependents={[
                  { key: "pumpOperatorId", name: "pumpOperatorId", label: d.pumpOperator, placeholder: d.selectPumpOperator, required: true, className: mobileSelect, options: operatorOptions },
                  { key: "pumpAssistantId", name: "pumpAssistantId", label: d.pumpAssistant, placeholder: dict.field.none, className: mobileSelect, options: assistantOptions },
                ]}
              />
              {ticket.reservation.minPumpReachM != null && (
                <p className="text-xs text-ink-muted">{d.minPumpReachNote(ticket.reservation.minPumpReachM)}</p>
              )}
            </div>
          )}
          <button type="submit" className="rounded-md bg-accent py-2.5 text-sm font-medium text-white">
            {d.startTrip}
          </button>
        </form>
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
        </div>
      )}
    </div>
  );
}
