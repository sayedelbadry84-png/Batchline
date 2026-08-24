import { prisma } from "@/lib/prisma";
import type { Dictionary } from "@/lib/i18n";

// Compiled-in default — the starting point every module has until an Admin
// changes it from the Permissions screen (see getEffectiveRoles below).
// `null` means every authenticated non-driver role.
export const MODULE_ROLES = {
  dashboard: null,
  "mix-designs": ["PLANT_OPERATOR", "QUALITY_SUPERVISOR", "ADMIN"],
  reservations: ["PLANT_OPERATOR", "ACCOUNTANT", "ADMIN"],
  production: ["PLANT_OPERATOR", "QUALITY_SUPERVISOR", "ADMIN"],
  "material-receiving": ["PLANT_OPERATOR", "QUALITY_SUPERVISOR", "ADMIN"],
  // Replaces the old separate "fleet" and "pumps" modules — one screen,
  // tabbed by equipment type (pumps/mixers/bulkers/water tankers/loaders).
  equipment: ["PLANT_OPERATOR", "ADMIN"],
  silos: ["PLANT_OPERATOR", "ADMIN"],
  stockLedger: ["PLANT_OPERATOR", "ACCOUNTANT", "ADMIN"],
  // Projects live on this same screen now — a project has no plant/site
  // of its own (see the Project model comment), it's just a customer's
  // job site, so it never needed a separate module permission from
  // "customers" once the two screens merged.
  customers: ["ACCOUNTANT", "PLANT_OPERATOR", "ADMIN"],
  suppliers: ["ACCOUNTANT", "PLANT_OPERATOR", "ADMIN"],
  employees: ["ADMIN"],
  incentives: ["PLANT_OPERATOR", "ACCOUNTANT", "ADMIN"],
  plants: ["PLANT_OPERATOR", "ADMIN"],
  billing: ["ACCOUNTANT", "ADMIN"],
  trips: ["PLANT_OPERATOR", "ADMIN"],
  quality: ["QUALITY_SUPERVISOR", "PLANT_OPERATOR", "ADMIN"],
  reports: ["PLANT_OPERATOR", "QUALITY_SUPERVISOR", "ACCOUNTANT", "ADMIN"],
} as const satisfies Record<string, readonly string[] | null>;

export type ModuleKey = keyof typeof MODULE_ROLES;

// The login roles a module's access can actually be granted to — the same
// list Users offers when creating an account. DRIVER is deliberately
// excluded: drivers get their own /driver surface (see (app)/layout.tsx)
// and never see this sidebar, so there's nothing here to grant them.
export const ASSIGNABLE_ROLES = ["PLANT_OPERATOR", "QUALITY_SUPERVISOR", "ACCOUNTANT", "ADMIN"] as const;
export type AssignableRole = (typeof ASSIGNABLE_ROLES)[number];

// One entry per module the sidebar/permissions screen knows about — the
// single source both read from, so a module can't drift out of sync
// between "what's in the menu" and "what's editable in Permissions".
export const MODULE_NAV: { key: ModuleKey; href: string; num: string; labelKey: keyof Dictionary["nav"] }[] = [
  { key: "dashboard", href: "/", num: "00", labelKey: "dashboard" },
  { key: "mix-designs", href: "/mix-designs", num: "01", labelKey: "mixDesigns" },
  { key: "reservations", href: "/reservations", num: "02", labelKey: "reservations" },
  { key: "production", href: "/production", num: "03", labelKey: "production" },
  { key: "material-receiving", href: "/material-receiving", num: "04", labelKey: "materialReceiving" },
  { key: "equipment", href: "/equipment", num: "05", labelKey: "equipment" },
  { key: "silos", href: "/silos", num: "06", labelKey: "silos" },
  { key: "customers", href: "/customers", num: "07", labelKey: "customers" },
  { key: "suppliers", href: "/suppliers", num: "08", labelKey: "suppliers" },
  { key: "employees", href: "/employees", num: "09", labelKey: "employees" },
  { key: "plants", href: "/plants", num: "10", labelKey: "plants" },
  { key: "billing", href: "/billing", num: "11", labelKey: "billing" },
  { key: "incentives", href: "/incentives", num: "12", labelKey: "incentives" },
  { key: "stockLedger", href: "/stock-ledger", num: "13", labelKey: "stockLedger" },
  // "users" is deliberately absent — like Permissions, it's hard-locked to
  // ADMIN in Sidebar.tsx and /users/page.tsx directly, never routed through
  // this database-editable system, so it can never be granted to another
  // role from the Permissions screen.
];

