import type { Prisma } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { invoiceAmountDue } from "@/lib/billing";
import { toMinorUnits } from "@/lib/money";

type Db = Prisma.TransactionClient | typeof prisma;

// The ONE credit decision every path that can make a reservation
// releasable, or release against one, goes through: createReservation,
// quote conversion, the walk-in manual booking, final approval and
// release itself.
//
// The limit is a ceiling on the customer's TOTAL COMMITTED EXPOSURE (owner
// decision, PR #9), not only on what has been invoiced. It used to compare
// issued receivables alone against the limit, so a customer with nothing
// invoiced yet could hold any number of approved bookings and released
// tickets, together far above their limit. Exposure is now the sum of:
//
// - receivables: every non-draft, non-cancelled invoice's amount due
//   (invoiceAmountDue: total less payments and credit notes);
// - unbilled deliveries: every released ticket not cancelled or reversed
//   whose trip is not on an issued (non-draft, non-cancelled) invoice, at
//   its delivered volume if the trip recorded one, else its released
//   volume, exactly the volume billing will invoice;
// - open commitments: the remaining volume (requested less released, the
//   same arithmetic as getRemainingVolumeM3) of every CONFIRMED or
//   IN_PRODUCTION reservation that holds a final approval. A booking is a
//   commitment only while it carries that financial sign-off: REQUESTED
//   and ON_HOLD ones have not had it yet, and an edit that changes volume,
//   mix or project clears it (reservationEdits.ts) while leaving the
//   status as it was. Counting such an edited booking would let an edit
//   consume headroom no one approved; it counts again once final
//   approval, which decides credit for it, re-signs it. Tickets already
//   released against it keep counting as unbilled deliveries meanwhile.
//
// Unbilled and open volumes are valued the way billing will value them:
// the customer's price list entry for the reservation's mix, plus tax.
// A ticket uses its own station's tax rate; a reservation not yet
// released, whose station is not chosen until release, uses the highest
// rate among its site's ACTIVE stations (the only ones release accepts),
// so the estimate never understates for the station actually chosen.
// Valuation is at the CURRENT price list and tax rates: a later change
// revalues commitments already approved, and release re-decides with it.
//
// Anything that cannot be valued makes the decision fail closed instead
// of counting as zero ("unpriced"): no price on file, a stored price that
// is not a finite amount above zero (a zero or negative price would make
// a commitment free or subtract from exposure), any non-finite amount or
// volume, or a site with no ACTIVE station to take a tax rate from.
//
// The limit has no currency of its own, so it can only be compared with a
// sum in ONE currency. Invoices carry theirs; tickets and bookings are in
// their station's. When a customer's items span more than one currency
// the sum is meaningless, and the decision fails closed ("mixedCurrency")
// rather than adding SAR to EGP.
//
// A decision is about a PROPOSAL: the booking being created, or the
// reservation being approved or released. That reservation is taken out
// of the committed set and valued as the proposal instead, so approving
// or releasing it never counts it twice. The proposal is within the limit
// when all of these hold:
//
// - the limit is above zero (a limit of 0 is no credit: every booking for
//   that customer holds until a person approves a limit);
// - everything could be priced;
// - exposure without the proposal is under the limit;
// - exposure with the proposal is at most the limit.
//
// Compared in exact minor units, summed per item, never as floats.
//
// Consistency. Every caller passes its transaction client, and the
// Customer row is locked FOR UPDATE before anything is read, so two
// bookings or approvals for the same customer cannot both fit into the
// same headroom. The exposure itself is read in ONE statement, after the
// lock is held: an invoice issued, or a trip closed, concurrently is
// either wholly before or wholly after that statement, never half-counted
// in two separate reads.
export type CreditDecision = {
  status: "WITHIN_LIMIT" | "OVER_LIMIT";
  exposureMinor: number;
  proposedMinor: number;
  limitMinor: number;
  unpriced: boolean;
  mixedCurrency: boolean;
};

export function decideCredit(input: { exposureMinor: number; proposedMinor: number; limitMinor: number; unpriced: boolean; mixedCurrency: boolean }): CreditDecision {
  const { exposureMinor, proposedMinor, limitMinor, unpriced, mixedCurrency } = input;
  const within = limitMinor > 0 && !unpriced && !mixedCurrency && exposureMinor < limitMinor && exposureMinor + proposedMinor <= limitMinor;
  return { status: within ? "WITHIN_LIMIT" : "OVER_LIMIT", exposureMinor, proposedMinor, limitMinor, unpriced, mixedCurrency };
}

// What is being decided. A new booking is described by its mix, site and
// volume; an existing reservation (final approval, release) by its id,
// and its remaining volume is read in the same snapshot as everything else.
export type CreditProposal = { kind: "NEW_BOOKING"; mixId: string; siteId: string; volumeM3: number } | { kind: "RESERVATION"; reservationId: string };

// Numbers arrive through JSON: a stored NaN or Infinity comes back as a
// string, which num() below turns into "cannot be valued".
type JsonNumber = number | string;

