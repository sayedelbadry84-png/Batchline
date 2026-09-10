// PR4-R2-P1-01, second external-review validation round (2026-09-10):
// one place that decides what counts as a valid money input.
//
// Money columns are still Float (BL-CR-P2-02 tracks the Decimal
// migration), and the previous guard on supplier payments compared
// ROUNDED minor units while persisting the caller's raw number. A payment
// of 100.004 against a 100.00 balance therefore rounded to 10,000 minor
// units, passed the comparison, and was stored and posted to the ledger
// as 100.004 — a fraction of a halala of real, unbacked money in the
// accounts, and a bill that could never reconcile to zero.
//
// The fix is not a smarter comparison. It is refusing to accept a value
// that is not expressible in the currency at all. Validating the SUBMITTED
// TEXT rather than the parsed number is deliberate: `Number("100.004")`
// and any float arithmetic on it are already approximations, so "how many
// decimal places did the operator actually type" is a question only the
// original string can answer.
//
// Silently rounding was the other option and is worse: an operator who
// typed 100.004 gets no signal that the system recorded something else.
const MONEY_INPUT = /^\d+(\.\d{1,2})?$/;

export function parseMoneyInput(raw: FormDataEntryValue | null): number | null {
  if (typeof raw !== "string") return null;
  const trimmed = raw.trim();
  if (!MONEY_INPUT.test(trimmed)) return null;
  const amount = Number(trimmed);
  if (!Number.isFinite(amount)) return null;
  // PR4-R2 hardening note 1: the regex admits arbitrarily long digit
  // strings, and a big enough one stops being exactly representable in
  // minor units — every comparison and every sum against it would then be
  // approximate in a way no rounding policy can recover. Refuse it here
  // rather than let it into the ledger. (The Decimal migration is still
  // the durable fix; this is the boundary that must hold until then.)
  if (!Number.isSafeInteger(Math.round(amount * 100))) return null;
  return amount;
}

// Whole minor units (halalas) for exact comparison. Only ever called on a
// value that already passed parseMoneyInput, so the multiplication cannot
// be hiding a third decimal place.
export function toMinorUnits(amount: number): number {
  return Math.round(amount * 100);
}
