"use server";

import { prisma } from "@/lib/prisma";
import { logAudit } from "@/lib/audit";
import { getCurrentUser, requireRole } from "@/lib/session";
import { ASSIGNABLE_ROLES, MODULE_KEYS, ACTION_LIST, type ModuleKey } from "@/lib/permissions";
import { revalidatePath } from "next/cache";

// Full-replace, not a diff — a module's checkbox row always submits its
// complete set of checked roles, so this just becomes the new truth for
// that module rather than trying to reconcile individual add/remove clicks.
export async function saveModulePermissions(formData: FormData) {
  const user = await getCurrentUser();
  requireRole(user, ["ADMIN"]);

  const moduleKey = String(formData.get("moduleKey") ?? "");
  if (!MODULE_KEYS.includes(moduleKey as ModuleKey)) return;

  const roles = formData
    .getAll("roles")
    .map(String)
    .filter((r): r is (typeof ASSIGNABLE_ROLES)[number] => (ASSIGNABLE_ROLES as readonly string[]).includes(r));

  // Refused, not clamped to "at least ADMIN" — a silent substitution would
  // be more surprising than just not saving; the UI already warns before
  // this ever gets submitted.
  if (roles.length === 0) return;

  await prisma.$transaction([
    prisma.rolePermission.deleteMany({ where: { moduleKey } }),
    prisma.rolePermission.createMany({ data: roles.map((role) => ({ moduleKey, role })) }),
  ]);

  await logAudit({
    module: "Permissions",
    recordId: moduleKey,
    afterValue: roles.join(","),
    reasonCode: "MODULE_PERMISSIONS_UPDATED",
  });

  revalidatePath("/permissions");
  // Every open page's sidebar reads getAccessibleModules on next
  // navigation — no per-user cache to bust beyond the layout itself.
  revalidatePath("/", "layout");
}

// Same full-replace shape as saveModulePermissions, one action-key row at
// a time — see ACTION_ROLES in src/lib/permissions.ts for what this
// actually gates.
export async function saveActionPermissions(formData: FormData) {
  const user = await getCurrentUser();
  requireRole(user, ["ADMIN"]);

  const moduleKey = String(formData.get("moduleKey") ?? "");
  const actionKey = String(formData.get("actionKey") ?? "");
  if (!ACTION_LIST.some((a) => a.moduleKey === moduleKey && a.actionKey === actionKey)) return;

  const roles = formData
    .getAll("roles")
    .map(String)
    .filter((r): r is (typeof ASSIGNABLE_ROLES)[number] => (ASSIGNABLE_ROLES as readonly string[]).includes(r));

  if (roles.length === 0) return;

  await prisma.$transaction([
    prisma.actionPermission.deleteMany({ where: { moduleKey, actionKey } }),
    prisma.actionPermission.createMany({ data: roles.map((role) => ({ moduleKey, actionKey, role })) }),
  ]);

  await logAudit({
    module: "Permissions",
    recordId: `${moduleKey}:${actionKey}`,
    afterValue: roles.join(","),
    reasonCode: "ACTION_PERMISSIONS_UPDATED",
  });

  revalidatePath("/permissions");
}
