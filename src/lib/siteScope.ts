import "server-only";
import { prisma } from "@/lib/prisma";
import type { CurrentUser } from "@/lib/session";

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

// For models with their own plantId scalar (Reservation via project,
// Employee, Truck, Pump, MaterialReceipt, Silo, Hopper, ...).
export function plantScopeWhere(siteId: string | null) {
  return siteId ? { plant: { siteId } } : {};
}

// For models one hop further out via a project relation (Reservation,
// Invoice).
export function projectPlantScopeWhere(siteId: string | null) {
  return siteId ? { project: { plant: { siteId } } } : {};
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
