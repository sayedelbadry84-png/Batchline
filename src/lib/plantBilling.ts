import "server-only";
import { prisma } from "@/lib/prisma";
import { resolvePlantIdForSite } from "@/lib/siteScope";

// Health audit (2026-09-10): the same four lines — resolve the site's
// plant, read it, then fall back to EGP / 0% / "VAT" — were copy-pasted
// into five commercial-document creators (supplier bills, cash
// transactions, two purchase-order paths and quotes). Every one of them
// has to agree on the defaults, because a quote priced at one default and
// an invoice raised at another do not reconcile; keeping five copies in
// step by hand is exactly the maintenance cost this consolidates away.
//
// Deliberately NOT a broader "billing service": it returns the same three
// values the call sites already computed, in the same order, with the
// same fallbacks. Nothing about behaviour changes.
export type PlantBillingDefaults = {
  currency: string;
  taxRatePct: number;
  taxLabel: string;
};

export async function resolvePlantBillingDefaults(siteId: string): Promise<PlantBillingDefaults> {
  const plantId = await resolvePlantIdForSite(siteId);
  const plant = plantId ? await prisma.plant.findUnique({ where: { id: plantId } }) : null;
  return {
    currency: plant?.currency ?? "EGP",
    taxRatePct: plant?.taxRatePct ?? 0,
    taxLabel: plant?.taxLabel ?? "VAT",
  };
}
