"use client";

import ExcelJS from "exceljs";

// A real .xlsx file (bold header row, sized columns, native Excel
// number/text types), built entirely in the browser from the same
// headers/rows every report tab already prepares for its CSV export —
// same "operate on data the page already rendered" pattern as
// CsvExportButton/PrintButton, no server round-trip. exceljs over the
// more commonly reached-for `xlsx` (SheetJS) package specifically: the
// npm `xlsx` package has an unpatched high-severity prototype-pollution/
// ReDoS advisory with no fix available, while exceljs is actively
// maintained with no unpatched vulnerability in its own write path.
export function ExcelExportButton({
  label,
  filename,
  sheetName,
  headers,
  rows,
}: {
  label: string;
  filename: string;
  sheetName: string;
  headers: string[];
  rows: (string | number)[][];
}) {
  async function handleClick() {
    const workbook = new ExcelJS.Workbook();
    // Excel rejects a sheet name over 31 characters.
    const sheet = workbook.addWorksheet(sheetName.slice(0, 31) || "Sheet1");
    sheet.addRow(headers);
    sheet.getRow(1).font = { bold: true };
    for (const row of rows) sheet.addRow(row);
    sheet.columns.forEach((col) => {
      col.width = 18;
    });

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
    <button type="button" onClick={handleClick} className="rounded-md border border-border px-3 py-1.5 text-xs hover:bg-surface-alt">
      {label}
    </button>
  );
}