type ExposureSnapshot = {
  creditLimit: JsonNumber;
  invoices: { total: JsonNumber; paid: JsonNumber; credited: JsonNumber; currency: string }[];
  tickets: { mixId: string; volume: JsonNumber; taxRatePct: JsonNumber; currency: string }[];
  reservations: { id: string; mixId: string; siteId: string; requested: JsonNumber; released: JsonNumber }[];
  target: { id: string; mixId: string; siteId: string; requested: JsonNumber; released: JsonNumber } | null;
  prices: { mixId: string; price: JsonNumber }[];
  sites: { siteId: string; rate: JsonNumber; currencies: string[] }[];
};

async function readExposure(db: Db, customerId: string, targetReservationId: string | null): Promise<ExposureSnapshot | null> {
  const locked = await db.$queryRaw<{ id: string }[]>`SELECT "id" FROM "Customer" WHERE "id" = ${customerId} FOR UPDATE`;
  if (locked.length === 0) return null;
  const rows = await db.$queryRaw<{ snapshot: ExposureSnapshot }[]>`
    SELECT json_build_object(
      'creditLimit', c."creditLimit",
      'invoices', COALESCE((
        SELECT json_agg(json_build_object(
          'total', i."total", 'currency', i."currency",
          'paid', (SELECT COALESCE(SUM(p."amount"), 0) FROM "Payment" p WHERE p."invoiceId" = i."id"),
          'credited', (SELECT COALESCE(SUM(n."amount"), 0) FROM "CreditNote" n WHERE n."invoiceId" = i."id")))
        FROM "Invoice" i
        WHERE i."customerId" = c."id" AND i."status" NOT IN ('DRAFT', 'CANCELLED')), '[]'::json),
      'tickets', COALESCE((
        SELECT json_agg(json_build_object(
          'mixId', r."mixId",
          'volume', COALESCE(tr."volumeDeliveredM3", t."volumeM3"),
          'taxRatePct', pl."taxRatePct", 'currency', pl."currency"))
        FROM "BatchTicket" t
        JOIN "Reservation" r ON r."id" = t."reservationId"
        JOIN "Project" pj ON pj."id" = r."projectId"
        JOIN "Plant" pl ON pl."id" = t."plantId"
        LEFT JOIN "Trip" tr ON tr."batchTicketId" = t."id"
        WHERE pj."customerId" = c."id"
          AND t."status" <> 'CANCELLED'
          AND t."reversedAt" IS NULL
          AND NOT EXISTS (
            SELECT 1 FROM "InvoiceLine" il JOIN "Invoice" iv ON iv."id" = il."invoiceId"
            WHERE il."tripId" = tr."id" AND iv."status" NOT IN ('DRAFT', 'CANCELLED'))), '[]'::json),
      'reservations', COALESCE((
        SELECT json_agg(json_build_object(
          'id', r."id", 'mixId', r."mixId", 'siteId', r."siteId", 'requested', r."requestedVolumeM3",
          'released', (
            SELECT COALESCE(SUM(COALESCE(tr2."volumeDeliveredM3", t2."volumeM3")), 0)
            FROM "BatchTicket" t2 LEFT JOIN "Trip" tr2 ON tr2."batchTicketId" = t2."id"
            WHERE t2."reservationId" = r."id" AND t2."status" <> 'CANCELLED')))
        FROM "Reservation" r JOIN "Project" pj ON pj."id" = r."projectId"
        WHERE pj."customerId" = c."id" AND r."status" IN ('CONFIRMED', 'IN_PRODUCTION') AND r."finalApprovedAt" IS NOT NULL), '[]'::json),
      'target', (
        SELECT json_build_object(
          'id', r."id", 'mixId', r."mixId", 'siteId', r."siteId", 'requested', r."requestedVolumeM3",
          'released', (
            SELECT COALESCE(SUM(COALESCE(tr2."volumeDeliveredM3", t2."volumeM3")), 0)
            FROM "BatchTicket" t2 LEFT JOIN "Trip" tr2 ON tr2."batchTicketId" = t2."id"
            WHERE t2."reservationId" = r."id" AND t2."status" <> 'CANCELLED'))
        FROM "Reservation" r JOIN "Project" pj ON pj."id" = r."projectId"
        WHERE r."id" = ${targetReservationId} AND pj."customerId" = c."id"),
      'prices', COALESCE((
        SELECT json_agg(json_build_object('mixId', e."mixId", 'price', e."pricePerM3"))
        FROM "PriceListEntry" e WHERE e."customerId" = c."id"), '[]'::json),
      'sites', COALESCE((
        SELECT json_agg(json_build_object('siteId', s."siteId", 'rate', s."rate", 'currencies', s."currencies"))
        FROM (
          SELECT "siteId", MAX("taxRatePct") AS "rate", array_agg(DISTINCT "currency") AS "currencies"
          FROM "Plant" WHERE "status" = 'ACTIVE' GROUP BY "siteId"
        ) s), '[]'::json)
    ) AS "snapshot"
    FROM "Customer" c
    WHERE c."id" = ${customerId}
  `;
  return rows[0]?.snapshot ?? null;
}

