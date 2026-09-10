import "server-only";
import { cookies } from "next/headers";
import { prisma } from "@/lib/prisma";
import type { CurrentUser } from "@/lib/session";
import type { Prisma } from "@prisma/client";

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

// The admin-only "which plant am I currently looking at" preference — a
// display-scope choice, never a permission. Deliberately NOT folded into
// effectiveSiteId itself: every write-action's isPlantInScope/
// isSiteInScope check must keep using effectiveSiteId as-is, since an
// admin's ability to ACT on a site must never shrink just because they
// happen to be VIEWING a different one right now. Every non-admin has no
// choice to make (effectiveSiteId already pins them to their one site), so
// this only ever reads the cookie for ADMIN. A stale cookie (a since-
// deleted site) just yields empty results everywhere it's used — fails
// safe, and self-corrects the moment the admin picks a valid site or
// clears it — so this doesn't round-trip to the database to validate it.
export const ACTIVE_SITE_COOKIE = "batchline_active_site";

export async function getActiveSiteId(user: CurrentUser | null): Promise<string | null> {
  const restricted = effectiveSiteId(user);
  if (restricted !== null) return restricted;
  const store = await cookies();
  return store.get(ACTIVE_SITE_COOKIE)?.value || null;
}

// The active site's brand color (see Site.accentColor / src/lib/
// accentColor.ts), read once from the root layout — null for a logged-
// out visitor, an ADMIN with no site picked, or a site that never set
// one, all of which just mean "use the default amber" (see globals.css).
// A stale/unassigned id from getActiveSiteId above simply finds no
// matching Site row and falls through to that same default, same
// fail-safe posture that function's own comment describes.
export async function getActiveSiteAccentColor(user: CurrentUser | null): Promise<string | null> {
  const siteId = await getActiveSiteId(user);
  if (!siteId) return null;
  const site = await prisma.site.findUnique({ where: { id: siteId }, select: { accentColor: true } });
  return site?.accentColor ?? null;
}

// For models with their own plantId scalar, i.e. tied to a specific
// station (Employee, Truck, Pump, MaterialReceipt, Silo, Hopper, Invoice,
// ...) — NOT Reservation, which is booked at the Plant/Site level; see
// reservationSiteScopeWhere below for that one. plantId, when given,
// narrows straight to that one line and wins over siteId (a specific
// station is always inside its own site, so there's nothing to combine).
export function plantScopeWhere(siteId: string | null | undefined, plantId?: string) {
  if (plantId) return { plantId };
  return siteId ? { plant: { siteId } } : {};
}

// For any model carrying its own siteId scalar — booked/owned at the
// factory (Site) level rather than at a specific station (Plant):
// Reservation, Quote, Opportunity, PurchaseOrder, SupplierBill,
// SupplierPayment. Same null-means-unrestricted (ADMIN) contract as
// plantScopeWhere above.
export function siteScopeWhere(siteId: string | null | undefined) {
  return siteId ? { siteId } : {};
}

// For Reservation, which carries its own siteId scalar directly — it's
// booked against a factory (Site), not a specific station (Plant); which
// station actually produces it is chosen later, at batch-ticket release
// time (see the Reservation model comment).
export function reservationSiteScopeWhere(siteId: string | null | undefined) {
  return siteScopeWhere(siteId);
}

// For Trip and anything hanging off it (DrumReturn, TestBatch), which has
// no plantId of its own — its site is whichever plant released the batch
// ticket it's fulfilling. Same plantId-wins-over-siteId rule as
// plantScopeWhere above.
export function tripPlantScopeWhere(siteId: string | null | undefined, plantId?: string) {
  if (plantId) return { batchTicket: { plantId } };
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

// PL-R2-P1-03, second production-lifecycle review: every lifecycle/
// dispatch domain function reads a Plant's own siteId to decide
// authorization (is this actor's allowedSiteId the same site this
// ticket/trip/resource actually belongs to right now) — but updatePlant
// (plants/actions.ts) lets an ADMIN move a Plant to a different site at
// any time, and a plain joined read of Plant.siteId (no lock) can still
// be overtaken by a concurrent transfer that commits in the gap between
// that read and this transaction's own commit. Serializable isolation
// alone does not prevent this: "operator action, then transfer" is a
// perfectly valid serial order, so both transactions can legitimately
// commit even though the operator's authorization was decided against a
// site the Plant no longer belongs to by the time it matters.
//
// Taking a real row lock here forces the two to actually serialize
// against each other — updatePlant's own `prisma.plant.update(...)` already
// takes an equivalent implicit row lock for the duration of that single
// UPDATE statement, so whichever of the two (this lock, or that update)
// reaches the row first makes the other wait until it commits, and the
// loser then sees the fresh, post-transfer siteId once it resumes. No
// change to updatePlant itself is needed — only the read side had to
// start asking for the lock.
export async function lockPlantSiteId(tx: Prisma.TransactionClient, plantId: string): Promise<string | null> {
  const rows = await tx.$queryRaw<{ siteId: string }[]>`SELECT "siteId" FROM "Plant" WHERE "id" = ${plantId} FOR UPDATE`;
  return rows[0]?.siteId ?? null;
}
