import { prisma } from "@/lib/prisma";
import { ui } from "@/lib/ui";
import { requirePageAccess } from "@/lib/session";
import { getDictionary } from "@/lib/i18n";
import {
  rankDriversByIncentive,
  rankPumpOperatorsByIncentive,
  type IncentivePolicy,
  type DriverTripCount,
  type PumpOperatorTrips,
} from "@/lib/incentives";
import { updateIncentivePolicy, updatePumpIncentivePolicy, addPumpRateBracket, deletePumpRateBracket } from "./actions";

const DEFAULT_POLICY: IncentivePolicy = {
  freeTripsThreshold: 10,
  tier2Threshold: 15,
  tier2RateSar: 0,
  tier3Threshold: 20,
  tier3RateSar: 0,
  beyondRateSar: 20,
};

// The five roles with a real trip/delivery-count source to base an
// incentive on. Each is backed by a different underlying record — mixer
// drivers and pump crew come off Trip, cement/water delivery drivers come
// off MaterialReceipt filtered by the material's type — so each gets its
// own query below rather than one generic lookup. PUMP_OPERATOR is priced
// entirely differently (volume × reach bracket, not a trip-count tier —
// see calculatePumpOperatorPayout) and is rendered as its own branch
// below rather than through the shared count/tier path the other four use.
const COUNT_BASED_ROLES = ["MIXER_DRIVER", "PUMP_ASSISTANT", "BULKER_DRIVER", "WATER_TANKER_DRIVER"] as const;

async function mixerDriverCounts(plantId: string, monthStart: Date): Promise<DriverTripCount[]> {
  const trips = await prisma.trip.findMany({
    where: { status: "CLOSED", batchTime: { gte: monthStart }, driver: { plantId } },
    select: { driverId: true, driver: { select: { name: true } } },
  });
  const counts = new Map<string, DriverTripCount>();
  for (const t of trips) {
    const entry = counts.get(t.driverId) ?? { driverId: t.driverId, driverName: t.driver.name, tripCount: 0 };
    entry.tripCount += 1;
    counts.set(t.driverId, entry);
  }
  return Array.from(counts.values());
}

// Per-trip volume and pump reach for every pump operator, closed trips
// only — the raw material calculatePumpOperatorPayout actually needs,
// unlike the other roles' plain trip counts.
async function pumpOperatorTripDetails(plantId: string, monthStart: Date): Promise<PumpOperatorTrips[]> {
  const trips = await prisma.trip.findMany({
    where: { status: "CLOSED", batchTime: { gte: monthStart }, driver: { plantId }, pumpOperatorId: { not: null } },
    select: {
      pumpOperatorId: true,
      pumpOperatorCrew: { select: { name: true } },
      volumeDeliveredM3: true,
      pump: { select: { reachM: true } },
    },
  });
  const byOperator = new Map<string, PumpOperatorTrips>();
  for (const t of trips) {
    if (!t.pumpOperatorId || !t.pumpOperatorCrew) continue;
    const entry = byOperator.get(t.pumpOperatorId) ?? { driverId: t.pumpOperatorId, driverName: t.pumpOperatorCrew.name, trips: [] };
    entry.trips.push({ volumeM3: t.volumeDeliveredM3 ?? 0, reachM: t.pump?.reachM ?? null });
    byOperator.set(t.pumpOperatorId, entry);
  }
  return Array.from(byOperator.values());
}

async function pumpAssistantCounts(plantId: string, monthStart: Date): Promise<DriverTripCount[]> {
  const trips = await prisma.trip.findMany({
    where: { status: "CLOSED", batchTime: { gte: monthStart }, driver: { plantId }, pumpAssistantId: { not: null } },
    select: { pumpAssistantId: true, pumpAssistantCrew: { select: { name: true } } },
  });
  const counts = new Map<string, DriverTripCount>();
  for (const t of trips) {
    if (!t.pumpAssistantId || !t.pumpAssistantCrew) continue;
    const entry = counts.get(t.pumpAssistantId) ?? { driverId: t.pumpAssistantId, driverName: t.pumpAssistantCrew.name, tripCount: 0 };
    entry.tripCount += 1;
    counts.set(t.pumpAssistantId, entry);
  }
  return Array.from(counts.values());
}

