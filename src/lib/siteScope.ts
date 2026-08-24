import "server-only";
import { prisma } from "@/lib/prisma";
import type { CurrentUser } from "@/lib/session";

// UI-terminology note (see the same note on the Site model in
// schema.prisma): every "site"/"plant" identifier in this file is the
// internal Prisma name, unchanged from what it's always been — Site is
// shown to users as "Plant" and Plant is shown as "Station". Nothing
// here needed renaming, only what the screens print did.
//
// Every non-ADMIN role is restricted to their own site (a site can run
// more than one production line — see Site/Plant in schema.prisma); only
// ADMIN sees every site. A non-ADMIN account with no plant assigned gets
// the fail-closed empty result (an impossible siteId), never the
// fail-open "sees everything" behavior — an unassigned account should
// never end up broader than a properly-assigned one.
const NO_SITE_SENTINEL = "__no_site_assigned__";

// null means "unrestricted" (ADMIN); any other value is the exact siteId
// every plant-scoped query below must filter to. Accepts a possibly-null
// user directly (rather than forcing every call site to `user!` after its
// own requireRole/requireActionPermission check) — an unauthenticated
// caller is just one more fail-closed case, same as an unassigned account.
export function effectiveSiteId(user: CurrentUser | null): string | null {
  if (!user) return NO_SITE_SENTINEL;
  if (user.role === "ADMIN") return null;
  return user.plant?.siteId ?? NO_SITE_SENTINEL;
}

// For models with their own plantId scalar, i.e. tied to a specific
// station (Employee, Truck, Pump, MaterialReceipt, Silo, Hopper, Invoice,
// ...) — NOT Reservation, which is booked at the Plant/Site level; see
// reservationSiteScopeWhere below for that one.
export function plantScopeWhere(siteId: string | null) {
  return siteId ? { plant: { siteId } } : {};
}

// For Reservation, which carries its own siteId scalar directly — it's
// booked against a factory (Site), not a specific station (Plant); which
// station actually produces it is chosen later, at batch-ticket release
// time (see the Reservation model comment).
export function reservationSiteScopeWhere(siteId: string | null) {
  return siteId ? { siteId } : {};
}

// For Trip and anything hanging off it (DrumReturn, TestBatch), which has
// no plantId of its own — its site is whichever plant released the batch
// ticket it's fulfilling.
export function tripPlantScopeWhere(siteId: string | null) {
  return siteId ? { batchTicket: { plant: { siteId } } } : {};
}

// Defense in depth for write actions on any model with its own plantId
// (Silo, Hopper, Employee, Truck, Pump, MaterialReceipt, ...) — the
// page's own picker already only ever lists the caller's site, but a
// write action can't rely on that alone against a crafted request naming
// a plant outside it.
export async function isPlantInScope(plantId: string, siteId: string | null): Promise<boolean> {
  if (siteId === null) return true; // ADMIN — unrestricted
  const plant = await prisma.plant.findUnique({ where: { id: plantId }, select: { siteId: true } });
  return plant?.siteId === siteId;
}

// Same defense-in-depth check as isPlantInScope, for a write action whose
// form picks a Site directly rather than a specific Plant (see
// resolvePlantIdForSite below) — sync since it needs no DB round trip.
export function isSiteInScope(requestedSiteId: string, siteId: string | null): boolean {
  return siteId === null || siteId === requestedSiteId;
}

// Resolves a chosen Site down to one concrete Plant row. Some registration
// forms (Employees, pump crew) let the operator pick by the site's code
// rather than by a specific production line — a person can work either
// line at a site interchangeably, since both share the same yard/stock
// (see the Site model comment). If the record already sits on a line at
// the requested site, that exact line is kept rather than silently moved
// to a different one within the same site; otherwise the site's first
// line (by name) is used. Returns null only if the site has no lines yet.
export async function resolvePlantIdForSite(siteId: string, keepPlantId?: string | null): Promise<string | null> {
  if (keepPlantId) {
    const current = await prisma.plant.findUnique({ where: { id: keepPlantId }, select: { siteId: true } });
    if (current?.siteId === siteId) return keepPlantId;
  }
  // Prefer an ACTIVE line as the auto-picked default; fall back to any line
  // at the site (even frozen) only if that's genuinely all it has, rather
  // than returning null and refusing the whole registration.
  const primary =
    (await prisma.plant.findFirst({ where: { siteId, status: "ACTIVE" }, orderBy: { name: "asc" } })) ??
    (await prisma.plant.findFirst({ where: { siteId }, orderBy: { name: "asc" } }));
  return primary?.id ?? null;
}

// Refuses new production/registration work aimed at a FROZEN or
// DECOMMISSIONED line — see the Plant.status comment in schema.prisma.
// Never applied to an already-existing record's own edit form (a truck
// already on file for a line that got frozen later must stay editable),
// only to picking a plant for something brand new.
export async function isPlantActive(plantId: string): Promise<boolean> {
  const plant = await prisma.plant.findUnique({ where: { id: plantId }, select: { status: true } });
  return plant?.status === "ACTIVE";
}
