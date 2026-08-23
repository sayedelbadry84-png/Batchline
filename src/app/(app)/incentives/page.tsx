import Link from "next/link";
import { prisma } from "@/lib/prisma";
import { ui } from "@/lib/ui";
import { requirePageAccess } from "@/lib/session";
import { getDictionary } from "@/lib/i18n";
import {
  rankDriversByIncentive,
  rankByVolumeIncentive,
  isReachBasedRole,
  DEFAULT_INCENTIVE_METHOD,
  INCENTIVE_ROLE_KEYS,
  type IncentivePolicy,
  type DriverTripCount,
  type PumpOperatorTrips,
  type IncentiveMethodKind,
} from "@/lib/incentives";
import {
  updateIncentivePolicy,
  updatePumpIncentivePolicy,
  addPumpRateBracket,
  deletePumpRateBracket,
  setFlatVolumeRate,
  setIncentiveMethod,
} from "./actions";

const DEFAULT_POLICY: IncentivePolicy = {
  freeTripsThreshold: 10,
  tier2Threshold: 15,
  tier2RateSar: 0,
  tier3Threshold: 20,
  tier3RateSar: 0,
  beyondRateSar: 20,
};

// --- Per-role trip/delivery sources — each of the five incentive roles is
// backed by a different underlying record (Trip for mixer/pump crew,
// MaterialReceipt filtered by material type for bulker/water drivers), so
// each gets its own query rather than one generic lookup. Every role now
// has BOTH a count- and a volume-shaped reader, since either the
// TRIP_COUNT or the VOLUME_M3 method can apply to any of them (see
// DEFAULT_INCENTIVE_METHOD / IncentiveMethod). ---

async function mixerDriverTrips(plantId: string, monthStart: Date) {
  return prisma.trip.findMany({
    where: { status: "CLOSED", batchTime: { gte: monthStart }, driver: { plantId } },
    select: { driverId: true, driver: { select: { name: true } }, volumeDeliveredM3: true },
  });
}

async function pumpCrewTrips(plantId: string, monthStart: Date, crewField: "pumpOperatorId" | "pumpAssistantId") {
  return prisma.trip.findMany({
    where: { status: "CLOSED", batchTime: { gte: monthStart }, driver: { plantId }, [crewField]: { not: null } },
    select: {
      pumpOperatorId: true,
      pumpAssistantId: true,
      pumpOperatorCrew: { select: { name: true } },
      pumpAssistantCrew: { select: { name: true } },
      volumeDeliveredM3: true,
      pump: { select: { reachM: true } },
    },
  });
}

async function materialReceipts(plantId: string, monthStart: Date, materialType: string) {
  return prisma.materialReceipt.findMany({
    where: { plantId, receivedAt: { gte: monthStart }, material: { type: materialType } },
    select: { driverId: true, driverName: true, driver: { select: { name: true } }, netWeightKg: true },
  });
}

async function countsForRole(role: string, plantId: string, monthStart: Date): Promise<DriverTripCount[]> {
  const counts = new Map<string, DriverTripCount>();
  const bump = (id: string | null | undefined, name: string | null | undefined) => {
    if (!id || !name) return;
    const entry = counts.get(id) ?? { driverId: id, driverName: name, tripCount: 0 };
    entry.tripCount += 1;
    counts.set(id, entry);
  };

  if (role === "MIXER_DRIVER") {
    for (const t of await mixerDriverTrips(plantId, monthStart)) bump(t.driverId, t.driver.name);
  } else if (role === "PUMP_OPERATOR") {
    for (const t of await pumpCrewTrips(plantId, monthStart, "pumpOperatorId")) bump(t.pumpOperatorId, t.pumpOperatorCrew?.name);
  } else if (role === "PUMP_ASSISTANT") {
    for (const t of await pumpCrewTrips(plantId, monthStart, "pumpAssistantId")) bump(t.pumpAssistantId, t.pumpAssistantCrew?.name);
  } else if (role === "BULKER_DRIVER") {
    for (const r of await materialReceipts(plantId, monthStart, "CEMENT")) bump(r.driverId ?? `name:${r.driver?.name ?? r.driverName}`, r.driver?.name ?? r.driverName);
  } else if (role === "WATER_TANKER_DRIVER") {
    for (const r of await materialReceipts(plantId, monthStart, "WATER")) bump(r.driverId ?? `name:${r.driver?.name ?? r.driverName}`, r.driver?.name ?? r.driverName);
  }
  return Array.from(counts.values());
}

