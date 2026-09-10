// PR4-R2-P1-01: what the currency will and will not accept.
import { test } from "node:test";
import assert from "node:assert/strict";
import { parseMoneyInput, toMinorUnits } from "../src/lib/money";

test("only amounts expressible in the currency are accepted", () => {
  assert.equal(parseMoneyInput("100"), 100);
  assert.equal(parseMoneyInput("100.5"), 100.5);
  assert.equal(parseMoneyInput("100.50"), 100.5);
  assert.equal(parseMoneyInput(" 0.30 "), 0.3);
  assert.equal(parseMoneyInput("0"), 0);
});

test("a fraction of a minor unit is refused, never silently rounded", () => {
  // The exact value that used to round past the balance check and then be
  // persisted and posted in full.
  assert.equal(parseMoneyInput("100.004"), null);
  assert.equal(parseMoneyInput("100.005"), null);
  assert.equal(parseMoneyInput("0.001"), null);
});

test("nothing that is not a plain decimal amount is accepted", () => {
  for (const bad of ["", "   ", "abc", "1e3", "-5", "1,000.00", "NaN", "Infinity", "100.", ".5", "0x10"]) {
    assert.equal(parseMoneyInput(bad), null, `${JSON.stringify(bad)} must not parse as money`);
  }
  assert.equal(parseMoneyInput(null), null);
});

test("minor units are exact for values the parser accepts", () => {
  assert.equal(toMinorUnits(100), 10000);
  assert.equal(toMinorUnits(0.3), 30);
  assert.equal(toMinorUnits(0.1 + 0.2), 30, "the classic float sum still lands on the right halala");
  assert.equal(toMinorUnits(8.32), 832);
  assert.equal(toMinorUnits(100.5), 10050);
});