export const VIEW_NAV: { key: ModuleKey; href: string; labelKey: keyof Dictionary["nav"] }[] = [
  { key: "trips", href: "/trips", labelKey: "trips" },
  { key: "quality", href: "/quality", labelKey: "quality" },
  { key: "reports", href: "/reports", labelKey: "reports" },
];

export const MODULE_KEYS = Object.keys(MODULE_ROLES) as ModuleKey[];

// Any row on file for a module wins outright — an Admin's saved choice,
// even an unusual one, is authoritative. A module with zero rows (the
// common case: nobody has touched Permissions yet) falls back to its
// compiled-in MODULE_ROLES default above, translating `null` ("everyone")
// to the full ASSIGNABLE_ROLES list since that's every role that could ever
// see this sidebar in the first place.
export async function getEffectiveRoles(moduleKey: ModuleKey): Promise<readonly string[]> {
  const rows = await prisma.rolePermission.findMany({ where: { moduleKey } });
  if (rows.length > 0) return rows.map((r) => r.role);
  const defaults = MODULE_ROLES[moduleKey];
  return defaults === null ? ASSIGNABLE_ROLES : defaults;
}

export async function canAccessModule(role: string, moduleKey: ModuleKey): Promise<boolean> {
  const allowed = await getEffectiveRoles(moduleKey);
  return allowed.includes(role);
}

// Used by the (app) layout to compute the sidebar's link list once per
// request — Sidebar itself is a Client Component and can't reach the
// database, so this runs server-side and the result is passed down as a
// plain prop.
export async function getAccessibleModules(role: string): Promise<ModuleKey[]> {
  const allKeys = [...MODULE_NAV.map((m) => m.key), ...VIEW_NAV.map((v) => v.key)];
  const checks = await Promise.all(allKeys.map(async (key) => [key, await canAccessModule(role, key)] as const));
  return checks.filter(([, ok]) => ok).map(([key]) => key);
}

// --- Per-action permissions (ActionPermission) ---------------------------
// A finer-grained sibling of the module-level system above: gates one
// specific action within a module rather than the whole screen — e.g. a
// PLANT_OPERATOR can create and edit a reservation, but only an Admin can
// give it final sign-off. Deliberately NOT applied to every action in the
// app (that would mean retrofitting 40+ server actions for marginal
// value) — wired into the handful of actions within Reservations and
// Production where different people genuinely need different rights,
// mirroring RhinoMaster's own example of splitting "create/edit a
// booking" from "assign pumps" and "approve" within one module.
export const ACTION_ROLES = {
  reservations: {
    create: ["PLANT_OPERATOR", "ACCOUNTANT", "ADMIN"],
    edit: ["PLANT_OPERATOR", "ACCOUNTANT", "ADMIN"],
    approveInitial: ["PLANT_OPERATOR", "ADMIN"],
    approveFinal: ["ADMIN"],
  },
  production: {
    release: ["PLANT_OPERATOR", "ADMIN"],
    manualBooking: ["PLANT_OPERATOR", "ADMIN"],
    complete: ["PLANT_OPERATOR", "ADMIN"],
    deleteTicket: ["PLANT_OPERATOR", "ADMIN"],
  },
} as const satisfies Record<string, Record<string, readonly string[]>>;

export type ActionModuleKey = keyof typeof ACTION_ROLES;

// Flat list the Permissions screen renders — every (module, action) pair
// this system knows about, with a plain string label built from the
// module's own nav label plus the action's own short label (see
// ACTION_LABEL_KEY below) rather than a whole second i18n tree.
export const ACTION_LIST: { moduleKey: ActionModuleKey; actionKey: string }[] = Object.entries(ACTION_ROLES).flatMap(
  ([moduleKey, actions]) => Object.keys(actions).map((actionKey) => ({ moduleKey: moduleKey as ActionModuleKey, actionKey })),
);

export async function getEffectiveActionRoles(moduleKey: ActionModuleKey, actionKey: string): Promise<readonly string[]> {
  const rows = await prisma.actionPermission.findMany({ where: { moduleKey, actionKey } });
  if (rows.length > 0) return rows.map((r) => r.role);
  const moduleDefaults: Record<string, readonly string[]> = ACTION_ROLES[moduleKey];
  return moduleDefaults[actionKey] ?? ASSIGNABLE_ROLES;
}

export async function canPerformAction(role: string, moduleKey: ActionModuleKey, actionKey: string): Promise<boolean> {
  const allowed = await getEffectiveActionRoles(moduleKey, actionKey);
  return allowed.includes(role);
}