// Attribution prefers the roster driverId (an Employee), falling back to
// the free-typed driverName as the grouping key when a delivery was logged
// without picking someone from master data — same free-text-first pattern
// as the pump crew fields on Trip.
async function materialDriverCounts(plantId: string, monthStart: Date, materialType: string): Promise<DriverTripCount[]> {
  const receipts = await prisma.materialReceipt.findMany({
    where: { plantId, receivedAt: { gte: monthStart }, material: { type: materialType } },
    select: { driverId: true, driverName: true, driver: { select: { name: true } } },
  });
  const counts = new Map<string, DriverTripCount>();
  for (const r of receipts) {
    const name = r.driver?.name ?? r.driverName;
    if (!name) continue;
    const key = r.driverId ?? `name:${name}`;
    const entry = counts.get(key) ?? { driverId: key, driverName: name, tripCount: 0 };
    entry.tripCount += 1;
    counts.set(key, entry);
  }
  return Array.from(counts.values());
}

async function countsForRole(role: (typeof COUNT_BASED_ROLES)[number], plantId: string, monthStart: Date): Promise<DriverTripCount[]> {
  switch (role) {
    case "MIXER_DRIVER":
      return mixerDriverCounts(plantId, monthStart);
    case "PUMP_ASSISTANT":
      return pumpAssistantCounts(plantId, monthStart);
    case "BULKER_DRIVER":
      return materialDriverCounts(plantId, monthStart, "CEMENT");
    case "WATER_TANKER_DRIVER":
      return materialDriverCounts(plantId, monthStart, "WATER");
  }
}

