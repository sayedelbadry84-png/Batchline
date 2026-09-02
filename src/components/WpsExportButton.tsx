"use client";

import ExcelJS from "exceljs";

// The WPS (Wage Protection System) salary file for a payroll run — one
// sheet per site/establishment (a real submission is per legal entity, and
// this app's own markPayrollRunPaid already posts cash the same way: one
// movement per site, never blended — see that action's own comment for
// why), each sheet containing every field the Mudad SIF and every bank's
// own WPS template consistently ask for: national ID, IBAN, an itemized
// basic/allowances/deductions breakdown, and the net pay they must sum to.
// Same in-browser exceljs pattern as ExcelExportButton (see that
// component's own comment on why exceljs over `xlsx`), extended to a
// multi-sheet workbook since this file always more than one worksheet.
export function WpsExportButton({
  label,
  filename,
  sheets,
}: {
  label: string;
  filename: string;
  sheets: { sheetName: string; headers: string[]; rows: (string | number)[][] }[];
}) {
  async function handleClick() {
    const workbook = new ExcelJS.Workbook();
    for (const s of sheets) {
      // Excel rejects a sheet name over 31 characters, and a duplicate name
      // across sheets — a site code should already be short and unique, but
      // guard both anyway rather than let a write fail silently.
      const sheet = workbook.addWorksheet((s.sheetName || "Sheet").slice(0, 31));
      sheet.addRow(s.headers);
      sheet.getRow(1).font = { bold: true };
      for (const row of s.rows) sheet.addRow(row);
      sheet.columns.forEach((col) => {
        col.width = 18;
      });
    }

    const buffer = await workbook.xlsx.writeBuffer();
    const blob = new Blob([buffer], { type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
  }

  return (
    <button type="button" onClick={handleClick} className="rounded-md border border-border px-3 py-2 text-sm hover:bg-surface-alt">
      {label}
    </button>
  );
}
