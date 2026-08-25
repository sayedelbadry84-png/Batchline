import Link from "next/link";
import { ui } from "@/lib/ui";
import { requirePageAccess } from "@/lib/session";
import { getDictionary } from "@/lib/i18n";
import {
  aggregateIncentiveResults,
  isReachBasedRole,
  activityForRole,
  getIncentiveSiteData,
  buildSitePricingMap,
  DEFAULT_POLICY,
  INCENTIVE_ROLE_KEYS,
  type IncentivePolicy,
} from "@/lib/incentives";
import {
  updateIncentivePolicy,
  updatePumpIncentivePolicy,
  addPumpRateBracket,
  deletePumpRateBracket,
  setFlatVolumeRate,
  setIncentiveMethod,
} from "./actions";

type Dict = Awaited<ReturnType<typeof getDictionary>>["dict"];
type M = Dict["modules"]["incentives"];

function ResultCard({
  m,
  role,
  results,
}: {
  m: M;
  role: string;
  results: ReturnType<typeof aggregateIncentiveResults>;
}) {
  return (
    <div className="flex flex-col gap-3 border-s-2 border-border ps-4">
      <h3 className="font-display text-sm font-semibold text-ink-muted">{m.roleLabel[role as keyof typeof m.roleLabel]}</h3>
      <div className={ui.card}>
        <table className={ui.table}>
          <thead>
            <tr>
              <th className={ui.th}>{m.col.driver}</th>
              <th className={ui.th}>{m.col.trips}</th>
              <th className={ui.th}>{m.col.volume}</th>
              <th className={ui.th}>{m.col.plants}</th>
              <th className={ui.th}>{m.col.payout}</th>
            </tr>
          </thead>
          <tbody>
            {results.map((r) => (
              <tr key={r.id}>
                <td className={`${ui.td} font-medium`}>{r.name}</td>
                <td className={`${ui.td} font-mono tabular`}>{r.tripCount}</td>
                <td className={`${ui.td} font-mono tabular`}>{r.volumeM3.toFixed(1)}</td>
                <td className={`${ui.td} text-xs text-ink-muted`}>{r.siteNames.join(", ")}</td>
                <td className={`${ui.td} font-mono tabular`} dir="ltr">
                  {r.payoutByCurrency.length === 0
                    ? "—"
                    : r.payoutByCurrency.map((p) => `${p.amount.toLocaleString()} ${p.currency}`).join(" + ")}
                </td>
              </tr>
            ))}
            {results.length === 0 && (
              <tr><td className={ui.td} colSpan={5}><span className="text-ink-muted">{m.empty}</span></td></tr>
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

  // Policy/method configuration lives at the Plant level (Site — see the
  // UI-terminology note in schema.prisma), not the specific Station: a
  // driver isn't tied to one line, so neither is the rate that applies to
  // them.
  const siteData = await getIncentiveSiteData();

  const monthStart = new Date();
  monthStart.setDate(1);
  monthStart.setHours(0, 0, 0, 0);

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
          INCENTIVE_ROLE_KEYS.map(async (role) => {
            const entries = await activityForRole(role, monthStart);
            const sitePricing = buildSitePricingMap(siteData, role);
            const results = aggregateIncentiveResults(entries, sitePricing);
            return <ResultCard key={role} m={m} role={role} results={results} />;
          }),
        ))}

      {tab === "plan" &&
        siteData.map(({ site, effectiveMethod, currency }) => (
          <div key={site.id} className="flex flex-col gap-6">
            <h2 className="font-display text-lg font-semibold">{site.name}</h2>
            <p className="text-sm text-ink-muted">{m.planIntro}</p>

            {INCENTIVE_ROLE_KEYS.map((role) => {
              const method = effectiveMethod(role);
              const tripPolicy: IncentivePolicy = site.incentivePolicies.find((p) => p.role === role) ?? DEFAULT_POLICY;
              const volumePolicy = site.pumpIncentivePolicies.find((p) => p.role === role);
              const reachBased = isReachBasedRole(role);
              const flatRate = volumePolicy?.rateBrackets[0]?.ratePerM3Sar ?? 0;

              return (
                <div key={role} className="flex flex-col gap-3 border-s-2 border-border ps-4">
                  <h3 className="font-display text-sm font-semibold text-ink-muted">{m.roleLabel[role as keyof typeof m.roleLabel]}</h3>

                  <form action={setIncentiveMethod} className="flex items-end gap-3">
                    <input type="hidden" name="siteId" value={site.id} />
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
                      <input type="hidden" name="siteId" value={site.id} />
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
                        <label className={ui.label}>{m.tier2Rate(currency)}</label>
                        <input name="tier2RateSar" type="number" step="0.001" defaultValue={tripPolicy.tier2RateSar} className="w-24 rounded-md border border-border bg-surface px-2 py-1.5 text-sm" />
                      </div>
                      <div>
                        <label className={ui.label}>{m.tier3Threshold}</label>
                        <input name="tier3Threshold" type="number" defaultValue={tripPolicy.tier3Threshold} className="w-24 rounded-md border border-border bg-surface px-2 py-1.5 text-sm" />
                      </div>
                      <div>
                        <label className={ui.label}>{m.tier3Rate(currency)}</label>
                        <input name="tier3RateSar" type="number" step="0.001" defaultValue={tripPolicy.tier3RateSar} className="w-24 rounded-md border border-border bg-surface px-2 py-1.5 text-sm" />
                      </div>
                      <div>
                        <label className={ui.label}>{m.beyondRate(currency)}</label>
                        <input name="beyondRateSar" type="number" step="0.001" defaultValue={tripPolicy.beyondRateSar} className="w-24 rounded-md border border-border bg-surface px-2 py-1.5 text-sm" />
                      </div>
                      <button className="rounded-md border border-border px-3 py-1.5 text-sm hover:bg-surface-alt">{dict.field.save}</button>
                    </form>
                  ) : (
                    <>
                      <p className="text-xs text-ink-muted">{m.pumpIncentiveNote}</p>
                      <form action={updatePumpIncentivePolicy} className={`${ui.card} flex flex-wrap items-end gap-4`}>
                        <input type="hidden" name="siteId" value={site.id} />
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
                                  <td className={`${ui.td} font-mono tabular`} dir="ltr">{b.ratePerM3Sar} {currency}/m³</td>
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
                            <input type="hidden" name="siteId" value={site.id} />
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
                              <input name="ratePerM3Sar" type="number" step="0.001" required className="w-24 rounded-md border border-border bg-surface px-2 py-1.5 text-sm" />
                            </div>
                            <button className="rounded-md border border-border px-3 py-1.5 text-sm hover:bg-surface-alt">{m.pumpRateCol.add}</button>
                          </form>
                        </div>
                      ) : (
                        <form action={setFlatVolumeRate} className={`${ui.card} flex flex-wrap items-end gap-4`}>
                          <input type="hidden" name="siteId" value={site.id} />
                          <input type="hidden" name="role" value={role} />
                          <div>
                            <label className={ui.label}>{m.flatRate(currency)}</label>
                            <input name="ratePerM3Sar" type="number" step="0.001" defaultValue={flatRate} className="w-28 rounded-md border border-border bg-surface px-2 py-1.5 text-sm" />
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
