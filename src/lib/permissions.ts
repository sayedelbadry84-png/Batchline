import { prisma } from "@/lib/prisma";
import type { Dictionary } from "@/lib/i18n";

// Compiled-in default — the starting point every module has until an Admin
// changes it from the Permissions screen (see getEffectiveRoles below).
// `null` means every authenticated non-driver role.
export const MODULE_ROLES = {
  dashboard: null,
  "mix-designs": ["PLANT_OPERATOR", "QUALITY_SUPERVISOR", "ADMIN"],
  reservations: ["PLANT_OPERATOR", "ACCOUNTANT", "ADMIN", "SALES_REP", "SALES_MANAGER", "RESERVATIONS_OFFICER"],
  production: ["PLANT_OPERATOR", "QUALITY_SUPERVISOR", "ADMIN", "PLANT_MANAGER", "PLANTS_MANAGER", "OPERATIONS_MANAGER", "OPERATIONS_SUPERVISOR", "PLANT_ADMIN"],
  // Replaces the old separate "fleet" and "pumps" modules — one screen,
  // tabbed by equipment type (pumps/mixers/bulkers/water tankers/loaders).
  equipment: ["PLANT_OPERATOR", "ADMIN", "PLANT_MANAGER", "PLANTS_MANAGER", "OPERATIONS_MANAGER", "OPERATIONS_SUPERVISOR", "PLANT_ADMIN"],
  // Projects live on this same screen now — a project has no plant/site
  // of its own (see the Project model comment), it's just a customer's
  // job site, so it never needed a separate module permission from
  // "customers" once the two screens merged.
  customers: ["ACCOUNTANT", "PLANT_OPERATOR", "ADMIN"],
  // PLANT_ADMIN joins ADMIN here specifically for the HR side (attendance/
  // leave, added alongside the roster) — administrative plant-level work
  // is exactly what that role exists for.
  employees: ["ADMIN", "PLANT_ADMIN"],
  incentives: ["PLANT_OPERATOR", "ACCOUNTANT", "ADMIN"],
  plants: ["PLANT_OPERATOR", "ADMIN"],
  trips: ["PLANT_OPERATOR", "ADMIN", "PLANT_MANAGER", "PLANTS_MANAGER", "OPERATIONS_MANAGER", "OPERATIONS_SUPERVISOR", "PLANT_ADMIN"],
  quality: ["QUALITY_SUPERVISOR", "PLANT_OPERATOR", "ADMIN", "PLANT_MANAGER", "PLANTS_MANAGER", "OPERATIONS_MANAGER", "OPERATIONS_SUPERVISOR", "PLANT_ADMIN"],
  reports: ["PLANT_OPERATOR", "QUALITY_SUPERVISOR", "ACCOUNTANT", "ADMIN", "PLANT_MANAGER", "PLANTS_MANAGER", "OPERATIONS_MANAGER", "OPERATIONS_SUPERVISOR", "PLANT_ADMIN"],
  // The sales-pipeline module (opportunities/visits/quotes) — see
  // sales/actions.ts. RESERVATIONS_OFFICER gets access too: converting an
  // accepted quote line into a real Reservation (convertQuoteLineToReservation)
  // is squarely their job, even though running the pipeline itself is not.
  // PLANTS_MANAGER is here specifically for the second approval stage
  // (see approvePlantsManagerStage) — they don't create sales records,
  // only sign off on them.
  sales: ["SALES_REP", "SALES_SUPERVISOR", "SALES_MANAGER", "RESERVATIONS_OFFICER", "PLANTS_MANAGER", "ADMIN"],
  // Purchase orders/contracts against Suppliers, plus the supplier roster
  // and material catalog themselves (the old standalone "suppliers"
  // module — merged in here as a third tab since they're the same buying
  // workflow), broadened with the plant-management roster (a plant/
  // operations manager can requisition materials, not just the
  // accountant/operator who could before).
  purchasing: ["ACCOUNTANT", "PLANT_OPERATOR", "ADMIN", "PLANT_MANAGER", "PLANTS_MANAGER", "OPERATIONS_MANAGER", "OPERATIONS_SUPERVISOR", "PLANT_ADMIN"],
  // Fault tickets, preventive schedules, and the Maintenance Order pipeline
  // (technicians, spare-parts issuance/requisitions) for the equipment
  // fleet — same role set as "equipment", since it's the same operational
  // audience.
  maintenance: ["PLANT_OPERATOR", "ADMIN", "PLANT_MANAGER", "PLANTS_MANAGER", "OPERATIONS_MANAGER", "OPERATIONS_SUPERVISOR", "PLANT_ADMIN"],
  // Raw Materials (the old standalone "silos" and "material-receiving"
  // modules, plus the "stockLedger" report — merged in as three tabs since
  // they're all facets of the same physical stockpile), Spare Parts, and
  // Finished Goods — the union of all three old modules' role lists, same
  // broadening-not-narrowing reasoning as every merge this session.
  warehouses: ["PLANT_OPERATOR", "QUALITY_SUPERVISOR", "ACCOUNTANT", "ADMIN", "PLANT_MANAGER", "PLANTS_MANAGER", "OPERATIONS_MANAGER", "OPERATIONS_SUPERVISOR", "PLANT_ADMIN"],
  // Accounts payable/receivable (invoicing customers, paying suppliers —
  // the old standalone "billing" module merged in here as a tab, same
  // role set so nothing widens or narrows), cash ledger, bank
  // reconciliation — kept tight, financial data rather than an
  // operational screen.
  finance: ["ACCOUNTANT", "ADMIN"],
} as const satisfies Record<string, readonly string[] | null>;

