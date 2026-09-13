// The vocabulary every reports tab shares: which tabs exist, the number
// formatter, and the date-range + export bar that sits at the top of each
// one. Lifted out of page.tsx on 2026-09-12 when the per-tab markup moved
// into ./tabs — these are the only three things all of them still need
// from their old home.
import { ui } from "@/lib/ui";
import { rowsToCsv } from "@/lib/csv";
import { PrintButton } from "@/components/PrintButton";
import { WhatsAppShareButton } from "@/components/WhatsAppShareButton";
import { CsvExportButton } from "@/components/CsvExportButton";
import { ExcelExportButton } from "@/components/ExcelExportButton";
import { getDictionary } from "@/lib/i18n";
import type { DateFormatters } from "@/lib/datetime";

/**
 * What a tab needs from the page besides its own data: the dictionary, the
 * plant-zone date formatters, and the range the user picked. Bundled into
 * one prop rather than four so adding a fifth does not touch all
 * twenty-four call sites.
 *
 * `dt` holds functions, so this whole object is server-side only — a tab
 * that ever needs a Client Component passes it the `dt.timeZone` string,
 * never this (see src/lib/datetime.ts).
 */
export type ReportTabContext = {
  dict: Awaited<ReturnType<typeof getDictionary>>["dict"];
  dt: DateFormatters;
  rangeFrom: string;
  rangeTo: string;
};

export const REPORT_TABS = [
  "overview", "production", "incoming", "consumption", "incentives", "returns", "trips", "equipment", "workers", "profitability", "quality", "maintenance",
  "arAging", "apAging", "cashLedger", "salesPipeline", "quotes", "purchaseOrders", "supplierPerformance", "attendance", "leave", "payrollCost", "spareParts", "finishedGoods", "factoryPerformance",
] as const;
export type ReportTab = (typeof REPORT_TABS)[number];

export function fmt(n: number | null, digits = 1, suffix = "") {
  if (n === null || !Number.isFinite(n)) return "—";
  return `${n.toFixed(digits)}${suffix}`;
}

// Report export bar shared by every non-overview tab: date range + CSV +
// Excel + Print + WhatsApp. `message` is the pre-built plain-text summary
// for that tab. headers/rows are the same tabular data every tab already
// builds once — CSV and the real .xlsx (see ExcelExportButton) are both
// derived from it here rather than each tab building two separate exports.
export function ExportBar({
  m,
  tab,
  from,
  to,
  message,
  headers,
  rows,
  filenameBase,
}: {
  m: Awaited<ReturnType<typeof getDictionary>>["dict"]["modules"]["reports"];
  tab: ReportTab;
  from: string;
  to: string;
  message: string;
  headers?: string[];
  rows?: (string | number)[][];
  filenameBase?: string;
}) {
  const csv = headers && rows ? rowsToCsv(headers, rows) : undefined;
  return (
    <form action={`/reports`} className="no-print flex flex-wrap items-end gap-3">
      <input type="hidden" name="tab" value={tab} />
      <div>
        <label className={ui.label}>{m.dateFrom}</label>
        <input name="from" type="date" defaultValue={from} className={`${ui.input} w-40`} />
      </div>
      <div>
        <label className={ui.label}>{m.dateTo}</label>
        <input name="to" type="date" defaultValue={to} className={`${ui.input} w-40`} />
      </div>
      <button className="rounded-md border border-border px-3 py-1.5 text-xs hover:bg-surface-alt">{m.applyRange}</button>
      <div className="ms-auto flex gap-2">
        {csv && filenameBase && <CsvExportButton label={m.exportCsv} filename={`${filenameBase}.csv`} csv={csv} />}
        {headers && rows && filenameBase && (
          <ExcelExportButton label={m.exportExcel} filename={`${filenameBase}.xlsx`} sheetName={m.tabs[tab]} headers={headers} rows={rows} />
        )}
        <PrintButton label={m.exportPdf} />
        <WhatsAppShareButton label={m.sendWhatsApp} promptLabel={m.whatsAppPrompt} message={message} />
      </div>
    </form>
  );
}

