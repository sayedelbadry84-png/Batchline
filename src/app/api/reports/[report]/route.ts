import { NextRequest, NextResponse } from "next/server";
import { verifyIntegrationRequest } from "@/lib/integration-auth";
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
  const authError = await verifyIntegrationRequest(request, "REPORTS");
  if (authError) return authError;

  const { report } = await params;
  if (!isReportName(report)) {
    return NextResponse.json({ error: `Unknown report "${report}". Valid: ${Object.keys(REPORTS).join(", ")}` }, { status: 404 });
  }

  const url = new URL(request.url);
  const fromRaw = url.searchParams.get("from");
  const toRaw = url.searchParams.get("to");

  const to = toRaw ? new Date(`${toRaw}T23:59:59`) : new Date();
  const from = fromRaw ? new Date(`${fromRaw}T00:00:00`) : (() => {
    const d = new Date(to);
    d.setDate(1);
    d.setHours(0, 0, 0, 0);
    return d;
  })();

  if (Number.isNaN(from.getTime()) || Number.isNaN(to.getTime())) {
    return NextResponse.json({ error: "from/to must be valid dates (YYYY-MM-DD)." }, { status: 400 });
  }

  const data = await REPORTS[report]({ from, to });
  return NextResponse.json({ report, from: from.toISOString(), to: to.toISOString(), ...data });
}
