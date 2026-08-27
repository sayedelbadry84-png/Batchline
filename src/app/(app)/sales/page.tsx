import Link from "next/link";
import { prisma } from "@/lib/prisma";
import { ui } from "@/lib/ui";
import { requirePageAccess } from "@/lib/session";
import { getDictionary } from "@/lib/i18n";
import { getActiveSiteId, reservationSiteScopeWhere } from "@/lib/siteScope";
import { Modal } from "@/components/Modal";
import { QuoteLineRows } from "@/components/QuoteLineRows";
import {
  createOpportunity,
  updateOpportunity,
  advanceOpportunityStage,
  promoteProspectToCustomer,
  logFieldVisit,
  createQuote,
  markQuoteSent,
  recordQuoteResponse,
} from "./actions";

const SALES_TABS = ["dashboard", "opportunities", "visits", "quotes"] as const;
type SalesTab = (typeof SALES_TABS)[number];

const OPP_STATUSES = ["NEW", "CONTACTED", "SITE_VISIT", "QUOTED", "NEGOTIATION", "WON", "LOST"] as const;
const OPP_SOURCES = ["REFERRAL", "WEBSITE", "COLD_CALL", "REPEAT_CUSTOMER", "OTHER"] as const;
const LOST_REASONS = ["PRICE", "TIMING", "COMPETITOR", "NO_BUDGET", "OTHER"] as const;
const VISIT_PURPOSES = ["INTRO", "FOLLOW_UP", "SITE_SURVEY", "COMPLAINT", "OTHER"] as const;

const oppStatusChip: Record<string, string> = {
  NEW: "bg-surface-alt text-ink-muted",
  CONTACTED: "bg-accent-soft text-accent-strong",
  SITE_VISIT: "bg-accent-soft text-accent-strong",
  QUOTED: "bg-warn-soft text-warn",
  NEGOTIATION: "bg-warn-soft text-warn",
  WON: "bg-good-soft text-good",
  LOST: "bg-critical-soft text-critical",
};
const quoteStatusChip: Record<string, string> = {
  DRAFT: "bg-surface-alt text-ink-muted",
  SENT: "bg-accent-soft text-accent-strong",
  ACCEPTED: "bg-good-soft text-good",
  DECLINED: "bg-critical-soft text-critical",
  EXPIRED: "bg-critical-soft text-critical",
};

function fmtDate(d: Date | null): string {
  if (!d) return "—";
  return new Date(d).toLocaleDateString("en-GB", { day: "2-digit", month: "2-digit", year: "numeric" });
}

export default async function SalesPage({
  searchParams,
}: {
  searchParams: Promise<{ tab?: string; edit?: string; new?: string; newVisit?: string; newQuote?: string }>;
}) {
  const user = await requirePageAccess("sales");
  const { dict } = await getDictionary();
  const m = dict.modules.sales;
  const { tab: tabRaw, edit: editId, new: newFlag, newVisit: newVisitFlag, newQuote: newQuoteFlag } = await searchParams;
  const tab: SalesTab = SALES_TABS.includes(tabRaw as SalesTab) ? (tabRaw as SalesTab) : "dashboard";
  const siteId = await getActiveSiteId(user);
  const siteScope = reservationSiteScopeWhere(siteId); // Opportunity/Quote both carry a plain siteId, same shape as Reservation

  const [sites, projects, mixes, customers, salesUsers] = await Promise.all([
    prisma.site.findMany({ where: siteId ? { id: siteId } : {}, orderBy: { code: "asc" }, select: { id: true, code: true, name: true } }),
    prisma.project.findMany({ orderBy: { name: "asc" }, include: { customer: true } }),
    prisma.mixDesign.findMany({ where: { status: "APPROVED" }, orderBy: { code: "asc" } }),
    prisma.customer.findMany({ orderBy: { legalName: "asc" } }),
    prisma.user.findMany({ where: { role: { in: ["SALES_REP", "SALES_MANAGER", "ADMIN"] } }, orderBy: { name: "asc" } }),
  ]);
  const priceEntries = await prisma.priceListEntry.findMany({ select: { customerId: true, mixId: true, pricePerM3: true } });

  const baseUrl = `/sales?tab=${tab}`;

  return (
    <div className="flex flex-col gap-8">
      <header>
        <div className={ui.eyebrow}>{m.eyebrow}</div>
        <h1 className={ui.h1}>{m.title}</h1>
        <p className={ui.intro}>{m.intro}</p>
      </header>

      <div className="no-print flex flex-wrap gap-1 border-b border-border">
        {SALES_TABS.map((t) => (
          <Link
            key={t}
            href={`/sales?tab=${t}`}
            className={`rounded-t-md px-3 py-2 text-sm ${tab === t ? "border-b-2 border-accent font-medium text-ink" : "text-ink-muted hover:text-ink"}`}
          >
            {m.tabs[t]}
          </Link>
        ))}
      </div>

      {tab === "dashboard" && (
        <DashboardTab m={m} siteScope={siteScope} />
      )}

      {tab === "opportunities" && (
        <OpportunitiesTab
          m={m}
          dict={dict}
          siteScope={siteScope}
          sites={sites}
          projects={projects}
          mixes={mixes}
          customers={customers}
          salesUsers={salesUsers}
          editId={editId}
          newFlag={newFlag}
          baseUrl={baseUrl}
        />
      )}

      {tab === "visits" && (
        <VisitsTab m={m} newVisitFlag={newVisitFlag} baseUrl={baseUrl} />
      )}

      {tab === "quotes" && (
        <QuotesTab
          m={m}
          dict={dict}
          siteScope={siteScope}
          sites={sites}
          projects={projects}
          mixes={mixes}
          customers={customers}
          priceEntries={priceEntries}
          newQuoteFlag={newQuoteFlag}
          baseUrl={baseUrl}
        />
      )}
    </div>
  );
}