function num(x: JsonNumber | undefined | null): number | null {
  return typeof x === "number" && Number.isFinite(x) ? x : null;
}

// null when the customer (or the proposed reservation, for this customer)
// does not exist, which every caller treats as a refusal rather than as
// "no limit". Without a proposal, the decision is whether any headroom is
// left at all.
export async function evaluateCustomerCredit(db: Db, customerId: string, proposal?: CreditProposal): Promise<CreditDecision | null> {
  const targetId = proposal?.kind === "RESERVATION" ? proposal.reservationId : null;
  const snap = await readExposure(db, customerId, targetId);
  if (!snap) return null;
  if (targetId !== null && !snap.target) return null;

  const priceByMix = new Map(snap.prices.map((p) => [p.mixId, p.price]));
  const siteById = new Map(snap.sites.map((s) => [s.siteId, s]));
  const currencies = new Set<string>();
  let unpriced = false;

  // Value of a volume of the customer's concrete, tax included, in minor
  // units; 0 (and unpriced set) when it cannot be valued.
  const value = (volumeRaw: JsonNumber, mixId: string, taxRaw: JsonNumber | null): number => {
    const volume = num(volumeRaw);
    const price = num(priceByMix.get(mixId));
    const tax = num(taxRaw);
    if (volume === null || price === null || price <= 0 || tax === null || tax < 0) {
      unpriced = true;
      return 0;
    }
    return volume <= 0 ? 0 : toMinorUnits(volume * price * (1 + tax / 100));
  };
  // An unreleased booking's tax rate and currency come from its site's
  // ACTIVE stations; a site with none cannot be valued.
  const siteTax = (siteId: string): JsonNumber | null => {
    const site = siteById.get(siteId);
    if (!site) return null;
    for (const c of site.currencies) currencies.add(c);
    return site.rate;
  };
  const remaining = (r: { requested: JsonNumber; released: JsonNumber }): JsonNumber => {
    const requested = num(r.requested);
    const released = num(r.released);
    return requested === null || released === null ? Number.NaN : Math.max(0, requested - released);
  };

  let exposureMinor = 0;
  for (const inv of snap.invoices) {
    const total = num(inv.total);
    const paid = num(inv.paid);
    const credited = num(inv.credited);
    if (total === null || paid === null || credited === null) {
      unpriced = true;
      continue;
    }
    // Only an amount still owed is exposure, and only exposure has a
    // currency that matters here: a fully settled invoice is history, and
    // counting its currency held a customer with one paid SAR invoice and
    // an EGP booking as mixed-currency for ever (audit of 3741ff6, F1).
    const dueMinor = toMinorUnits(invoiceAmountDue({ total, payments: [{ amount: paid }], creditNotes: [{ amount: credited }] }));
    if (dueMinor <= 0) continue;
    currencies.add(inv.currency);
    exposureMinor += dueMinor;
  }
  for (const t of snap.tickets) {
    currencies.add(t.currency);
    exposureMinor += value(t.volume, t.mixId, t.taxRatePct);
  }
  // An unreleased volume at a site. A finite volume of zero or less is no
  // commitment at all, so it needs neither a price nor an active station:
  // a booking released in full whose trips have not finished used to make
  // the whole customer unpriced once its site's last station left ACTIVE,
  // although its tickets are valued on their own (audit of 3741ff6, F2).
  // A non-finite volume still fails closed in value().
  const commitment = (volumeRaw: JsonNumber, mixId: string, siteId: string): number => {
    const volume = num(volumeRaw);
    if (volume !== null && volume <= 0) return 0;
    return value(volumeRaw, mixId, siteTax(siteId));
  };
  for (const r of snap.reservations) {
    if (r.id === targetId) continue;
    exposureMinor += commitment(remaining(r), r.mixId, r.siteId);
  }

  let proposedMinor = 0;
  if (proposal?.kind === "NEW_BOOKING") {
    proposedMinor = commitment(proposal.volumeM3, proposal.mixId, proposal.siteId);
  } else if (snap.target) {
    proposedMinor = commitment(remaining(snap.target), snap.target.mixId, snap.target.siteId);
  }

  const limit = num(snap.creditLimit);
  return decideCredit({
    exposureMinor,
    proposedMinor,
    limitMinor: limit === null ? 0 : toMinorUnits(limit),
    unpriced,
    mixedCurrency: currencies.size > 1,
  });
}

export async function evaluateProjectCredit(db: Db, projectId: string, proposal?: CreditProposal): Promise<CreditDecision | null> {
  const project = await db.project.findUnique({ where: { id: projectId }, select: { customerId: true } });
  if (!project) return null;
  return evaluateCustomerCredit(db, project.customerId, proposal);
}
