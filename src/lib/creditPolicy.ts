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
// - open commitments: every CONFIRMED or IN_PRODUCTION reservation's
//   remaining volume (requested less released, the same arithmetic as
//   getRemainingVolumeM3). REQUESTED and ON_HOLD reservations are not yet
//   commitments; they become one only through final approval, which
//   decides credit for them.
//
// Unbilled and open volumes are valued the way billing will value them:
// the customer's price list entry for the reservation's mix, plus tax.
// A ticket uses its own station's tax rate; a reservation not yet
// released, whose station is not chosen until release, uses the highest
// rate among its site's stations, so the estimate never understates. A
// commitment with no price on file cannot be valued, and the decision
// fails closed rather than counting it as zero.
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
};

export function decideCredit(input: { exposureMinor: number; proposedMinor: number; limitMinor: number; unpriced: boolean }): CreditDecision {
  const { exposureMinor, proposedMinor, limitMinor, unpriced } = input;
  const within = limitMinor > 0 && !unpriced && exposureMinor < limitMinor && exposureMinor + proposedMinor <= limitMinor;
  return { status: within ? "WITHIN_LIMIT" : "OVER_LIMIT", exposureMinor, proposedMinor, limitMinor, unpriced };
}

// What is being decided. A new booking is described by its mix, site and
// volume; an existing reservation (final approval, release) by its id,
// and its remaining volume is read in the same snapshot as everything else.
export type CreditProposal = { kind: "NEW_BOOKING"; mixId: string; siteId: string; volumeM3: number } | { kind: "RESERVATION"; reservationId: string };

type ExposureSnapshot = {
  creditLimit: number;
  invoices: { total: number; paid: number; credited: number }[];
  tickets: { mixId: string; volume: number; taxRatePct: number }[];
  reservations: { id: string; mixId: string; siteId: string; requested: number; released: number }[];
  target: { id: string; mixId: string; siteId: string; requested: number; released: number } | null;
  prices: { mixId: string; price: number }[];
  siteTax: { siteId: string; rate: number }[];
};

async function readExposure(db: Db, customerId: string, targetReservationId: string | null): Promise<ExposureSnapshot | null> {
  const locked = await db.$queryRaw<{ id: string }[]>`SELECT "id" FROM "Customer" WHERE "id" = ${customerId} FOR UPDATE`;
  if (locked.length === 0) return null;
  const rows = await db.$queryRaw<{ snapshot: ExposureSnapshot }[]>`
    SELECT json_build_object(
      'creditLimit', c."creditLimit",
      'invoices', COALESCE((
        SELECT json_agg(json_build_object(
          'total', i."total",
          'paid', (SELECT COALESCE(SUM(p."amount"), 0) FROM "Payment" p WHERE p."invoiceId" = i."id"),
          'credited', (SELECT COALESCE(SUM(n."amount"), 0) FROM "CreditNote" n WHERE n."invoiceId" = i."id")))
        FROM "Invoice" i
        WHERE i."customerId" = c."id" AND i."status" NOT IN ('DRAFT', 'CANCELLED')), '[]'::json),
      'tickets', COALESCE((
        SELECT json_agg(json_build_object(
          'mixId', r."mixId",
          'volume', COALESCE(tr."volumeDeliveredM3", t."volumeM3"),
          'taxRatePct', pl."taxRatePct"))
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
        WHERE pj."customerId" = c."id" AND r."status" IN ('CONFIRMED', 'IN_PRODUCTION')), '[]'::json),
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
      'siteTax', COALESCE((
        SELECT json_agg(json_build_object('siteId', s."siteId", 'rate', s."rate"))
        FROM (SELECT "siteId", MAX("taxRatePct") AS "rate" FROM "Plant" GROUP BY "siteId") s), '[]'::json)
    ) AS "snapshot"
    FROM "Customer" c
    WHERE c."id" = ${customerId}
  `;
  return rows[0]?.snapshot ?? null;
}

// Value of a volume of the customer's concrete, tax included, in minor
// units; null when the mix has no price on file for this customer.
function valueMinor(volumeM3: number, price: number | undefined, taxRatePct: number): number | null {
  if (price === undefined) return null;
  if (volumeM3 <= 0) return 0;
  return toMinorUnits(volumeM3 * price * (1 + taxRatePct / 100));
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
  const siteRate = new Map(snap.siteTax.map((s) => [s.siteId, s.rate]));
  let unpriced = false;
  const priced = (v: number | null) => {
    if (v === null) {
      unpriced = true;
      return 0;
    }
    return v;
  };

  let exposureMinor = 0;
  for (const inv of snap.invoices) {
    exposureMinor += toMinorUnits(invoiceAmountDue({ total: inv.total, payments: [{ amount: inv.paid }], creditNotes: [{ amount: inv.credited }] }));
  }
  for (const t of snap.tickets) {
    exposureMinor += priced(valueMinor(t.volume, priceByMix.get(t.mixId), t.taxRatePct));
  }
  for (const r of snap.reservations) {
    if (r.id === targetId) continue;
    exposureMinor += priced(valueMinor(Math.max(0, r.requested - r.released), priceByMix.get(r.mixId), siteRate.get(r.siteId) ?? 0));
  }

  let proposedMinor = 0;
  if (proposal?.kind === "NEW_BOOKING") {
    proposedMinor = priced(valueMinor(proposal.volumeM3, priceByMix.get(proposal.mixId), siteRate.get(proposal.siteId) ?? 0));
  } else if (snap.target) {
    const t = snap.target;
    proposedMinor = priced(valueMinor(Math.max(0, t.requested - t.released), priceByMix.get(t.mixId), siteRate.get(t.siteId) ?? 0));
  }

  return decideCredit({ exposureMinor, proposedMinor, limitMinor: toMinorUnits(snap.creditLimit), unpriced });
}

export async function evaluateProjectCredit(db: Db, projectId: string, proposal?: CreditProposal): Promise<CreditDecision | null> {
  const project = await db.project.findUnique({ where: { id: projectId }, select: { customerId: true } });
  if (!project) return null;
  return evaluateCustomerCredit(db, project.customerId, proposal);
}