async function DashboardTab({
  m,
  siteScope,
}: {
  m: Awaited<ReturnType<typeof getDictionary>>["dict"]["modules"]["sales"];
  siteScope: Record<string, unknown>;
}) {
  const [opportunities, quotes, dueVisits] = await Promise.all([
    prisma.opportunity.findMany({ where: siteScope, include: { owner: true } }),
    prisma.quote.findMany({ where: siteScope }),
    prisma.fieldVisit.findMany({
      where: { followUpDate: { lte: new Date(), not: null } },
      orderBy: { followUpDate: "asc" },
      include: { opportunity: true, customer: true },
      take: 20,
    }),
  ]);

  const funnel = Object.fromEntries(OPP_STATUSES.map((s) => [s, opportunities.filter((o) => o.status === s).length])) as Record<string, number>;
  const wonCount = funnel.WON ?? 0;
  const lostCount = funnel.LOST ?? 0;
  const closedCount = wonCount + lostCount;
  const winRate = closedCount > 0 ? (wonCount / closedCount) * 100 : null;

  const sentQuotes = quotes.filter((q) => q.status !== "DRAFT").length;
  const acceptedQuotes = quotes.filter((q) => q.status === "ACCEPTED").length;
  const quoteToOrderRatio = sentQuotes > 0 ? (acceptedQuotes / sentQuotes) * 100 : null;

  const wonOpportunities = opportunities.filter((o) => o.status === "WON");
  const leaderboardMap = new Map<string, { name: string; count: number; volume: number }>();
  for (const o of wonOpportunities) {
    const key = o.ownerId ?? "none";
    const entry = leaderboardMap.get(key) ?? { name: o.owner?.name ?? "—", count: 0, volume: 0 };
    entry.count += 1;
    entry.volume += o.estimatedVolumeM3 ?? 0;
    leaderboardMap.set(key, entry);
  }
  const leaderboard = [...leaderboardMap.values()].sort((a, b) => b.volume - a.volume);

  return (
    <div className="flex flex-col gap-6">
      <div className={ui.card}>
        <h2 className="mb-3 font-display text-lg font-semibold">{m.dashboard.funnelTitle}</h2>
        <div className="grid grid-cols-7 gap-3">
          {OPP_STATUSES.map((s) => (
            <div key={s} className="rounded-md border border-border p-3 text-center">
              <div className="font-mono text-2xl font-semibold">{funnel[s] ?? 0}</div>
              <div className="mt-1 text-xs text-ink-muted">{m.statusLabel[s]}</div>
            </div>
          ))}
        </div>
      </div>

      <div className="grid grid-cols-2 gap-6">
        <div className={ui.card}>
          <div className="text-xs text-ink-muted">{m.dashboard.winRate}</div>
          <div className="mt-1 font-mono text-3xl font-semibold">{winRate === null ? "—" : `${winRate.toFixed(0)}%`}</div>
        </div>
        <div className={ui.card}>
          <div className="text-xs text-ink-muted">{m.dashboard.quoteToOrderRatio}</div>
          <div className="mt-1 font-mono text-3xl font-semibold">{quoteToOrderRatio === null ? "—" : `${quoteToOrderRatio.toFixed(0)}%`}</div>
        </div>
      </div>

      <div className="grid grid-cols-2 gap-6">
        <div className={ui.card}>
          <h2 className="mb-3 font-display text-lg font-semibold">{m.dashboard.followUpsDueTitle}</h2>
          {dueVisits.length === 0 ? (
            <p className="text-sm text-ink-muted">{m.dashboard.followUpsDueEmpty}</p>
          ) : (
            <ul className="flex flex-col gap-2">
              {dueVisits.map((v) => (
                <li key={v.id} className="rounded-md border border-border p-2 text-sm">
                  <div className="font-medium">{v.opportunity?.opportunityNumber ?? v.customer?.legalName ?? m.visits.none}</div>
                  <div className="text-xs text-ink-muted">{fmtDate(v.followUpDate)}</div>
                </li>
              ))}
            </ul>
          )}
        </div>

        <div className={ui.card}>
          <h2 className="mb-3 font-display text-lg font-semibold">{m.dashboard.leaderboardTitle}</h2>
          <table className={ui.table}>
            <thead>
              <tr>
                <th className={ui.th}></th>
                <th className={ui.th}>{m.dashboard.leaderboardCount}</th>
                <th className={ui.th}>{m.dashboard.leaderboardVolume}</th>
              </tr>
            </thead>
            <tbody>
              {leaderboard.map((l) => (
                <tr key={l.name}>
                  <td className={`${ui.td} font-medium`}>{l.name}</td>
                  <td className={ui.td}>{l.count}</td>
                  <td className={`${ui.td} font-mono`}>{l.volume.toFixed(1)} m³</td>
                </tr>
              ))}
              {leaderboard.length === 0 && (
                <tr>
                  <td className={ui.td} colSpan={3}><span className="text-ink-muted">—</span></td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
}

async function OpportunitiesTab({
  m,
  dict,
  siteScope,
  sites,
  projects,
  mixes,
  customers,
  salesUsers,
  editId,
  newFlag,
  baseUrl,
}: {
  m: Awaited<ReturnType<typeof getDictionary>>["dict"]["modules"]["sales"];
  dict: Awaited<ReturnType<typeof getDictionary>>["dict"];
  siteScope: Record<string, unknown>;
  sites: { id: string; code: string; name: string }[];
  projects: { id: string; name: string; customer: { legalName: string } }[];
  mixes: { id: string; code: string; grade: string }[];
  customers: { id: string; code: string | null; legalName: string }[];
  salesUsers: { id: string; name: string }[];
  editId?: string;
  newFlag?: string;
  baseUrl: string;
}) {
  const opportunities = await prisma.opportunity.findMany({
    where: siteScope,
    orderBy: { createdAt: "desc" },
    include: { customer: true, project: true, mix: true, owner: true, site: true },
  });

  return (
    <div className="flex flex-col gap-4">
      <div className="no-print flex justify-end">
        <Link href={`${baseUrl}&new=1`} className={ui.button}>+ {m.opportunities.newTitle}</Link>
      </div>

      <div className={ui.card}>
        <table className={ui.table}>
          <thead>
            <tr>
              <th className={ui.th}>{m.opportunities.col.number}</th>
              <th className={ui.th}>{m.opportunities.col.customer}</th>
              <th className={ui.th}>{m.opportunities.col.project}</th>
              <th className={ui.th}>{m.opportunities.col.mix}</th>
              <th className={ui.th}>{m.opportunities.col.volume}</th>
              <th className={ui.th}>{m.opportunities.col.status}</th>
              <th className={ui.th}>{m.opportunities.col.owner}</th>
              <th className={ui.th}>{m.opportunities.col.expectedClose}</th>
              <th className={ui.th}>{dict.field.actions}</th>
            </tr>
          </thead>
          <tbody>
            {opportunities.map((o) => {
              if (editId === o.id) {
                return (
                  <tr key={o.id}>
                    <td className={ui.td} colSpan={9}>
                      <form action={updateOpportunity} className="flex flex-wrap items-end gap-2">
                        <input type="hidden" name="id" value={o.id} />
                        {!o.customerId && (
                          <>
                            <div>
                              <label className={ui.label}>{m.opportunities.f.prospectName}</label>
                              <input name="prospectName" defaultValue={o.prospectName ?? ""} className={`${ui.input} w-36`} />
                            </div>
                            <div>
                              <label className={ui.label}>{m.opportunities.f.prospectPhone}</label>
                              <input name="prospectPhone" defaultValue={o.prospectPhone ?? ""} className={`${ui.input} w-32`} dir="ltr" />
                            </div>
                          </>
                        )}
                        <div>
                          <label className={ui.label}>{m.opportunities.f.projectId}</label>
                          <select name="projectId" defaultValue={o.projectId ?? ""} className={`${ui.select} w-40`}>
                            <option value="">{m.quotes.none}</option>
                            {projects.map((p) => (
                              <option key={p.id} value={p.id}>{p.name} — {p.customer.legalName}</option>
                            ))}
                          </select>
                        </div>
                        <div>
                          <label className={ui.label}>{m.opportunities.f.mixId}</label>
                          <select name="mixId" defaultValue={o.mixId ?? ""} className={`${ui.select} w-32`}>
                            <option value="">{m.quotes.none}</option>
                            {mixes.map((mx) => (
                              <option key={mx.id} value={mx.id}>{mx.code}</option>
                            ))}
                          </select>
                        </div>
                        <div>
                          <label className={ui.label}>{m.opportunities.f.estimatedVolumeM3}</label>
                          <input name="estimatedVolumeM3" type="number" step="0.1" defaultValue={o.estimatedVolumeM3 ?? ""} className={`${ui.input} w-24`} />
                        </div>
                        <div>
                          <label className={ui.label}>{m.opportunities.f.source}</label>
                          <select name="source" defaultValue={o.source ?? ""} className={`${ui.select} w-32`}>
                            <option value="">{m.quotes.none}</option>
                            {OPP_SOURCES.map((s) => (
                              <option key={s} value={s}>{m.sourceLabel[s]}</option>
                            ))}
                          </select>
                        </div>
                        <div>
                          <label className={ui.label}>{m.opportunities.f.expectedCloseDate}</label>
                          <input name="expectedCloseDate" type="date" defaultValue={o.expectedCloseDate ? o.expectedCloseDate.toISOString().slice(0, 10) : ""} className={`${ui.input} w-36`} />
                        </div>
                        <div>
                          <label className={ui.label}>{m.opportunities.f.owner}</label>
                          <select name="ownerId" defaultValue={o.ownerId ?? ""} className={`${ui.select} w-32`}>
                            <option value="">{m.quotes.none}</option>
                            {salesUsers.map((u) => (
                              <option key={u.id} value={u.id}>{u.name}</option>
                            ))}
                          </select>
                        </div>
                        <div>
                          <label className={ui.label}>{m.opportunities.f.notes}</label>
                          <input name="notes" defaultValue={o.notes ?? ""} className={`${ui.input} w-40`} />
                        </div>
                        <button className={ui.button}>{dict.field.save}</button>
                        <Link href={`${baseUrl}`} className="rounded-md border border-border px-3 py-2 text-sm hover:bg-surface-alt">{dict.field.cancel}</Link>
                      </form>
                    </td>
                  </tr>
                );
              }
              return (
                <tr key={o.id}>
                  <td className={`${ui.td} font-mono text-xs`}>{o.opportunityNumber}</td>
                  <td className={ui.td}>
                    {o.customer ? o.customer.legalName : (
                      <>
                        {o.prospectName}
                        <span className={`${ui.chip} ms-2 bg-warn-soft text-warn`}>{m.opportunities.prospectBadge}</span>
                      </>
                    )}
                  </td>
                  <td className={ui.td}>{o.project?.name ?? "—"}</td>
                  <td className={ui.td}>{o.mix?.code ?? "—"}</td>
                  <td className={`${ui.td} font-mono`}>{o.estimatedVolumeM3?.toFixed(1) ?? "—"}</td>
                  <td className={ui.td}>
                    <span className={`${ui.chip} ${oppStatusChip[o.status] ?? ""}`}>{m.statusLabel[o.status as keyof typeof m.statusLabel] ?? o.status}</span>
                  </td>
                  <td className={ui.td}>{o.owner?.name ?? "—"}</td>
                  <td className={ui.td}>{fmtDate(o.expectedCloseDate)}</td>
                  <td className={ui.td}>
                    <div className="flex flex-col gap-1">
                      <Link href={`${baseUrl}&edit=${o.id}`} className="text-xs font-medium text-accent-strong hover:underline">{dict.field.edit}</Link>
                      {!["WON", "LOST"].includes(o.status) && (
                        <form action={advanceOpportunityStage} className="flex items-center gap-1">
                          <input type="hidden" name="id" value={o.id} />
                          <select name="status" defaultValue={o.status} className="rounded-md border border-border bg-surface px-1.5 py-1 text-xs">
                            {OPP_STATUSES.map((s) => (
                              <option key={s} value={s}>{m.statusLabel[s]}</option>
                            ))}
                          </select>
                          {/* Only consulted server-side when status=LOST is submitted (advanceOpportunityStage
                              refuses a LOST without one) — always rendered here since this plain form has no
                              client JS to show/hide it conditionally on the status select above. */}
                          <select name="lostReasonCode" defaultValue="" className="rounded-md border border-border bg-surface px-1.5 py-1 text-xs">
                            <option value="" disabled>{m.opportunities.lostReasonPlaceholder}</option>
                            {LOST_REASONS.map((r) => (
                              <option key={r} value={r}>{m.lostReasonLabel[r]}</option>
                            ))}
                          </select>
                          <button className="text-xs font-medium text-accent-strong hover:underline">{m.opportunities.advanceStage}</button>
                        </form>
                      )}
                      {!o.customerId && (
                        <form action={promoteProspectToCustomer}>
                          <input type="hidden" name="id" value={o.id} />
                          <button className="text-xs font-medium text-good hover:underline">{m.opportunities.promoteToCustomer}</button>
                        </form>
                      )}
                    </div>
                  </td>
                </tr>
              );
            })}
            {opportunities.length === 0 && (
              <tr><td className={ui.td} colSpan={9}><span className="text-ink-muted">{m.opportunities.empty}</span></td></tr>
            )}
          </tbody>
        </table>
      </div>

      {newFlag === "1" && (
        <Modal title={m.opportunities.newTitle} closeHref={baseUrl}>
          <form action={createOpportunity} className="flex flex-col gap-3">
            <div>
              <label className={ui.label}>{m.opportunities.f.customerId}</label>
              <select name="customerId" defaultValue="" className={ui.select}>
                <option value="">{m.opportunities.f.newProspect}</option>
                {customers.map((c) => (
                  <option key={c.id} value={c.id}>{c.code ? `${c.code} — ${c.legalName}` : c.legalName}</option>
                ))}
              </select>
            </div>
            <div className="grid grid-cols-3 gap-2">
              <div>
                <label className={ui.label}>{m.opportunities.f.prospectName}</label>
                <input name="prospectName" className={ui.input} />
              </div>
              <div>
                <label className={ui.label}>{m.opportunities.f.prospectPhone}</label>
                <input name="prospectPhone" className={ui.input} dir="ltr" />
              </div>
              <div>
                <label className={ui.label}>{m.opportunities.f.prospectEmail}</label>
                <input name="prospectEmail" type="email" className={ui.input} dir="ltr" />
              </div>
            </div>
            <div>
              <label className={ui.label}>{m.opportunities.f.siteId}</label>
              <select name="siteId" required className={ui.select}>
                {sites.map((s) => (
                  <option key={s.id} value={s.id}>{s.code} — {s.name}</option>
                ))}
              </select>
            </div>
            <div className="grid grid-cols-2 gap-2">
              <div>
                <label className={ui.label}>{m.opportunities.f.mixId}</label>
                <select name="mixId" defaultValue="" className={ui.select}>
                  <option value="">{m.quotes.none}</option>
                  {mixes.map((mx) => (
                    <option key={mx.id} value={mx.id}>{mx.code} — {mx.grade}</option>
                  ))}
                </select>
              </div>
              <div>
                <label className={ui.label}>{m.opportunities.f.estimatedVolumeM3}</label>
                <input name="estimatedVolumeM3" type="number" step="0.1" className={ui.input} />
              </div>
            </div>
            <div className="grid grid-cols-2 gap-2">
              <div>
                <label className={ui.label}>{m.opportunities.f.source}</label>
                <select name="source" defaultValue="" className={ui.select}>
                  <option value="">{m.quotes.none}</option>
                  {OPP_SOURCES.map((s) => (
                    <option key={s} value={s}>{m.sourceLabel[s]}</option>
                  ))}
                </select>
              </div>
              <div>
                <label className={ui.label}>{m.opportunities.f.expectedCloseDate}</label>
                <input name="expectedCloseDate" type="date" className={ui.input} />
              </div>
            </div>
            <div>
              <label className={ui.label}>{m.opportunities.f.notes}</label>
              <input name="notes" className={ui.input} />
            </div>
            <button type="submit" className={`${ui.button} mt-2`}>{m.opportunities.add}</button>
          </form>
        </Modal>
      )}
    </div>
  );
}

async function VisitsTab({
  m,
  newVisitFlag,
  baseUrl,
}: {
  m: Awaited<ReturnType<typeof getDictionary>>["dict"]["modules"]["sales"];
  newVisitFlag?: string;
  baseUrl: string;
}) {
  const [visits, opportunities, customers] = await Promise.all([
    prisma.fieldVisit.findMany({
      orderBy: { visitDate: "desc" },
      include: { opportunity: true, customer: true, visitedBy: true },
      take: 100,
    }),
    prisma.opportunity.findMany({ orderBy: { createdAt: "desc" }, select: { id: true, opportunityNumber: true, prospectName: true, customer: { select: { legalName: true } } } }),
    prisma.customer.findMany({ orderBy: { legalName: "asc" } }),
  ]);
  const now = new Date();

  return (
    <div className="flex flex-col gap-4">
      <div className="no-print flex justify-end">
        <Link href={`${baseUrl}&newVisit=1`} className={ui.button}>+ {m.visits.newTitle}</Link>
      </div>

      <div className={ui.card}>
        <table className={ui.table}>
          <thead>
            <tr>
              <th className={ui.th}>{m.visits.col.date}</th>
              <th className={ui.th}>{m.visits.col.linkedTo}</th>
              <th className={ui.th}>{m.visits.col.visitedBy}</th>
              <th className={ui.th}>{m.visits.col.purpose}</th>
              <th className={ui.th}>{m.visits.col.location}</th>
              <th className={ui.th}>{m.visits.col.followUp}</th>
            </tr>
          </thead>
          <tbody>
            {visits.map((v) => {
              const overdue = v.followUpDate && v.followUpDate <= now;
              return (
                <tr key={v.id}>
                  <td className={ui.td}>{fmtDate(v.visitDate)}</td>
                  <td className={ui.td}>{v.opportunity?.opportunityNumber ?? v.customer?.legalName ?? m.visits.none}</td>
                  <td className={ui.td}>{v.visitedBy.name}</td>
                  <td className={ui.td}>{v.purpose ? m.visits.purposeLabel[v.purpose as keyof typeof m.visits.purposeLabel] ?? v.purpose : "—"}</td>
                  <td className={ui.td}>
                    {v.locationUrl ? <a href={v.locationUrl} target="_blank" rel="noreferrer" className="text-accent-strong hover:underline">{v.locationName ?? v.locationUrl}</a> : v.locationName ?? "—"}
                  </td>
                  <td className={ui.td}>
                    {v.followUpDate ? (
                      <span className={overdue ? "font-medium text-critical" : ""}>
                        {fmtDate(v.followUpDate)}
                        {overdue && <span className={`${ui.chip} ms-2 bg-critical-soft text-critical`}>{m.visits.overdueBadge}</span>}
                      </span>
                    ) : "—"}
                  </td>
                </tr>
              );
            })}
            {visits.length === 0 && (
              <tr><td className={ui.td} colSpan={6}><span className="text-ink-muted">{m.visits.empty}</span></td></tr>
            )}
          </tbody>
        </table>
      </div>

      {newVisitFlag === "1" && (
        <Modal title={m.visits.newTitle} closeHref={baseUrl}>
          <form action={logFieldVisit} className="flex flex-col gap-3">
            <div className="grid grid-cols-2 gap-2">
              <div>
                <label className={ui.label}>{m.visits.f.opportunityId}</label>
                <select name="opportunityId" defaultValue="" className={ui.select}>
                  <option value="">{m.visits.none}</option>
                  {opportunities.map((o) => (
                    <option key={o.id} value={o.id}>{o.opportunityNumber} — {o.customer?.legalName ?? o.prospectName}</option>
                  ))}
                </select>
              </div>
              <div>
                <label className={ui.label}>{m.visits.f.customerId}</label>
                <select name="customerId" defaultValue="" className={ui.select}>
                  <option value="">{m.visits.none}</option>
                  {customers.map((c) => (
                    <option key={c.id} value={c.id}>{c.legalName}</option>
                  ))}
                </select>
              </div>
            </div>
            <div className="grid grid-cols-2 gap-2">
              <div>
                <label className={ui.label}>{m.visits.f.visitDate}</label>
                <input name="visitDate" type="datetime-local" className={ui.input} />
              </div>
              <div>
                <label className={ui.label}>{m.visits.f.purpose}</label>
                <select name="purpose" defaultValue="" className={ui.select}>
                  <option value="">{m.visits.none}</option>
                  {VISIT_PURPOSES.map((p) => (
                    <option key={p} value={p}>{m.visits.purposeLabel[p]}</option>
                  ))}
                </select>
              </div>
            </div>
            <div className="grid grid-cols-2 gap-2">
              <div>
                <label className={ui.label}>{m.visits.f.locationName}</label>
                <input name="locationName" className={ui.input} />
              </div>
              <div>
                <label className={ui.label}>{m.visits.f.locationUrl}</label>
                <input name="locationUrl" className={ui.input} dir="ltr" placeholder="https://maps.google.com/…" />
              </div>
            </div>
            <div>
              <label className={ui.label}>{m.visits.f.notes}</label>
              <textarea name="notes" required rows={3} className={ui.input} />
            </div>
            <div>
              <label className={ui.label}>{m.visits.f.followUpDate}</label>
              <input name="followUpDate" type="date" className={`${ui.input} w-48`} />
            </div>
            <button type="submit" className={`${ui.button} mt-2`}>{m.visits.add}</button>
          </form>
        </Modal>
      )}
    </div>
  );
}

async function QuotesTab({
  m,
  dict,
  siteScope,
  sites,
  projects,
  mixes,
  customers,
  priceEntries,
  newQuoteFlag,
  baseUrl,
}: {
  m: Awaited<ReturnType<typeof getDictionary>>["dict"]["modules"]["sales"];
  dict: Awaited<ReturnType<typeof getDictionary>>["dict"];
  siteScope: Record<string, unknown>;
  sites: { id: string; code: string; name: string }[];
  projects: { id: string; name: string; customer: { legalName: string } }[];
  mixes: { id: string; code: string; grade: string }[];
  customers: { id: string; code: string | null; legalName: string }[];
  priceEntries: { customerId: string; mixId: string; pricePerM3: number }[];
  newQuoteFlag?: string;
  baseUrl: string;
}) {
  const quotes = await prisma.quote.findMany({
    where: siteScope,
    orderBy: { createdAt: "desc" },
    include: { customer: true, project: true },
  });

  return (
    <div className="flex flex-col gap-4">
      <div className="no-print flex justify-end">
        <Link href={`${baseUrl}&newQuote=1`} className={ui.button}>+ {m.quotes.newTitle}</Link>
      </div>

      <div className={ui.card}>
        <table className={ui.table}>
          <thead>
            <tr>
              <th className={ui.th}>{m.quotes.col.number}</th>
              <th className={ui.th}>{m.quotes.col.customer}</th>
              <th className={ui.th}>{m.quotes.col.project}</th>
              <th className={ui.th}>{m.quotes.col.status}</th>
              <th className={ui.th}>{m.quotes.col.total}</th>
              <th className={ui.th}>{m.quotes.col.validUntil}</th>
              <th className={ui.th}>{dict.field.actions}</th>
            </tr>
          </thead>
          <tbody>
            {quotes.map((q) => (
              <tr key={q.id}>
                <td className={`${ui.td} font-mono text-xs`}>{q.quoteNumber}</td>
                <td className={ui.td}>{q.customer.legalName}</td>
                <td className={ui.td}>{q.project?.name ?? "—"}</td>
                <td className={ui.td}>
                  <span className={`${ui.chip} ${quoteStatusChip[q.status] ?? ""}`}>{m.quotes.statusLabel[q.status as keyof typeof m.quotes.statusLabel] ?? q.status}</span>
                </td>
                <td className={`${ui.td} font-mono`}>{q.total.toFixed(2)} {q.currency}</td>
                <td className={ui.td}>{fmtDate(q.validUntil)}</td>
                <td className={ui.td}>
                  <div className="flex flex-col gap-1">
                    <Link href={`/sales/quotes/${q.id}`} className="text-xs font-medium text-accent-strong hover:underline">{m.quotes.view}</Link>
                    {q.status === "DRAFT" && (
                      <form action={markQuoteSent}>
                        <input type="hidden" name="id" value={q.id} />
                        <button className="text-xs font-medium text-accent-strong hover:underline">{m.quotes.markSent}</button>
                      </form>
                    )}
                    {q.status === "SENT" && (
                      <>
                        <form action={recordQuoteResponse}>
                          <input type="hidden" name="id" value={q.id} />
                          <input type="hidden" name="response" value="ACCEPTED" />
                          <button className="text-xs font-medium text-good hover:underline">{m.quotes.accept}</button>
                        </form>
                        <form action={recordQuoteResponse}>
                          <input type="hidden" name="id" value={q.id} />
                          <input type="hidden" name="response" value="DECLINED" />
                          <button className="text-xs font-medium text-critical hover:underline">{m.quotes.decline}</button>
                        </form>
                      </>
                    )}
                  </div>
                </td>
              </tr>
            ))}
            {quotes.length === 0 && (
              <tr><td className={ui.td} colSpan={7}><span className="text-ink-muted">{m.quotes.empty}</span></td></tr>
            )}
          </tbody>
        </table>
      </div>

      {newQuoteFlag === "1" && (
        <Modal title={m.quotes.newTitle} closeHref={baseUrl}>
          <form action={createQuote} className="flex flex-col gap-3">
            <div className="grid grid-cols-2 gap-2">
              <div>
                <label className={ui.label}>{m.quotes.f.projectId}</label>
                <select name="projectId" defaultValue="" className={ui.select}>
                  <option value="">{m.quotes.none}</option>
                  {projects.map((p) => (
                    <option key={p.id} value={p.id}>{p.name} — {p.customer.legalName}</option>
                  ))}
                </select>
              </div>
              <div>
                <label className={ui.label}>{m.quotes.f.siteId}</label>
                <select name="siteId" required className={ui.select}>
                  {sites.map((s) => (
                    <option key={s.id} value={s.id}>{s.code} — {s.name}</option>
                  ))}
                </select>
              </div>
            </div>
            <div>
              <label className={ui.label}>{m.quotes.f.validUntil}</label>
              <input name="validUntil" type="date" className={`${ui.input} w-48`} />
            </div>
            <QuoteLineRows
              customers={customers}
              mixes={mixes}
              priceEntries={priceEntries}
              labels={{
                customer: m.quotes.f.customer,
                customerPlaceholder: m.quotes.f.customerPlaceholder,
                mixPlaceholder: m.quotes.f.mixPlaceholder,
                volume: m.quotes.f.volume,
                unitPrice: m.quotes.f.unitPrice,
                addAnother: m.quotes.f.addAnother,
                remove: m.quotes.f.remove,
                noPriceOnFile: m.quotes.f.noPriceOnFile,
              }}
            />
            <div>
              <label className={ui.label}>{m.quotes.f.notes}</label>
              <input name="notes" className={ui.input} />
            </div>
            <button type="submit" className={`${ui.button} mt-2`}>{m.quotes.add}</button>
          </form>
        </Modal>
      )}
    </div>
  );
}
