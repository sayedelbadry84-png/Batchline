// Single source of truth for "which roles can see this module" — used by
// the Sidebar (hides links) and by each page (actually enforces it, since a
// hidden link doesn't stop someone from typing the URL). `null` means every
// authenticated non-driver role.
export const MODULE_ROLES = {
  dashboard: null,
  "mix-designs": ["PLANT_OPERATOR", "QUALITY_SUPERVISOR", "ADMIN"],
  reservations: ["PLANT_OPERATOR", "ACCOUNTANT", "ADMIN"],
  production: ["PLANT_OPERATOR", "QUALITY_SUPERVISOR", "ADMIN"],
  "material-receiving": ["PLANT_OPERATOR", "QUALITY_SUPERVISOR", "ADMIN"],
  fleet: ["PLANT_OPERATOR", "ADMIN"],
  silos: ["PLANT_OPERATOR", "ADMIN"],
  customers: ["ACCOUNTANT", "PLANT_OPERATOR", "ADMIN"],
  suppliers: ["ACCOUNTANT", "PLANT_OPERATOR", "ADMIN"],
  projects: ["PLANT_OPERATOR", "ACCOUNTANT", "ADMIN"],
  employees: ["ADMIN"],
  pumps: ["PLANT_OPERATOR", "ADMIN"],
  plants: ["PLANT_OPERATOR", "ADMIN"],
  billing: ["ACCOUNTANT", "ADMIN"],
  trips: ["PLANT_OPERATOR", "ADMIN"],
  quality: ["QUALITY_SUPERVISOR", "PLANT_OPERATOR", "ADMIN"],
  reports: ["PLANT_OPERATOR", "QUALITY_SUPERVISOR", "ACCOUNTANT", "ADMIN"],
} as const satisfies Record<string, readonly string[] | null>;

export type ModuleKey = keyof typeof MODULE_ROLES;

export function canAccessModule(role: string, moduleKey: ModuleKey): boolean {
  const allowed = MODULE_ROLES[moduleKey];
  return allowed === null || (allowed as readonly string[]).includes(role);
}
