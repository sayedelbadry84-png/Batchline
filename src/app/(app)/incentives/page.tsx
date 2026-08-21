import { prisma } from "@/lib/prisma";
import { ui } from "@/lib/ui";
import { requirePageAccess } from "@/lib/session";
import { getDictionary } from "@/lib/i18n";
import { rankDriversByIncentive, type IncentivePolicy } from "@/lib/incentives";
import { updateIncentivePolicy } from "./actions";

const DEFAULT_POLICY: Omit<IncentivePolicy, never> = {
  freeTripsThreshold: 10,
  tier2Threshold: 15,
  tier2RateSar: 0,
  tier3Threshold: 20,
  tier3RateSar: 0,
  beyondRateSar: 20,
};

export default async function IncentivesPage() {
  await requirePageAccess("incentives");
  const { dict } = await getDictionary();
  const m = dict.modules.incentives;

  const plants = await prisma.plant.findMany({
    orderBy: { name: "asc" },
    include: { driverIncentivePolicy: true },
  });

  const monthStart = new Date();
  monthStart.setDate(1);
  monthStart.setHours(0, 0, 0, 0);

  const plantResults = await Promise.all(
    plants.map(async (plant) => {
      const policy: IncentivePolicy = plant.driverIncentivePolicy ?? DEFAULT_POLICY;

      const trips = await prisma.trip.findMany({
        where: {
          status: "CLOSED",
          batchTime: { gte: monthStart },
          driver: { plantId: plant.id },
        },
        select: { driverId: true, driver: { select: { name: true } } },
      });

      const counts = new Map<string, { driverName: string; tripCount: number }>();
      for (const t of trips) {
        const entry = counts.get(t.driverId) ?? { driverName: t.driver.name, tripCount: 0 };
        entry.tripCount += 1;
        counts.set(t.driverId, entry);
      }

      const ranked = rankDriversByIncentive(
        Array.from(counts.entries()).map(([driverId, v]) => ({ driverId, ...v })),
        policy,
      );

      return { plant, policy, ranked };
    }),
  );

  return (
    <div className="flex flex-col gap-8">
      <header>
        <div className={ui.eyebrow}>{m.eyebrow}</div>
        <h1 className={ui.h1}>{m.title}</h1>
        <p className={ui.intro}>{m.intro}</p>
      </header>

      {plantResults.map(({ plant, policy, ranked }) => (
        <div key={plant.id} className="flex flex-col gap-4">
          <h2 className="font-display text-lg font-semibold">{plant.name}</h2>

          <form action={updateIncentivePolicy} className={`${ui.card} flex flex-wrap items-end gap-4`}>
            <input type="hidden" name="plantId" value={plant.id} />
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
  );
}
