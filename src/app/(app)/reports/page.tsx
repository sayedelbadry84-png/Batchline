import Link from "next/link";
import { prisma } from "@/lib/prisma";
import { ui } from "@/lib/ui";
import { requirePageAccess } from "@/lib/session";
import { getDictionary } from "@/lib/i18n";
import {
  getProductionReport,
  getIncomingReport,
  getConsumptionReport,
  getReturnsReport,
  getTripsReport,
  getEquipmentProductivityReport,
  getWorkerProductivityReport,
  getProfitabilityReport,
  getQualityReport,
  getMaintenanceReport,
  getArAgingReport,
  getApAgingReport,
  getCashLedgerReport,
  getSalesPipelineReport,
  getQuotesReport,
  getPurchaseOrdersReport,
  getSupplierPerformanceReport,
  getAttendanceReport,
  getLeaveReport,
  getPayrollCostReport,
  getSparePartsReport,
  getFinishedGoodsReport,
  getFactoryPerformanceReport,
} from "@/lib/reportQueries";
import {
  INCENTIVE_ROLE_KEYS,
  type IncentiveRoleKey,
} from "@/lib/incentives";
import { effectiveSiteId, getActiveSiteId } from "@/lib/siteScope";
import { REPORT_TABS, type ReportTab } from "./reportUi";
import { getIncentivesReport } from "./incentivesReport";
import { getOverviewReport } from "./overviewReport";
import { ProductionTab } from "./tabs/ProductionTab";
import { IncomingTab } from "./tabs/IncomingTab";
import { ConsumptionTab } from "./tabs/ConsumptionTab";
import { ProfitabilityTab } from "./tabs/ProfitabilityTab";
import { QualityTab } from "./tabs/QualityTab";
import { MaintenanceTab } from "./tabs/MaintenanceTab";
import { ArAgingTab } from "./tabs/ArAgingTab";
import { ApAgingTab } from "./tabs/ApAgingTab";
import { CashLedgerTab } from "./tabs/CashLedgerTab";
import { SalesPipelineTab } from "./tabs/SalesPipelineTab";
import { QuotesTab } from "./tabs/QuotesTab";
import { PurchaseOrdersTab } from "./tabs/PurchaseOrdersTab";
import { SupplierPerformanceTab } from "./tabs/SupplierPerformanceTab";
import { AttendanceTab } from "./tabs/AttendanceTab";
import { LeaveTab } from "./tabs/LeaveTab";
import { PayrollCostTab } from "./tabs/PayrollCostTab";
import { SparePartsTab } from "./tabs/SparePartsTab";
import { FinishedGoodsTab } from "./tabs/FinishedGoodsTab";
import { FactoryPerformanceTab } from "./tabs/FactoryPerformanceTab";
import { ReturnsTab } from "./tabs/ReturnsTab";
import { TripsTab } from "./tabs/TripsTab";
import { EquipmentTab } from "./tabs/EquipmentTab";
import { WorkersTab } from "./tabs/WorkersTab";
import { IncentivesTab } from "./tabs/IncentivesTab";
import { OverviewTab } from "./tabs/OverviewTab";
import { getDateFormatters, getDisplayTimeZone } from "@/lib/displayTimeZone";
import { isIsoDay, zonedIsoDay } from "@/lib/plantDay";
import { incentiveVisibility } from "@/lib/incentives";

