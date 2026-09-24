// Pure-logic tests for bank statement parsing and auto-matching
// (src/lib/bankReconciliation.ts, parseSignedMoneyToMinor in
// src/lib/money.ts). No database.
//
// The matcher used to accept any float difference up to 0.01, so a
// 10.00 statement line auto-reconciled a 10.01 payment, and the parser
// used Number() on the raw text, so "1e3", "Infinity" and "100.004" all
// became statement lines.
import { test } from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
createRequire(import.meta.url)("./setup/stubServerOnly.cjs");
const { parseSignedMoneyToMinor } = await import("../src/lib/money");
const { parseBankStatementCsv, matchBankStatementLines } = await import("../src/lib/bankReconciliation");

type Candidate = Parameters<typeof matchBankStatementLines>[1][number];

const DAY = new Date("2026-09-20T00:00:00Z");

function statement(rows: string[]): string {
  return ["date,description,reference,amount", ...rows].join("\n");
}

function candidate(id: string, amount: number, direction: "IN" | "OUT" = "IN"): Candidate {
  return { kind: "payment", id, date: DAY, direction, amount };
}

test("parseSignedMoneyToMinor converts plain, signed and thousands-separated amounts to exact minor units", () => {
  assert.equal(parseSignedMoneyToMinor("10"), 1000);
  assert.equal(parseSignedMoneyToMinor("10.5"), 1050);
  assert.equal(parseSignedMoneyToMinor("-10.01"), -1001);
  assert.equal(parseSignedMoneyToMinor(" 0.30 "), 30);
  assert.equal(parseSignedMoneyToMinor("1,234,567.89"), 123456789);
  assert.equal(parseSignedMoneyToMinor("-1,234.5"), -123450);
});

test("parseSignedMoneyToMinor rejects exponents, non-finite values, sub-minor-unit precision and malformed separators", () => {
  for (const raw of ["1e3", "Infinity", "-Infinity", "NaN", "100.004", "1,23", "12,34.00", "1,2345", "--5", "+5", "", "-", "5.", ".5", "1 000", "0x10", "١٠٠"]) {
    assert.equal(parseSignedMoneyToMinor(raw), null, `"${raw}" must be refused`);
  }
  assert.equal(parseSignedMoneyToMinor("99999999999999999999"), null, "a value beyond exact integer range must be refused, not approximated");
});

test("parseBankStatementCsv files a malformed amount as a row error instead of a statement line", () => {
  const { lines, errors } = parseBankStatementCsv(
    statement(["2026-09-20,ok,,-12.34", "2026-09-20,exp,,1e3", "2026-09-20,inf,,Infinity", "2026-09-20,third,,100.004", '2026-09-20,sep,,"1,234.50"', "2026-09-20,zero,,0.00"]),
  );
  assert.deepEqual(
    lines.map((l) => [l.description, l.amountMinor, l.amount]),
    [
      ["ok", -1234, -12.34],
      ["sep", 123450, 1234.5],
    ],
  );
  assert.deepEqual(
    errors.map((e) => e.row),
    [3, 4, 5, 7],
  );
});

test("a statement line one minor unit away from a payment is not auto-matched", () => {
  const { lines } = parseBankStatementCsv(statement(["2026-09-20,pay,,10.00"]));
  const [result] = matchBankStatementLines(lines, [candidate("p1", 10.01)]);
  assert.equal(result.match, null, "10.00 must not reconcile a 10.01 payment");

  const [below] = matchBankStatementLines(lines, [candidate("p2", 9.99)]);
  assert.equal(below.match, null, "nor a 9.99 one");
});

test("an exact amount matches, including a stored Float carrying binary residue", () => {
  const { lines } = parseBankStatementCsv(statement(["2026-09-20,pay,,10.00", "2026-09-20,dust,,0.30"]));
  const results = matchBankStatementLines(lines, [candidate("p1", 10), candidate("p2", 0.1 + 0.2)]);
  assert.equal(results[0].match?.id, "p1");
  assert.equal(results[1].match?.id, "p2", "0.1 + 0.2 is 30 minor units, the same as a 0.30 line");
});

test("direction still decides the match, and two equal candidates are left for a human", () => {
  const { lines } = parseBankStatementCsv(statement(["2026-09-20,out,,-50.00", "2026-09-20,in,,75.00"]));
  const results = matchBankStatementLines(lines, [candidate("in-50", 50, "IN"), candidate("a", 75), candidate("b", 75)]);
  assert.equal(results[0].match, null, "a money-out line never matches money in");
  assert.equal(results[1].match, null, "an ambiguous amount is not guessed");
});
