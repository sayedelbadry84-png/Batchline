import "server-only";

// Parses a bank statement CSV a user exports from their own bank/online
// banking portal and hand-arranges into a fixed 4-column shape (no bank
// publishes a common export format, so this asks for the one shape any
// spreadsheet can be reshaped into): Date, Description, Reference,
// Amount — amount positive for money in, negative for money out. First
// row is always treated as a header and skipped.
//
// A small hand-rolled RFC 4180 parser rather than a dependency: the
// format needed here is one well-known standard, not something worth a
// library for.

export type ParsedBankStatementLine = {
  date: Date;
  description: string;
  reference: string;
  amount: number; // signed: positive = IN, negative = OUT
};

export type BankStatementParseError = { row: number; message: string };

export type BankStatementParseResult = {
  lines: ParsedBankStatementLine[];
  errors: BankStatementParseError[];
};

function parseCsvRows(text: string): string[][] {
  // Strip a leading UTF-8 BOM if present (Excel adds one on export).
  const clean = text.startsWith("﻿") ? text.slice(1) : text;
  const rows: string[][] = [];
  let row: string[] = [];
  let field = "";
  let inQuotes = false;
  for (let i = 0; i < clean.length; i++) {
    const ch = clean[i];
    if (inQuotes) {
      if (ch === '"') {
        if (clean[i + 1] === '"') {
          field += '"';
          i++;
        } else {
          inQuotes = false;
        }
      } else {
        field += ch;
      }
    } else if (ch === '"') {
      inQuotes = true;
    } else if (ch === ",") {
      row.push(field);
      field = "";
    } else if (ch === "\r") {
      // swallow, \n (or end of input) closes the row
    } else if (ch === "\n") {
      row.push(field);
      rows.push(row);
      row = [];
      field = "";
    } else {
      field += ch;
    }
  }
  if (field.length > 0 || row.length > 0) {
    row.push(field);
    rows.push(row);
  }
  return rows.filter((r) => r.some((f) => f.trim() !== ""));
}

export function parseBankStatementCsv(text: string): BankStatementParseResult {
  const rows = parseCsvRows(text);
  const lines: ParsedBankStatementLine[] = [];
  const errors: BankStatementParseError[] = [];

  for (let i = 1; i < rows.length; i++) {
    const rowNumber = i + 1; // 1-based, matching what a spreadsheet shows
    const [dateRaw, description, reference, amountRaw] = rows[i];
    const date = dateRaw ? new Date(dateRaw) : null;
    const amount = amountRaw !== undefined ? Number(amountRaw.replace(/,/g, "")) : NaN;

    if (!date || Number.isNaN(date.getTime())) {
      errors.push({ row: rowNumber, message: `Unrecognized date: "${dateRaw ?? ""}"` });
      continue;
    }
    if (Number.isNaN(amount) || amount === 0) {
      errors.push({ row: rowNumber, message: `Unrecognized or zero amount: "${amountRaw ?? ""}"` });
      continue;
    }
    lines.push({ date, description: (description ?? "").trim(), reference: (reference ?? "").trim(), amount });
  }

  return { lines, errors };
}

// Candidate pool for auto-matching — one shared shape across the three
// record kinds reconcileMovement already understands, so a match result
// can point straight at whichever one it found.
export type ReconciliationCandidate = {
  kind: "payment" | "supplierPayment" | "cashTransaction";
  id: string;
  date: Date;
  direction: "IN" | "OUT";
  amount: number;
};

const AMOUNT_TOLERANCE = 0.01;
const DATE_WINDOW_DAYS = 3;

function withinWindow(a: Date, b: Date, days: number): boolean {
  return Math.abs(a.getTime() - b.getTime()) <= days * 24 * 60 * 60 * 1000;
}

// Greedy exact-amount + date-window matching: a statement line matches a
// candidate only when it's the SINGLE unambiguous fit (same direction,
// amount within a cent, date within +/-3 days) — two or more equally
// plausible candidates are left for a human to sort out rather than
// guessed at, same caution as every other "don't fabricate, disclose it"
// spot in this app. Matched candidates are removed from the pool so two
// statement lines can never both claim the same underlying record.
export function matchBankStatementLines(
  statementLines: ParsedBankStatementLine[],
  candidates: ReconciliationCandidate[],
): { line: ParsedBankStatementLine; match: ReconciliationCandidate | null }[] {
  const pool = [...candidates];
  return statementLines.map((line) => {
    const direction: "IN" | "OUT" = line.amount >= 0 ? "IN" : "OUT";
    const absAmount = Math.abs(line.amount);
    const fits = pool.filter((c) => c.direction === direction && Math.abs(c.amount - absAmount) <= AMOUNT_TOLERANCE && withinWindow(c.date, line.date, DATE_WINDOW_DAYS));
    if (fits.length !== 1) return { line, match: null };
    const match = fits[0];
    pool.splice(pool.indexOf(match), 1);
    return { line, match };
  });
}
