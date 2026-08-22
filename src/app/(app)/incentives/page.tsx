import { prisma } from "@/lib/prisma";
import { ui } from "@/lib/ui";
import { requirePageAccess } from "@/lib/session";
import { getDictionary } from "@/lib/i18n";
import { rankDriversByIncentive, type IncentivePolicy, type DriverTripCount } from "@/lib/incentives";
import { updateIncentivePolicy } from "./actions";

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
// own query below rather than one generic lookup.
const INCENTIVE_ROLES = ["MIXER_DRIVER", "PUMP_OPERATOR", "PUMP_ASSISTANT", "BULKER_DRIVER", "WATER_TANKER_DRIVER"] as const;

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

async function pumpOperatorCounts(plantId: string, monthStart: Date): Promise<DriverTripCount[]> {
  const trips = await prisma.trip.findMany({
    where: { status: "CLOSED", batchTime: { gte: monthStart }, driver: { plantId }, pumpOperatorId: { not: null } },
    select: { pumpOperatorId: true, pumpOperatorCrew: { select: { name: true } } },
  });
  const counts = new Map<string, DriverTripCount>();
  for (const t of trips) {
    if (!t.pumpOperatorId || !t.pumpOperatorCrew) continue;
    const entry = counts.get(t.pumpOperatorId) ?? { driverId: t.pumpOperatorId, driverName: t.pumpOperatorCrew.name, tripCount: 0 };
    entry.tripCount += 1;
    counts.set(t.pumpOperatorId, entry);
  }
  return Array.from(counts.values());
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

async function countsForRole(role: (typeof INCENTIVE_ROLES)[number], plantId: string, monthStart: Date): Promise<DriverTripCount[]> {
  switch (role) {
    case "MIXER_DRIVER":
      return mixerDriverCounts(plantId, monthStart);
    case "PUMP_OPERATOR":
      return pumpOperatorCounts(plantId, monthStart);
    case "PUMP_ASSISTANT":
      return pumpAssistantCounts(plantId, monthStart);
    case "BULKER_DRIVER":
      return materialDriverCounts(plantId, monthStart, "CEMENT");
    case "WATER_TANKER_DRIVER":
      return materialDriverCounts(plantId, monthStart, "WATER");
  }
}

export default async function IncentivesPage() {
  await requirePageAccess("incentives");
  const { dict } = await getDictionary();
  const m = dict.modules.incentives;

  const plants = await prisma.plant.findMany({
    orderBy: { name: "asc" },
    include: { incentivePolicies: true },
  });

  const monthStart = new Date();
  monthStart.setDate(1);
  monthStart.setHours(0, 0, 0, 0);

  const plantResults = await Promise.all(
    plants.map(async (plant) => {
      const roleResults = await Promise.all(
        INCENTIVE_ROLES.map(async (role) => {
          const policy: IncentivePolicy =
            plant.incentivePolicies.find((p) => p.role === role) ?? DEFAULT_POLICY;
          const counts = await countsForRole(role, plant.id, monthStart);
          const ranked = rankDriversByIncentive(counts, policy);
          return { role, policy, ranked };
        }),
      );
      return { plant, roleResults };
    }),
  );

  return (
    <div className="flex flex-col gap-8">
      <header>
        <div className={ui.eyebrow}>{m.eyebrow}</div>
        <h1 className={ui.h1}>{m.title}</h1>
        <p className={ui.intro}>{m.intro}</p>
      </header>

      {plantResults.map(({ plant, roleResults }) => (
        <div key={plant.id} className="flex flex-col gap-6">
          <h2 className="font-display text-lg font-semibold">{plant.name}</h2>

          {roleResults.map(({ role, policy, ranked }) => (
            <div key={role} className="flex flex-col gap-3 border-s-2 border-border ps-4">
              <h3 className="font-display text-sm font-semibold text-ink-muted">{m.roleLabel[role]}</h3>

              <form action={updateIncentivePolicy} className={`${ui.card} flex flex-wrap items-end gap-4`}>
                <input type="hidden" name="plantId" value={plant.id} />
                <input type="hidden" name="role" value={role} />
                <div>
                  <label className={ui.label}>{m.freeTrips}</label>
                  <input
                    name="freeTripsThreshold"
                    type="number"
                    defaultValue={policy.freeTripsThreshold}
                    className="w-24 rounded-md border border-border bg-surface px-2 py-1.5 text-sm"
                  />
                </div>
                <div>
                  <label className={ui.label}>{m.tier2Threshold}</label>
                  <input
                    name="tier2Threshold"
                    type="number"
                    defaultValue={policy.tier2Threshold}
                    className="w-24 rounded-md border border-border bg-surface px-2 py-1.5 text-sm"
                  />
                </div>
                <div>
                  <label className={ui.label}>{m.tier2Rate(plant.currency)}</label>
                  <input
                    name="tier2RateSar"
                    type="number"
                    step="0.5"
                    defaultValue={policy.tier2RateSar}
                    className="w-24 rounded-md border border-border bg-surface px-2 py-1.5 text-sm"
                  />
                </div>
                <div>
                  <label className={ui.label}>{m.tier3Threshold}</label>
                  <input
                    name="tier3Threshold"
                    type="number"
                    defaultValue={policy.tier3Threshold}
                    className="w-24 rounded-md border border-border bg-surface px-2 py-1.5 text-sm"
                  />
                </div>
                <div>
                  <label className={ui.label}>{m.tier3Rate(plant.currency)}</label>
                  <input
                    name="tier3RateSar"
                    type="number"
                    step="0.5"
                    defaultValue={policy.tier3RateSar}
                    className="w-24 rounded-md border border-border bg-surface px-2 py-1.5 text-sm"
                  />
                </div>
                <div>
                  <label className={ui.label}>{m.beyondRate(plant.currency)}</label>
                  <input
                    name="beyondRateSar"
                    type="number"
                    step="0.5"
                    defaultValue={policy.beyondRateSar}
                    className="w-24 rounded-md border border-border bg-surface px-2 py-1.5 text-sm"
                  />
                </div>
                <button className="rounded-md border border-border px-3 py-1.5 text-sm hover:bg-surface-alt">
                  {dict.field.save}
                </button>
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
          ))}
        </div>
      ))}
    </div>
  );
}
