"use server";

import { prisma } from "@/lib/prisma";
import { logAudit } from "@/lib/audit";
import { getCurrentUser, requireRole } from "@/lib/session";
import { revalidatePath } from "next/cache";

const KEY_PATTERN = /^[A-Z][A-Z0-9_]*$/;

export async function createRole(formData: FormData) {
  const actor = await getCurrentUser();
  requireRole(actor, ["ADMIN"]);

  const key = String(formData.get("key") ?? "").trim().toUpperCase();
  const labelAr = String(formData.get("labelAr") ?? "").trim();
  const labelEn = String(formData.get("labelEn") ?? "").trim();
  if (!key || !labelAr || !labelEn || !KEY_PATTERN.test(key)) return;

  const existing = await prisma.role.findUnique({ where: { key } });
  if (existing) return;

  const role = await prisma.role.create({ data: { key, labelAr, labelEn, isSystem: false } });

  await logAudit({ module: "Roles", recordId: role.id, afterValue: `${key} / ${labelEn}`, reasonCode: "ROLE_CREATED" });
  revalidatePath("/roles");
}

// Labels only — key stays immutable for every role (system or custom) once
// created, since it's what User.role/RolePermission.role/ActionPermission.role
// actually store; renaming the key out from under those would silently
// strand every row already using the old value.
export async function updateRoleLabels(formData: FormData) {
  const actor = await getCurrentUser();
  requireRole(actor, ["ADMIN"]);

  const id = String(formData.get("id") ?? "");
  const labelAr = String(formData.get("labelAr") ?? "").trim();
  const labelEn = String(formData.get("labelEn") ?? "").trim();
  if (!id || !labelAr || !labelEn) return;

  const role = await prisma.role.update({ where: { id }, data: { labelAr, labelEn } });

  await logAudit({ module: "Roles", recordId: id, afterValue: `${role.key} / ${labelEn}`, reasonCode: "ROLE_LABELS_UPDATED" });
  revalidatePath("/roles");
}

export async function deleteRole(formData: FormData) {
  const actor = await getCurrentUser();
  requireRole(actor, ["ADMIN"]);

  const id = String(formData.get("id") ?? "");
  if (!id) return;

  const role = await prisma.role.findUnique({ where: { id } });
  if (!role || role.isSystem) return;

  const inUse = await prisma.user.count({ where: { role: role.key } });
  if (inUse > 0) return;

  await prisma.role.delete({ where: { id } });

  await logAudit({ module: "Roles", recordId: id, beforeValue: role.key, reasonCode: "ROLE_DELETED" });
  revalidatePath("/roles");
}
