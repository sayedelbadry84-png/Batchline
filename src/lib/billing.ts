const DEFAULT_NET_DAYS = 30;

// Customer.paymentTerms is a free-text field like "Net 30" — pull the
// number out of it for a due-date calculation, falling back to a sane
// default rather than failing when a term doesn't parse ("Due on receipt",
// "COD", or something a user typed by hand).
export function parseNetDays(paymentTerms: string): number {
  const match = paymentTerms.match(/\d+/);
  return match ? Number(match[0]) : DEFAULT_NET_DAYS;
}
