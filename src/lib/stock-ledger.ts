// Fifth AI/decision-layer-style feature this session, but purely
// bookkeeping rather than predictive: a per-material stock ledger with a
// running balance, derived entirely from data the app already records — no
// new schema. Inflows are receipts that actually posted to inventory
// (mirrors the exact condition material-receiving/actions.ts uses before
// touching a silo/hopper level); outflows are completed batch tickets,
// using actual weighed mass when recorded and target mass otherwise (the
// same fallback completeBatch itself uses when deducting inventory).
export type LedgerEvent = {
  date: Date;
  type: "RECEIPT" | "CONSUMPTION";
  refLabel: string;
  quantityKg: number; // positive for a receipt, negative for consumption
};

export type LedgerEntry = LedgerEvent & { runningBalanceKg: number };

export function buildStockLedger(
  receipts: { receivedAt: Date; netWeightKg: number; poNumber: string | null; supplierName: string }[],
  consumptions: { date: Date; ticketNumber: string; massKg: number }[],
): LedgerEntry[] {
  const events: LedgerEvent[] = [
    ...receipts.map((r) => ({
      date: r.receivedAt,
      type: "RECEIPT" as const,
      refLabel: r.poNumber ? `${r.poNumber} — ${r.supplierName}` : r.supplierName,
      quantityKg: r.netWeightKg,
    })),
    ...consumptions.map((c) => ({
      date: c.date,
      type: "CONSUMPTION" as const,
      refLabel: c.ticketNumber,
      quantityKg: -c.massKg,
    })),
  ];

  events.sort((a, b) => a.date.getTime() - b.date.getTime());

  let balance = 0;
  return events.map((e) => {
    balance += e.quantityKg;
    return { ...e, runningBalanceKg: balance };
  });
}
