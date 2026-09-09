import { test } from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { readdirSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { join } from "node:path";
createRequire(import.meta.url)("./setup/stubServerOnly.cjs");
const { parseNetDays } = await import("../src/lib/billing");
const { detectAnomalies } = await import("../src/lib/anomaly");
const { safeEqual } = await import("../src/lib/integration-auth");
const { matchingTotpStep } = await import("../src/lib/totp");
const { canPerformAction, ACTION_LIST } = await import("../src/lib/permissions");

test("an unregistered permission action fails closed without a database", async () => {
  assert.equal(await canPerformAction("ACCOUNTANT", "finance", "misspelledAction"), false);
  assert.equal(await canPerformAction("ADMIN", "finance", "toString"), false);
});

test("every literal Server Action permission gate names a registered action", () => {
  const app = fileURLToPath(new URL("../src/app/", import.meta.url));
  const registered = new Set(ACTION_LIST.map(a => `${a.moduleKey}/${a.actionKey}`));
  const missing: string[] = [];
  for (const file of readdirSync(app, { recursive: true }) as string[]) {
    if (!file.endsWith(".ts") && !file.endsWith(".tsx")) continue;
    const source = readFileSync(join(app, file), "utf8");
    for (const match of source.matchAll(/requireActionPermission\([^,]+,\s*"([^"]+)",\s*"([^"]+)"/g)) {
      if (!registered.has(`${match[1]}/${match[2]}`)) missing.push(`${file}: ${match[1]}/${match[2]}`);
    }
  }
  assert.deepEqual(missing, []);
});

for (const [terms, expected] of [
  ["Net 30", 30], ["net45", 45], ["2/10 Net 30", 30], ["1/15 Net 45", 45],
  ["COD", 0], ["Due on receipt", 0], ["30", 30], ["", 30],
  ["صافي ٤٥", 45], ["عند الاستلام", 0], ["2/10", 30], ["Net 999999999999999999", 30],
] as const) {
  test(`payment terms ${JSON.stringify(terms)} -> ${expected}`, () => assert.equal(parseNetDays(terms), expected));
}

function anomalies(values: number[]) {
  return detectAnomalies(new Map([["cement", { materialName: "Cement", samples: values.map((deviationPct, i) => ({
    deviationPct, completedAt: new Date(i * 1000), ticketNumber: `B${i}`,
  })) }]]));
}
test("a recent extreme reading does not inflate its own baseline", () => {
  const flags = anomalies([-.1, .1, -.1, .1, 0, 0, 0, 0, 0, 20]);
  assert.ok(flags.some(f => f.type === "OUTLIER" && f.ticketNumber === "B9"));
});
test("flat history still detects a later jump, but flat data does not alert", () => {
  assert.ok(anomalies([0, 0, 0, 0, 0, 0, 0, 0, 0, 20]).some(f => f.type === "OUTLIER"));
  assert.deepEqual(anomalies(Array(10).fill(0)), []);
  assert.deepEqual(anomalies([0, 0, 0, 0, 20]), []); // insufficient historical baseline
});
test("a sustained recent shift produces a drift signal", () => {
  assert.ok(anomalies([-.1, .1, -.1, .1, 0, .4, .4, .4, .4, .4]).some(f => f.type === "DRIFT" && f.direction === "OVER"));
});
test("secret comparison handles unequal UTF-8 lengths and wrong values", () => {
  assert.equal(safeEqual("abc", "abc"), true);
  assert.equal(safeEqual("abc", "abd"), false);
  assert.equal(safeEqual("abc", "ab"), false);
  assert.equal(safeEqual("آ", "aa"), false);
});
test("TOTP rejects malformed codes without consuming a step", () => {
  for (const code of ["", "12345", "1234567", "12x456"]) assert.equal(matchingTotpStep("GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ", code), null);
});
test("ExcelJS export/import remains compatible with its patched uuid dependency", async () => {
  const { default: ExcelJS } = await import("exceljs");
  const book = new ExcelJS.Workbook();
  const sheet = book.addWorksheet("Review");
  sheet.addRows([["Invoice", "Amount"], ["INV-1", 115]]);
  sheet.addConditionalFormatting({ ref: "B2:B2", rules: [{ type: "dataBar", priority: 1, cfvo: [{ type: "min" }, { type: "max" }], gradient: false }] });
  const buffer = await book.xlsx.writeBuffer();
  const read = new ExcelJS.Workbook();
  await read.xlsx.load(buffer);
  assert.equal(read.getWorksheet("Review")?.getCell("B2").value, 115);
});