export type ModuleKey = keyof typeof MODULE_ROLES;

// The login roles a module's access can actually be granted to — the same
// list Users offers when creating an account. DRIVER is deliberately
// excluded: drivers get their own /driver surface (see (app)/layout.tsx)
// and never see this sidebar, so there's nothing here to grant them.
export const ASSIGNABLE_ROLES = ["PLANT_OPERATOR", "QUALITY_SUPERVISOR", "ACCOUNTANT", "ADMIN"] as const;
export type AssignableRole = (typeof ASSIGNABLE_ROLES)[number];

// The real, dynamic role roster (see the Role model + /roles) — DRIVER
// stays excluded here too, same reasoning as ASSIGNABLE_ROLES above.
// ASSIGNABLE_ROLES itself is left as-is: it's still the compiled fallback
// getEffectiveRoles/getEffectiveActionRoles fall back to for a module with
// no MODULE_ROLES default and no saved RolePermission rows, and changing
// what "everyone" resolves to for old modules isn't part of this change.
// Screens that render a role *picker* (Users, Permissions) should call
// this instead of reading ASSIGNABLE_ROLES directly.
export async function getAllRoles() {
  return prisma.role.findMany({ where: { key: { not: "DRIVER" } }, orderBy: { createdAt: "asc" } });
}

// One entry per module the sidebar/permissions screen knows about — the
// single source both read from, so a module can't drift out of sync
// between "what's in the menu" and "what's editable in Permissions".
export const MODULE_NAV: { key: ModuleKey; href: string; num: string; labelKey: keyof Dictionary["nav"] }[] = [
  { key: "dashboard", href: "/", num: "00", labelKey: "dashboard" },
  { key: "mix-designs", href: "/mix-designs", num: "01", labelKey: "mixDesigns" },
  { key: "reservations", href: "/reservations", num: "02", labelKey: "reservations" },
  { key: "production", href: "/production", num: "03", labelKey: "production" },
  { key: "equipment", href: "/equipment", num: "05", labelKey: "equipment" },
  { key: "customers", href: "/customers", num: "07", labelKey: "customers" },
  { key: "employees", href: "/employees", num: "09", labelKey: "employees" },
  { key: "plants", href: "/plants", num: "10", labelKey: "plants" },
  { key: "incentives", href: "/incentives", num: "12", labelKey: "incentives" },
  { key: "sales", href: "/sales", num: "14", labelKey: "sales" },
  { key: "purchasing", href: "/purchasing", num: "15", labelKey: "purchasing" },
  { key: "maintenance", href: "/maintenance", num: "16", labelKey: "maintenance" },
  { key: "finance", href: "/finance", num: "17", labelKey: "finance" },
  { key: "warehouses", href: "/warehouses", num: "18", labelKey: "warehouses" },
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
// Shared by both requisition flows (spare parts in warehouses/actions.ts,
// raw materials in production/actions.ts's maybeAutoRequisitionMaterial)
// for who may approve one, and by the notification engine to know who to
// notify when one auto-opens — centralized here so the two never drift
// out of sync with each other.
export const REQUISITION_APPROVAL_ROLES = ["ADMIN", "PLANT_MANAGER", "PLANTS_MANAGER", "OPERATIONS_MANAGER"];

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
  // A deliberately narrower set than PURCHASING_ROLES (which can create/
  // send a PO under threshold on their own) — approving one over the
  // plant's own poApprovalThreshold is management sign-off, same
  // segregation-of-duties reasoning as Reservation's approveFinal being
  // narrower than create/edit.
  purchasing: {
    approve: ["ADMIN", "PLANT_MANAGER", "PLANTS_MANAGER", "OPERATIONS_MANAGER"],
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