export default async function ReportsPage({
  searchParams,
}: {
  searchParams: Promise<{ tab?: string; from?: string; to?: string; site?: string; plant?: string; role?: string }>;
}) {
  const user = await requirePageAccess("reports");
  const dt = await getDateFormatters();
  const { dict } = await getDictionary();
  const m = dict.modules.reports;
  const { tab: tabRaw, from: fromRaw, to: toRaw, site: siteIdRaw, plant: plantIdRaw, role: roleRaw } = await searchParams;
  const tab: ReportTab = (REPORT_TABS as readonly string[]).includes(tabRaw ?? "") ? (tabRaw as ReportTab) : "overview";
  // Sub-tab within Worker Productivity — one job at a time (mixer driver,
  // pump operator, ...) instead of every role blended into one table,
  // same INCENTIVE_ROLE_KEYS the Incentives tab already groups by.
  const workerRole: IncentiveRoleKey = (INCENTIVE_ROLE_KEYS as readonly string[]).includes(roleRaw ?? "")
    ? (roleRaw as IncentiveRoleKey)
    : INCENTIVE_ROLE_KEYS[0];

  // Every role sees only its own site, except ADMIN (restrictedSiteId ===
  // null means unrestricted) — and for ADMIN, "its own site" now means
  // whatever they've picked in the sidebar's global plant selector (see
  // getActiveSiteId in src/lib/siteScope.ts), same as every other screen.
  // Non-admins can't override this via the ?site= query param — the site
  // dropdown is locked below; only the line (plant) sub-filter within it
  // stays a free choice. Site rolls up every line at that site combined;
  // a specific line narrows further to just its own numbers.
  const restrictedSiteId = await getActiveSiteId(user);
  const sites = await prisma.site.findMany({
    where: restrictedSiteId ? { id: restrictedSiteId } : {},
    orderBy: { name: "asc" },
    include: { plants: { orderBy: { name: "asc" } } },
  });
  const siteId = restrictedSiteId ?? (sites.some((s) => s.id === siteIdRaw) ? siteIdRaw : undefined);
  const plantId = siteId && sites.find((s) => s.id === siteId)?.plants.some((p) => p.id === plantIdRaw) ? plantIdRaw : undefined;
  const scope = { siteId, plantId };

  // Audit 2026-10-26 P1-C: the range is two calendar days. Each report
  // applies each plant's own local day to them (see reportWindows in
  // reportQueries.ts); "today" and "the 1st" default to the page's display
  // zone, the plant clock every timestamp on this page is shown in. An
  // invalid ?from/?to falls back to the default instead of becoming an
  // Invalid Date.
  const todayIso = zonedIsoDay(new Date(), await getDisplayTimeZone());
  const defaultFrom = `${todayIso.slice(0, 8)}01`;
  const rangeFrom = isIsoDay(fromRaw) ? fromRaw : defaultFrom;
  const rangeTo = isIsoDay(toRaw) ? toRaw : todayIso;
  const days = { fromDay: rangeFrom, toDay: rangeTo };

  const overview = tab === "overview" ? await getOverviewReport(scope) : null;

  // --- Data for the non-overview report tabs, only fetched for whichever
  // tab is actually open. ---
  const production = tab === "production" ? await getProductionReport({ ...days, ...scope }) : null;
  const incoming = tab === "incoming" ? await getIncomingReport({ ...days, ...scope }) : null;
  const consumption = tab === "consumption" ? await getConsumptionReport({ ...days, ...scope }) : null;
  const returnsData = tab === "returns" ? await getReturnsReport({ ...days, ...scope }) : null;
  const tripsData = tab === "trips" ? await getTripsReport({ ...days, ...scope }) : null;
  // PM review 2026-10-27 P1-2: an unrestricted viewer (ADMIN) sees each
  // asset's full cross-plant total with its per-plant breakdown; a
  // site-pinned role sees only its own site's contribution, and the tab
  // labels it as such. Same rule for incentives below.
  const siteRestricted = effectiveSiteId(user);
  const equipmentData = tab === "equipment" ? await getEquipmentProductivityReport(siteRestricted === null ? days : { ...days, siteId: siteRestricted }) : null;
  const equipmentScope = siteRestricted === null ? "company" : "site";
  const workersData = tab === "workers" ? await getWorkerProductivityReport({ ...days, ...scope }) : null;
  const profitability = tab === "profitability" ? await getProfitabilityReport({ ...days, ...scope }) : null;
  const qualityData = tab === "quality" ? await getQualityReport({ ...days, ...scope }) : null;
  // No plantId narrowing — see getMaintenanceReport's own comment.
  const maintenanceData = tab === "maintenance" ? await getMaintenanceReport({ ...days, siteId }) : null;

  // --- Finance, Sales, Purchasing, Warehouses — site-only scope, no
  // plantId narrowing (see each query function's own comment for why). ---
  const arAgingData = tab === "arAging" ? await getArAgingReport({ ...days, ...scope }) : null;
  const apAgingData = tab === "apAging" ? await getApAgingReport({ ...days, siteId }) : null;
  const cashLedgerData = tab === "cashLedger" ? await getCashLedgerReport({ ...days, siteId }) : null;
  const salesPipelineData = tab === "salesPipeline" ? await getSalesPipelineReport({ ...days, siteId }) : null;
  const quotesData = tab === "quotes" ? await getQuotesReport({ ...days, siteId }) : null;
  const purchaseOrdersData = tab === "purchaseOrders" ? await getPurchaseOrdersReport({ ...days, siteId }) : null;
  const supplierPerformanceData = tab === "supplierPerformance" ? await getSupplierPerformanceReport({ ...days, siteId }) : null;
  // --- Employees — scoped through Employee.plantId, so both siteId and
  // plantId apply here, same as the production-side reports above. ---
  const attendanceData = tab === "attendance" ? await getAttendanceReport({ ...days, ...scope }) : null;
  const leaveData = tab === "leave" ? await getLeaveReport({ ...days, ...scope }) : null;
  const payrollCostData = tab === "payrollCost" ? await getPayrollCostReport({ ...days, ...scope }) : null;
  const sparePartsData = tab === "spareParts" ? await getSparePartsReport({ ...days, siteId }) : null;
  const finishedGoodsData = tab === "finishedGoods" ? await getFinishedGoodsReport({ ...days, siteId }) : null;
  const factoryPerformanceData = tab === "factoryPerformance" ? await getFactoryPerformanceReport({ ...days, ...scope }) : null;

  const incentivesData = tab === "incentives" ? await getIncentivesReport(rangeFrom, rangeTo, incentiveVisibility(siteRestricted)) : null;

  // Everything a tab needs beyond its own data. Built once and handed to
  // each of them, so a new shared value is added here rather than at
  // twenty-four call sites.
  const ctx = { dict, dt, rangeFrom, rangeTo };

  const tabLabels: Record<ReportTab, string> = {
    overview: m.tabs.overview,
    production: m.tabs.production,
    incoming: m.tabs.incoming,
    consumption: m.tabs.consumption,
    incentives: m.tabs.incentives,
    returns: m.tabs.returns,
    trips: m.tabs.trips,
    equipment: m.tabs.equipment,
    workers: m.tabs.workers,
    profitability: m.tabs.profitability,
    quality: m.tabs.quality,
    maintenance: m.tabs.maintenance,
    arAging: m.tabs.arAging,
    apAging: m.tabs.apAging,
    cashLedger: m.tabs.cashLedger,
    salesPipeline: m.tabs.salesPipeline,
    quotes: m.tabs.quotes,
    purchaseOrders: m.tabs.purchaseOrders,
    supplierPerformance: m.tabs.supplierPerformance,
    attendance: m.tabs.attendance,
    leave: m.tabs.leave,
    payrollCost: m.tabs.payrollCost,
    spareParts: m.tabs.spareParts,
    finishedGoods: m.tabs.finishedGoods,
    factoryPerformance: m.tabs.factoryPerformance,
  };

  return (
    <div className="flex flex-col gap-8">
      <header>
        <div className={ui.eyebrow}>{m.eyebrow}</div>
        <h1 className={ui.h1}>{m.title}</h1>
        <p className={ui.intro}>{m.intro}</p>
      </header>

      <form action="/reports" className="no-print flex flex-wrap items-end gap-3">
        <input type="hidden" name="tab" value={tab} />
        <input type="hidden" name="from" value={rangeFrom} />
        <input type="hidden" name="to" value={rangeTo} />
        {restrictedSiteId === null ? (
          <div>
            <label className={ui.label}>{m.siteFilter}</label>
            <select name="site" defaultValue={siteId ?? ""} className={`${ui.select} w-48`}>
              <option value="">{m.allSites}</option>
              {sites.map((s) => (
                <option key={s.id} value={s.id}>{s.name}</option>
              ))}
            </select>
          </div>
        ) : (
          // Locked to the caller's own site — no cross-site browsing for
          // non-admin roles. Kept as a hidden field so the line sub-filter
          // below still round-trips through the same form submit.
          <input type="hidden" name="site" value={siteId ?? ""} />
        )}
        {restrictedSiteId !== null && (
          <div>
            <label className={ui.label}>{m.siteFilter}</label>
            <div className={`${ui.input} w-48 flex items-center text-ink-muted`}>
              {sites.find((s) => s.id === siteId)?.name ?? "—"}
            </div>
          </div>
        )}
        {siteId && (
          <div>
            <label className={ui.label}>{m.lineFilter}</label>
            <select name="plant" defaultValue={plantId ?? ""} className={`${ui.select} w-40`}>
              <option value="">{m.wholeSite}</option>
              {sites.find((s) => s.id === siteId)?.plants.map((p) => (
                <option key={p.id} value={p.id}>{p.name}</option>
              ))}
            </select>
          </div>
        )}
        <button className="rounded-md border border-border px-3 py-1.5 text-xs hover:bg-surface-alt">{m.applyScope}</button>
        {tab !== "equipment" && tab !== "incentives" && (siteId || plantId) && <p className="text-xs text-ink-muted">{m.scopeNote}</p>}
        {tab === "equipment" && <p className="text-xs text-ink-muted">{m.equipmentScopeNote}</p>}
        {tab === "incentives" && <p className="text-xs text-ink-muted">{m.incentivesScopeNote}</p>}
      </form>
      {tab === "overview" && !siteId && <p className="no-print text-xs text-ink-muted">{m.overviewScopeNote}</p>}

      <div className="no-print flex flex-wrap gap-1 border-b border-border">
        {REPORT_TABS.map((t) => (
          <Link
            key={t}
            href={`/reports?tab=${t}${siteId ? `&site=${siteId}` : ""}${plantId ? `&plant=${plantId}` : ""}${fromRaw ? `&from=${fromRaw}` : ""}${toRaw ? `&to=${toRaw}` : ""}`}
            className={`rounded-t-md px-3 py-2 text-sm ${
              tab === t ? "border-b-2 border-accent font-medium text-ink" : "text-ink-muted hover:text-ink"
            }`}
          >
            {tabLabels[t]}
          </Link>
        ))}
      </div>

      {tab === "overview" && overview && <OverviewTab overview={overview} ctx={ctx} />}

      {tab === "production" && production && <ProductionTab production={production} ctx={ctx} />}

      {tab === "incoming" && incoming && <IncomingTab incoming={incoming} ctx={ctx} />}

      {tab === "consumption" && consumption && <ConsumptionTab consumption={consumption} ctx={ctx} />}

      {tab === "profitability" && profitability && <ProfitabilityTab profitability={profitability} ctx={ctx} />}

      {tab === "quality" && qualityData && <QualityTab qualityData={qualityData} ctx={ctx} />}

      {tab === "maintenance" && maintenanceData && <MaintenanceTab maintenanceData={maintenanceData} ctx={ctx} />}

      {tab === "arAging" && arAgingData && <ArAgingTab arAgingData={arAgingData} ctx={ctx} />}

      {tab === "apAging" && apAgingData && <ApAgingTab apAgingData={apAgingData} ctx={ctx} />}

      {tab === "cashLedger" && cashLedgerData && <CashLedgerTab cashLedgerData={cashLedgerData} ctx={ctx} />}

      {tab === "salesPipeline" && salesPipelineData && <SalesPipelineTab salesPipelineData={salesPipelineData} ctx={ctx} />}

      {tab === "quotes" && quotesData && <QuotesTab quotesData={quotesData} ctx={ctx} />}

      {tab === "purchaseOrders" && purchaseOrdersData && <PurchaseOrdersTab purchaseOrdersData={purchaseOrdersData} ctx={ctx} />}

      {tab === "supplierPerformance" && supplierPerformanceData && <SupplierPerformanceTab supplierPerformanceData={supplierPerformanceData} ctx={ctx} />}

      {tab === "attendance" && attendanceData && <AttendanceTab attendanceData={attendanceData} ctx={ctx} />}

      {tab === "leave" && leaveData && <LeaveTab leaveData={leaveData} ctx={ctx} />}

      {tab === "payrollCost" && payrollCostData && <PayrollCostTab payrollCostData={payrollCostData} ctx={ctx} />}

      {tab === "spareParts" && sparePartsData && <SparePartsTab sparePartsData={sparePartsData} ctx={ctx} />}

      {tab === "finishedGoods" && finishedGoodsData && <FinishedGoodsTab finishedGoodsData={finishedGoodsData} ctx={ctx} />}

      {tab === "factoryPerformance" && factoryPerformanceData && <FactoryPerformanceTab factoryPerformanceData={factoryPerformanceData} ctx={ctx} />}

      {tab === "returns" && returnsData && <ReturnsTab returnsData={returnsData} ctx={ctx} />}

      {tab === "trips" && tripsData && <TripsTab tripsData={tripsData} ctx={ctx} />}

      {tab === "equipment" && equipmentData && <EquipmentTab equipmentData={equipmentData} scope={equipmentScope} ctx={ctx} />}

      {tab === "workers" && workersData && <WorkersTab workersData={workersData} ctx={ctx} workerRole={workerRole} siteId={siteId} plantId={plantId} fromRaw={fromRaw} toRaw={toRaw} />}

      {tab === "incentives" && incentivesData && <IncentivesTab incentivesData={incentivesData} ctx={ctx} />}
    </div>
  );
}