function CountBasedRoleCard({
  dict,
  m,
  plant,
  role,
  policy,
  ranked,
}: {
  dict: Awaited<ReturnType<typeof getDictionary>>["dict"];
  m: Awaited<ReturnType<typeof getDictionary>>["dict"]["modules"]["incentives"];
  plant: { id: string; currency: string };
  role: string;
  policy: IncentivePolicy;
  ranked: ReturnType<typeof rankDriversByIncentive>;
}) {
  return (
    <div className="flex flex-col gap-3 border-s-2 border-border ps-4">
      <h3 className="font-display text-sm font-semibold text-ink-muted">{m.roleLabel[role as keyof typeof m.roleLabel]}</h3>

      <form action={updateIncentivePolicy} className={`${ui.card} flex flex-wrap items-end gap-4`}>
        <input type="hidden" name="plantId" value={plant.id} />
        <input type="hidden" name="role" value={role} />
        <div>
          <label className={ui.label}>{m.freeTrips}</label>
          <input name="freeTripsThreshold" type="number" defaultValue={policy.freeTripsThreshold} className="w-24 rounded-md border border-border bg-surface px-2 py-1.5 text-sm" />
        </div>
        <div>
          <label className={ui.label}>{m.tier2Threshold}</label>
          <input name="tier2Threshold" type="number" defaultValue={policy.tier2Threshold} className="w-24 rounded-md border border-border bg-surface px-2 py-1.5 text-sm" />
        </div>
        <div>
          <label className={ui.label}>{m.tier2Rate(plant.currency)}</label>
          <input name="tier2RateSar" type="number" step="0.5" defaultValue={policy.tier2RateSar} className="w-24 rounded-md border border-border bg-surface px-2 py-1.5 text-sm" />
        </div>
        <div>
          <label className={ui.label}>{m.tier3Threshold}</label>
          <input name="tier3Threshold" type="number" defaultValue={policy.tier3Threshold} className="w-24 rounded-md border border-border bg-surface px-2 py-1.5 text-sm" />
        </div>
        <div>
          <label className={ui.label}>{m.tier3Rate(plant.currency)}</label>
          <input name="tier3RateSar" type="number" step="0.5" defaultValue={policy.tier3RateSar} className="w-24 rounded-md border border-border bg-surface px-2 py-1.5 text-sm" />
        </div>
        <div>
          <label className={ui.label}>{m.beyondRate(plant.currency)}</label>
          <input name="beyondRateSar" type="number" step="0.5" defaultValue={policy.beyondRateSar} className="w-24 rounded-md border border-border bg-surface px-2 py-1.5 text-sm" />
        </div>
        <button className="rounded-md border border-border px-3 py-1.5 text-sm hover:bg-surface-alt">{dict.field.save}</button>
      </form>

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
                <td className={`${ui.td} font-mono tabular`} dir="ltr">
                  {r.payout.toLocaleString()} {plant.currency}
                </td>
              </tr>
            ))}
            {ranked.length === 0 && (
              <tr>
                <td className={ui.td} colSpan={3}>
                  <span className="text-ink-muted">{m.empty}</span>
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
}

export default async function IncentivesPage() {
  await requirePageAccess("incentives");
  const { dict } = await getDictionary();
  const m = dict.modules.incentives;

  const plants = await prisma.plant.findMany({
    orderBy: { name: "asc" },
    include: { incentivePolicies: true, pumpIncentivePolicy: { include: { rateBrackets: { orderBy: { minReachM: "asc" } } } } },
  });

  const monthStart = new Date();
  monthStart.setDate(1);
  monthStart.setHours(0, 0, 0, 0);

  const plantResults = await Promise.all(
    plants.map(async (plant) => {
      const roleResults = await Promise.all(
        COUNT_BASED_ROLES.map(async (role) => {
          const policy: IncentivePolicy =
            plant.incentivePolicies.find((p) => p.role === role) ?? DEFAULT_POLICY;
          const counts = await countsForRole(role, plant.id, monthStart);
          const ranked = rankDriversByIncentive(counts, policy);
          return { role, policy, ranked };
        }),
      );

      const pumpFreeVolumeM3 = plant.pumpIncentivePolicy?.freeVolumeM3 ?? 0;
      const pumpRateBrackets = plant.pumpIncentivePolicy?.rateBrackets ?? [];
      const pumpOperatorTrips = await pumpOperatorTripDetails(plant.id, monthStart);
      const pumpOperatorRanked = rankPumpOperatorsByIncentive(pumpOperatorTrips, pumpFreeVolumeM3, pumpRateBrackets);

      return { plant, roleResults, pumpFreeVolumeM3, pumpRateBrackets, pumpOperatorRanked };
    }),
  );

  return (
    <div className="flex flex-col gap-8">
      <header>
        <div className={ui.eyebrow}>{m.eyebrow}</div>
        <h1 className={ui.h1}>{m.title}</h1>
        <p className={ui.intro}>{m.intro}</p>
      </header>

      {plantResults.map(({ plant, roleResults, pumpFreeVolumeM3, pumpRateBrackets, pumpOperatorRanked }) => (
        <div key={plant.id} className="flex flex-col gap-6">
          <h2 className="font-display text-lg font-semibold">{plant.name}</h2>

          {/* MIXER_DRIVER first, matching the original role order. */}
          {roleResults.slice(0, 1).map(({ role, policy, ranked }) => (
            <CountBasedRoleCard key={role} dict={dict} m={m} plant={plant} role={role} policy={policy} ranked={ranked} />
          ))}

          <div className="flex flex-col gap-3 border-s-2 border-border ps-4">
            <h3 className="font-display text-sm font-semibold text-ink-muted">{m.roleLabel.PUMP_OPERATOR}</h3>
            <p className="text-xs text-ink-muted">{m.pumpIncentiveNote}</p>

            <form action={updatePumpIncentivePolicy} className={`${ui.card} flex flex-wrap items-end gap-4`}>
              <input type="hidden" name="plantId" value={plant.id} />
              <div>
                <label className={ui.label}>{m.pumpFreeVolume}</label>
                <input name="freeVolumeM3" type="number" step="0.5" defaultValue={pumpFreeVolumeM3} className="w-28 rounded-md border border-border bg-surface px-2 py-1.5 text-sm" />
              </div>
              <button className="rounded-md border border-border px-3 py-1.5 text-sm hover:bg-surface-alt">{dict.field.save}</button>
            </form>

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
                  {pumpRateBrackets.map((b) => (
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
                  {pumpRateBrackets.length === 0 && (
                    <tr>
                      <td className={ui.td} colSpan={3}><span className="text-ink-muted">{m.pumpRateBracketsEmpty}</span></td>
                    </tr>
                  )}
                </tbody>
              </table>
              <form action={addPumpRateBracket} className="mt-3 flex flex-wrap items-end gap-3">
                <input type="hidden" name="plantId" value={plant.id} />
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
                  {pumpOperatorRanked.map((r) => (
                    <tr key={r.driverId}>
                      <td className={`${ui.td} font-medium`}>{r.driverName}</td>
                      <td className={`${ui.td} font-mono tabular`}>{r.volumeM3.toFixed(1)} m³</td>
                      <td className={`${ui.td} font-mono tabular`} dir="ltr">{r.payout.toLocaleString()} {plant.currency}</td>
                    </tr>
                  ))}
                  {pumpOperatorRanked.length === 0 && (
                    <tr>
                      <td className={ui.td} colSpan={3}><span className="text-ink-muted">{m.empty}</span></td>
                    </tr>
                  )}
                </tbody>
              </table>
            </div>
          </div>

          {roleResults.slice(1).map(({ role, policy, ranked }) => (
            <CountBasedRoleCard key={role} dict={dict} m={m} plant={plant} role={role} policy={policy} ranked={ranked} />
          ))}
        </div>
      ))}
    </div>
  );
}