async function volumeTripsForRole(role: string, plantId: string, monthStart: Date): Promise<PumpOperatorTrips[]> {
  const byId = new Map<string, PumpOperatorTrips>();
  const push = (id: string | null | undefined, name: string | null | undefined, volumeM3: number, reachM: number | null) => {
    if (!id || !name) return;
    const entry = byId.get(id) ?? { driverId: id, driverName: name, trips: [] };
    entry.trips.push({ volumeM3, reachM });
    byId.set(id, entry);
  };

  if (role === "MIXER_DRIVER") {
    for (const t of await mixerDriverTrips(plantId, monthStart)) push(t.driverId, t.driver.name, t.volumeDeliveredM3 ?? 0, null);
  } else if (role === "PUMP_OPERATOR") {
    for (const t of await pumpCrewTrips(plantId, monthStart, "pumpOperatorId")) push(t.pumpOperatorId, t.pumpOperatorCrew?.name, t.volumeDeliveredM3 ?? 0, t.pump?.reachM ?? null);
  } else if (role === "PUMP_ASSISTANT") {
    for (const t of await pumpCrewTrips(plantId, monthStart, "pumpAssistantId")) push(t.pumpAssistantId, t.pumpAssistantCrew?.name, t.volumeDeliveredM3 ?? 0, t.pump?.reachM ?? null);
  } else if (role === "BULKER_DRIVER") {
    for (const r of await materialReceipts(plantId, monthStart, "CEMENT")) push(r.driverId ?? `name:${r.driver?.name ?? r.driverName}`, r.driver?.name ?? r.driverName, r.netWeightKg / 1000, null);
  } else if (role === "WATER_TANKER_DRIVER") {
    for (const r of await materialReceipts(plantId, monthStart, "WATER")) push(r.driverId ?? `name:${r.driver?.name ?? r.driverName}`, r.driver?.name ?? r.driverName, r.netWeightKg / 1000, null);
  }
  return Array.from(byId.values());
}

type Dict = Awaited<ReturnType<typeof getDictionary>>["dict"];
type M = Dict["modules"]["incentives"];

