import "server-only";

// A field needs quoting the moment it contains a comma, a quote, or a
// newline — quoting everything else too would just make the file noisier
// to read in a plain editor for no benefit. Embedded quotes are doubled,
// the standard RFC 4180 escape.
function escapeCsvField(value: string | number): string {
  const str = String(value);
  if (/[",\n]/.test(str)) return `"${str.replace(/"/g, '""')}"`;
  return str;
}

// A leading UTF-8 BOM so Excel (which otherwise guesses the system
// codepage) renders Arabic text correctly instead of mojibake — every
// other CSV consumer just ignores it.
const UTF8_BOM = "﻿";

export function rowsToCsv(headers: string[], rows: (string | number)[][]): string {
  const lines = [headers.map(escapeCsvField).join(","), ...rows.map((row) => row.map(escapeCsvField).join(","))];
  return UTF8_BOM + lines.join("\r\n");
}
