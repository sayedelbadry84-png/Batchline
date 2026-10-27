import { NextRequest, NextResponse } from "next/server";
import { verifyIntegrationRequest } from "@/lib/integration-auth";
import { prisma } from "@/lib/prisma";
import { isIsoDay } from "@/lib/plantDay";
import {
  getProductionReport,
  getIncomingReport,
  getConsumptionReport,
  getReturnsReport,
  getTripsReport,
  getEquipmentProductivityReport,
  getWorkerProductivityReport,
} from "@/lib/reportQueries";

// Read-only outbound surface for external BI/ERP systems to pull the same
// report data the Reports module shows on screen and offers as CSV — see
// the /integrations screen for issuing a REPORTS-scoped key. Kept as one
// dynamic route rather than 7 files since every report here is the same
// shape of call: validate the report name, resolve a date range, run the
// matching reportQueries.ts function, return it as JSON.
//
// Example: GET /api/reports/production?from=2026-08-01&to=2026-08-31
// Authorization: Bearer <REPORTS-scoped API key>
const REPORTS = {
  production: getProductionReport,
  incoming: getIncomingReport,
  consumption: getConsumptionReport,
  returns: getReturnsReport,
  trips: getTripsReport,
  equipment: getEquipmentProductivityReport,
  workers: getWorkerProductivityReport,
} as const;

type ReportName = keyof typeof REPORTS;

function isReportName(value: string): value is ReportName {
  return value in REPORTS;
}

export async function GET(request: NextRequest, { params }: { params: Promise<{ report: string }> }) {
  const principal = await verifyIntegrationRequest(request, "REPORTS");
  if (principal instanceof NextResponse) return principal;

  const { report } = await params;
  if (!isReportName(report)) {
    return NextResponse.json({ error: `Unknown report "${report}". Valid: ${Object.keys(REPORTS).join(", ")}` }, { status: 404 });
  }

  const url = new URL(request.url);
  const fromRaw = url.searchParams.get("from");
  const toRaw = url.searchParams.get("to");

  // Audit 2026-10-26 P1-C: from/to are calendar days, applied as each
  // plant's own local day (see reportWindows). They used to be parsed as
  // server-zone instants, and "to" ended at 23:59:59. Defaults: today and
  // the 1st of this month, in UTC — an API caller has no display clock, so
  // it should pass both days explicitly.
  if ((fromRaw && !isIsoDay(fromRaw)) || (toRaw && !isIsoDay(toRaw))) {
    return NextResponse.json({ error: "from/to must be valid calendar days (YYYY-MM-DD)." }, { status: 400 });
  }
  const toDay = toRaw ?? new Date().toISOString().slice(0, 10);
  const fromDay = fromRaw ?? `${toDay.slice(0, 8)}01`;
  if (fromDay > toDay) return NextResponse.json({ error: "from must not be after to." }, { status: 400 });

  // Optional scope — a site rolls up every production line at that site
  // combined, a plant (line) id narrows to just one line's own numbers.
  // Unset means every site, same as the on-screen "All sites" default.
  const requestedSite = url.searchParams.get("site");
  if (!principal.global && requestedSite && requestedSite !== principal.siteId) return NextResponse.json({ error: "Site not permitted." }, { status: 403 });
  const siteId = principal.global ? requestedSite ?? undefined : principal.siteId!;
  const plantId = url.searchParams.get("plant") ?? undefined;
  if (!principal.global && plantId && !(await prisma.plant.findFirst({ where: { id: plantId, siteId: principal.siteId! }, select: { id: true } }))) {
    return NextResponse.json({ error: "Plant not permitted." }, { status: 403 });
  }

  const data = await REPORTS[report]({ fromDay, toDay, siteId, plantId });
  return NextResponse.json({ report, from: fromDay, to: toDay, siteId: siteId ?? null, plantId: plantId ?? null, ...data });
}