function TripCountResultCard({ m, plant, role, ranked }: { m: M; plant: { id: string; currency: string }; role: string; ranked: ReturnType<typeof rankDriversByIncentive> }) {
  return (
    <div className="flex flex-col gap-3 border-s-2 border-border ps-4">
      <h3 className="font-display text-sm font-semibold text-ink-muted">{m.roleLabel[role as keyof typeof m.roleLabel]}</h3>
      <div className={ui.card}>
        <table className={ui.table}>
          <thead>
            <tr>
              <th className={ui.th}>{m.col.driver}</th>
              <th className={ui.th}>{m.col.trips}</th>
              <th className={ui.th}>{m.col.payout}</th>
            </tr>
          </thead>
          <tbody>
            {ranked.map((r) => (
              <tr key={r.driverId}>
                <td className={`${ui.td} font-medium`}>{r.driverName}</td>
                <td className={`${ui.td} font-mono tabular`}>{r.tripCount}</td>
                <td className={`${ui.td} font-mono tabular`} dir="ltr">{r.payout.toLocaleString()} {plant.currency}</td>
              </tr>
            ))}
            {ranked.length === 0 && (
              <tr><td className={ui.td} colSpan={3}><span className="text-ink-muted">{m.empty}</span></td></tr>
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
}

function VolumeResultCard({ m, plant, role, ranked }: { m: M; plant: { id: string; currency: string }; role: string; ranked: ReturnType<typeof rankByVolumeIncentive> }) {
  return (
    <div className="flex flex-col gap-3 border-s-2 border-border ps-4">
      <h3 className="font-display text-sm font-semibold text-ink-muted">{m.roleLabel[role as keyof typeof m.roleLabel]}</h3>
      <div className={ui.card}>
        <table className={ui.table}>
          <thead>
            <tr>
              <th className={ui.th}>{m.col.driver}</th>
              <th className={ui.th}>{m.pumpVolumeCol}</th>
              <th className={ui.th}>{m.col.payout}</th>
            </tr>
          </thead>
          <tbody>
            {ranked.map((r) => (
              <tr key={r.driverId}>
                <td className={`${ui.td} font-medium`}>{r.driverName}</td>
                <td className={`${ui.td} font-mono tabular`}>{r.volumeM3.toFixed(1)}</td>
                <td className={`${ui.td} font-mono tabular`} dir="ltr">{r.payout.toLocaleString()} {plant.currency}</td>
              </tr>
            ))}
            {ranked.length === 0 && (
              <tr><td className={ui.td} colSpan={3}><span className="text-ink-muted">{m.empty}</span></td></tr>
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
}

export default async function IncentivesPage({ searchParams }: { searchParams: Promise<{ tab?: string }> }) {
  await requirePageAccess("incentives");
  const { dict } = await getDictionary();
  const m = dict.modules.incentives;
  const { tab: tabRaw } = await searchParams;
  const tab: "results" | "plan" = tabRaw === "plan" ? "plan" : "results";

  const plants = await prisma.plant.findMany({
    orderBy: { name: "asc" },
    include: {
      incentivePolicies: true,
      pumpIncentivePolicies: { include: { rateBrackets: { orderBy: { minReachM: "asc" } } } },
      incentiveMethods: true,
    },
  });

  const monthStart = new Date();
  monthStart.setDate(1);
  monthStart.setHours(0, 0, 0, 0);

  const plantData = plants.map((plant) => {
    const methodOverride = new Map(plant.incentiveMethods.map((r) => [r.role, r.method as IncentiveMethodKind]));
    const effectiveMethod = (role: string): IncentiveMethodKind => methodOverride.get(role) ?? DEFAULT_INCENTIVE_METHOD[role];
    return { plant, effectiveMethod };
  });

  return (
    <div className="flex flex-col gap-8">
      <header>
        <div className={ui.eyebrow}>{m.eyebrow}</div>
        <h1 className={ui.h1}>{m.title}</h1>
        <p className={ui.intro}>{m.intro}</p>
      </header>

      <div className="flex gap-1 border-b border-border">
        {(["results", "plan"] as const).map((t) => (
          <Link
            key={t}
            href={`/incentives?tab=${t}`}
            className={`rounded-t-md px-3 py-2 text-sm ${tab === t ? "border-b-2 border-accent font-medium text-ink" : "text-ink-muted hover:text-ink"}`}
          >
            {t === "results" ? m.tabs.results : m.tabs.plan}
          </Link>
        ))}
      </div>

      {tab === "results" &&
        (await Promise.all(
          plantData.map(async ({ plant, effectiveMethod }) => {
            const roleCards = await Promise.all(
              INCENTIVE_ROLE_KEYS.map(async (role) => {
                const method = effectiveMethod(role);
                if (method === "VOLUME_M3") {
                  const policy = plant.pumpIncentivePolicies.find((p) => p.role === role);
                  const trips = await volumeTripsForRole(role, plant.id, monthStart);
                  const ranked = rankByVolumeIncentive(trips, policy?.freeVolumeM3 ?? 0, policy?.rateBrackets ?? []);
                  return <VolumeResultCard key={role} m={m} plant={plant} role={role} ranked={ranked} />;
                }
                const policy: IncentivePolicy = plant.incentivePolicies.find((p) => p.role === role) ?? DEFAULT_POLICY;
                const counts = await countsForRole(role, plant.id, monthStart);
                const ranked = rankDriversByIncentive(counts, policy);
                return <TripCountResultCard key={role} m={m} plant={plant} role={role} ranked={ranked} />;
              }),
            );
            return (
              <div key={plant.id} className="flex flex-col gap-6">
                <h2 className="font-display text-lg font-semibold">{plant.name}</h2>
                {roleCards}
              </div>
            );
          }),
        ))}

      {tab === "plan" &&
        plantData.map(({ plant, effectiveMethod }) => (
          <div key={plant.id} className="flex flex-col gap-6">
            <h2 className="font-display text-lg font-semibold">{plant.name}</h2>
            <p className="text-sm text-ink-muted">{m.planIntro}</p>

            {INCENTIVE_ROLE_KEYS.map((role) => {
              const method = effectiveMethod(role);
              const tripPolicy: IncentivePolicy = plant.incentivePolicies.find((p) => p.role === role) ?? DEFAULT_POLICY;
              const volumePolicy = plant.pumpIncentivePolicies.find((p) => p.role === role);
              const reachBased = isReachBasedRole(role);
              const flatRate = volumePolicy?.rateBrackets[0]?.ratePerM3Sar ?? 0;

              return (
                <div key={role} className="flex flex-col gap-3 border-s-2 border-border ps-4">
                  <h3 className="font-display text-sm font-semibold text-ink-muted">{m.roleLabel[role as keyof typeof m.roleLabel]}</h3>

                  <form action={setIncentiveMethod} className="flex items-end gap-3">
                    <input type="hidden" name="plantId" value={plant.id} />
                    <input type="hidden" name="role" value={role} />
                    <div>
                      <label className={ui.label}>{m.methodCol.method}</label>
                      <select name="method" defaultValue={method} className={`${ui.select} w-56`}>
                        <option value="TRIP_COUNT">{m.methodLabel.TRIP_COUNT}</option>
                        <option value="VOLUME_M3">{m.methodLabel.VOLUME_M3}</option>
                      </select>
                    </div>
                    <button className="rounded-md border border-border px-3 py-1.5 text-sm hover:bg-surface-alt">{dict.field.save}</button>
                  </form>

                  {method === "TRIP_COUNT" ? (
                    <form action={updateIncentivePolicy} className={`${ui.card} flex flex-wrap items-end gap-4`}>
                      <input type="hidden" name="plantId" value={plant.id} />
                      <input type="hidden" name="role" value={role} />
                      <div>
                        <label className={ui.label}>{m.freeTrips}</label>
                        <input name="freeTripsThreshold" type="number" defaultValue={tripPolicy.freeTripsThreshold} className="w-24 rounded-md border border-border bg-surface px-2 py-1.5 text-sm" />
                      </div>
                      <div>
                        <label className={ui.label}>{m.tier2Threshold}</label>
                        <input name="tier2Threshold" type="number" defaultValue={tripPolicy.tier2Threshold} className="w-24 rounded-md border border-border bg-surface px-2 py-1.5 text-sm" />
                      </div>
                      <div>
                        <label className={ui.label}>{m.tier2Rate(plant.currency)}</label>
                        <input name="tier2RateSar" type="number" step="0.5" defaultValue={tripPolicy.tier2RateSar} className="w-24 rounded-md border border-border bg-surface px-2 py-1.5 text-sm" />
                      </div>
                      <div>
                        <label className={ui.label}>{m.tier3Threshold}</label>
                        <input name="tier3Threshold" type="number" defaultValue={tripPolicy.tier3Threshold} className="w-24 rounded-md border border-border bg-surface px-2 py-1.5 text-sm" />
                      </div>
                      <div>
                        <label className={ui.label}>{m.tier3Rate(plant.currency)}</label>
                        <input name="tier3RateSar" type="number" step="0.5" defaultValue={tripPolicy.tier3RateSar} className="w-24 rounded-md border border-border bg-surface px-2 py-1.5 text-sm" />
                      </div>
                      <div>
                        <label className={ui.label}>{m.beyondRate(plant.currency)}</label>
                        <input name="beyondRateSar" type="number" step="0.5" defaultValue={tripPolicy.beyondRateSar} className="w-24 rounded-md border border-border bg-surface px-2 py-1.5 text-sm" />
                      </div>
                      <button className="rounded-md border border-border px-3 py-1.5 text-sm hover:bg-surface-alt">{dict.field.save}</button>
                    </form>
                  ) : (
                    <>
                      <p className="text-xs text-ink-muted">{m.pumpIncentiveNote}</p>
                      <form action={updatePumpIncentivePolicy} className={`${ui.card} flex flex-wrap items-end gap-4`}>
                        <input type="hidden" name="plantId" value={plant.id} />
                        <input type="hidden" name="role" value={role} />
                        <div>
                          <label className={ui.label}>{m.pumpFreeVolume}</label>
                          <input name="freeVolumeM3" type="number" step="0.5" defaultValue={volumePolicy?.freeVolumeM3 ?? 0} className="w-28 rounded-md border border-border bg-surface px-2 py-1.5 text-sm" />
                        </div>
                        <button className="rounded-md border border-border px-3 py-1.5 text-sm hover:bg-surface-alt">{dict.field.save}</button>
                      </form>

                      {reachBased ? (
                        <div className={ui.card}>
                          <h4 className="mb-2 font-mono text-xs font-semibold text-ink-muted uppercase">{m.pumpRateBracketsTitle}</h4>
                          <table className={ui.table}>
                            <thead>
                              <tr>
                                <th className={ui.th}>{m.pumpRateCol.reach}</th>
                                <th className={ui.th}>{m.pumpRateCol.rate}</th>
                                <th className={ui.th}></th>
                              </tr>
                            </thead>
                            <tbody>
                              {(volumePolicy?.rateBrackets ?? []).map((b) => (
                                <tr key={b.id}>
                                  <td className={`${ui.td} font-mono tabular`} dir="ltr">{b.minReachM}–{b.maxReachM ?? "∞"} m</td>
                                  <td className={`${ui.td} font-mono tabular`} dir="ltr">{b.ratePerM3Sar} {plant.currency}/m³</td>
                                  <td className={ui.td}>
                                    <form action={deletePumpRateBracket}>
                                      <input type="hidden" name="id" value={b.id} />
                                      <button className="text-xs font-medium text-critical hover:underline">{dict.field.delete}</button>
                                    </form>
                                  </td>
                                </tr>
                              ))}
                              {(volumePolicy?.rateBrackets.length ?? 0) === 0 && (
                                <tr><td className={ui.td} colSpan={3}><span className="text-ink-muted">{m.pumpRateBracketsEmpty}</span></td></tr>
                              )}
                            </tbody>
                          </table>
                          <form action={addPumpRateBracket} className="mt-3 flex flex-wrap items-end gap-3">
                            <input type="hidden" name="plantId" value={plant.id} />
                            <input type="hidden" name="role" value={role} />
                            <div>
                              <label className={ui.label}>{m.pumpRateCol.minReach}</label>
                              <input name="minReachM" type="number" step="0.5" required className="w-24 rounded-md border border-border bg-surface px-2 py-1.5 text-sm" />
                            </div>
                            <div>
                              <label className={ui.label}>{m.pumpRateCol.maxReach}</label>
                              <input name="maxReachM" type="number" step="0.5" className="w-24 rounded-md border border-border bg-surface px-2 py-1.5 text-sm" placeholder="∞" />
                            </div>
                            <div>
                              <label className={ui.label}>{m.pumpRateCol.rate}</label>
                              <input name="ratePerM3Sar" type="number" step="0.5" required className="w-24 rounded-md border border-border bg-surface px-2 py-1.5 text-sm" />
                            </div>
                            <button className="rounded-md border border-border px-3 py-1.5 text-sm hover:bg-surface-alt">{m.pumpRateCol.add}</button>
                          </form>
                        </div>
                      ) : (
                        <form action={setFlatVolumeRate} className={`${ui.card} flex flex-wrap items-end gap-4`}>
                          <input type="hidden" name="plantId" value={plant.id} />
                          <input type="hidden" name="role" value={role} />
                          <div>
                            <label className={ui.label}>{m.flatRate(plant.currency)}</label>
                            <input name="ratePerM3Sar" type="number" step="0.5" defaultValue={flatRate} className="w-28 rounded-md border border-border bg-surface px-2 py-1.5 text-sm" />
                          </div>
                          <button className="rounded-md border border-border px-3 py-1.5 text-sm hover:bg-surface-alt">{dict.field.save}</button>
                        </form>
                      )}
                    </>
                  )}
                </div>
              );
            })}
          </div>
        ))}
    </div>
  );
}
