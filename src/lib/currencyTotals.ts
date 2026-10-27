// PM review of PR #11 (2026-10-27), P1-1: money is only ever added up
// within one currency. Batchline has SAR and EGP plants and no approved
// conversion, so a report total that spans plants is a list of per-currency
// amounts, never one number. Volumes and counts still add up across plants.
//
// Every report total that is money goes through sumByCurrency, and every
// screen, CSV cell and API field shows the list (formatByCurrency), so no
// representation can carry a cross-currency sum.

export type CurrencyAmount = { currency: string; amount: number };

export function sumByCurrency<T>(rows: readonly T[], amount: (row: T) => number, currency: (row: T) => string): CurrencyAmount[] {
  const totals = new Map<string, number>();
  for (const row of rows) {
    const c = currency(row);
    totals.set(c, (totals.get(c) ?? 0) + amount(row));
  }
  return [...totals].map(([c, a]) => ({ currency: c, amount: a })).sort((x, y) => x.currency.localeCompare(y.currency));
}

export function mergeByCurrency(...lists: CurrencyAmount[][]): CurrencyAmount[] {
  return sumByCurrency(lists.flat(), (p) => p.amount, (p) => p.currency);
}

export function negateByCurrency(list: CurrencyAmount[]): CurrencyAmount[] {
  return list.map((p) => ({ currency: p.currency, amount: -p.amount }));
}

export function amountIn(list: CurrencyAmount[], currency: string): number {
  return list.find((p) => p.currency === currency)?.amount ?? 0;
}

// "1,200.00 SAR + 3,000.00 EGP"; "0" when there is nothing. Never a sum.
export function formatByCurrency(list: CurrencyAmount[], digits = 2): string {
  const shown = list.filter((p) => p.amount !== 0);
  if (shown.length === 0) return "0";
  return shown
    .map((p) => `${p.amount.toLocaleString("en-US", { minimumFractionDigits: digits, maximumFractionDigits: digits })} ${p.currency}`)
    .join(" + ");
}

// The currencies present, sorted.
export function currenciesOf(...lists: CurrencyAmount[][]): string[] {
  return [...new Set(lists.flat().map((p) => p.currency))].sort();
}
