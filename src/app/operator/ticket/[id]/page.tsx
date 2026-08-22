import { redirect, notFound } from "next/navigation";
import Link from "next/link";
import { prisma } from "@/lib/prisma";
import { getCurrentUser } from "@/lib/session";
import { getDictionary } from "@/lib/i18n";
import { recordActuals, recordActualField, completeBatch, startTrip } from "@/app/(app)/production/actions";
import { rankTrucksForVolume } from "@/lib/dispatch";
import { AutoSaveField } from "@/components/AutoSaveField";

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

  const [trucksRaw, drivers, pumps, pumpCrew] = ticket.status === "COMPLETE" && !ticket.trip
    ? await Promise.all([
        prisma.truck.findMany({
          where: { plantId: ticket.plantId, status: "ACTIVE", trips: { none: { status: { not: "CLOSED" } } } },
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
          <div>
            <label className="mb-1 block text-xs text-ink-muted">{d.truck}</label>
            <select name="truckId" required className="w-full rounded-md border border-border bg-bg px-2 py-2 text-sm">
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
            <label className="mb-1 block text-xs text-ink-muted">{d.driver}</label>
            <select name="driverId" required className="w-full rounded-md border border-border bg-bg px-2 py-2 text-sm">
              <option value="">{d.selectDriver}</option>
              {drivers.map((dr) => (
                <option key={dr.id} value={dr.id}>{dr.name}</option>
              ))}
            </select>
          </div>
          {isPumpDelivery && (
            <div className="flex flex-col gap-3 border-t border-border pt-3">
              <p className="text-xs text-ink-muted">{d.pumpDeliveryNote}</p>
              <div>
                <label className="mb-1 block text-xs text-ink-muted">{d.pump}</label>
                <select name="pumpId" required className="w-full rounded-md border border-border bg-bg px-2 py-2 text-sm">
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
                <label className="mb-1 block text-xs text-ink-muted">{d.pumpOperator}</label>
                <select name="pumpOperatorId" required className="w-full rounded-md border border-border bg-bg px-2 py-2 text-sm">
                  <option value="">{d.selectPumpOperator}</option>
                  {pumpCrew.filter((c) => c.role === "OPERATOR").map((c) => (
                    <option key={c.id} value={c.id}>{c.name}</option>
                  ))}
                </select>
              </div>
              <div>
                <label className="mb-1 block text-xs text-ink-muted">{d.pumpAssistant}</label>
                <select name="pumpAssistantId" className="w-full rounded-md border border-border bg-bg px-2 py-2 text-sm">
                  <option value="">{dict.field.none}</option>
                  {pumpCrew.filter((c) => c.role === "HELPER").map((c) => (
                    <option key={c.id} value={c.id}>{c.name}</option>
                  ))}
                </select>
              </div>
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
        </div>
      )}
    </div>
  );
}
