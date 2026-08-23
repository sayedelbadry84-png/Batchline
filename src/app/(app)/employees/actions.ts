"use server";

import { prisma } from "@/lib/prisma";
import { logAudit } from "@/lib/audit";
import { getCurrentUser, requireRole } from "@/lib/session";
import { effectiveSiteId, isSiteInScope, resolvePlantIdForSite } from "@/lib/siteScope";
import { logTransferIfChanged } from "@/lib/transferAudit";
import { revalidatePath } from "next/cache";

export async function createEmployee(formData: FormData) {
  const user = await getCurrentUser();
  requireRole(user, ["ADMIN"]);

  const siteId = String(formData.get("siteId") ?? "");
  const name = String(formData.get("name") ?? "").trim();
  const role = String(formData.get("role") ?? "").trim();
  const code = String(formData.get("code") ?? "").trim() || null;
  const licenseExpiryRaw = String(formData.get("licenseExpiry") ?? "");
  const shiftPattern = String(formData.get("shiftPattern") ?? "").trim();

  if (!siteId || !name || !role) return;
  if (!isSiteInScope(siteId, effectiveSiteId(user))) return;
  const plantId = await resolvePlantIdForSite(siteId);
  if (!plantId) return;

  const employee = await prisma.employee.create({
    data: {
      plantId,
      name,
      role,
      code,
      shiftPattern,
      licenseExpiry: licenseExpiryRaw ? new Date(licenseExpiryRaw) : null,
    },
  });

  await logAudit({ module: "Employees", recordId: employee.id, afterValue: name, reasonCode: "EMPLOYEE_CREATED" });
  revalidatePath("/employees");
}

// Status (ACTIVE/FROZEN/REMOVED — "removed" never a real row delete, same
// non-destructive convention as User.status) and site transfer both go
// through this one edit form, same as every other equipment/roster screen
// in this app — no separate freeze/remove/transfer actions needed.
export async function updateEmployee(formData: FormData) {
  const user = await getCurrentUser();
  requireRole(user, ["ADMIN"]);

  const id = String(formData.get("id") ?? "");
  const siteId = String(formData.get("siteId") ?? "");
  const name = String(formData.get("name") ?? "").trim();
  const role = String(formData.get("role") ?? "").trim();
  const code = String(formData.get("code") ?? "").trim() || null;
  const licenseExpiryRaw = String(formData.get("licenseExpiry") ?? "");
  const shiftPattern = String(formData.get("shiftPattern") ?? "").trim();
  const status = String(formData.get("status") ?? "ACTIVE");

  if (!id || !siteId || !name || !role) return;
  if (!isSiteInScope(siteId, effectiveSiteId(user))) return;
  const existingEmployee = await prisma.employee.findUnique({ where: { id }, select: { plantId: true } });
  if (!existingEmployee) return;
  const plantId = await resolvePlantIdForSite(siteId, existingEmployee.plantId);
  if (!plantId) return;

  await prisma.employee.update({
    where: { id },
    data: {
      plantId,
      name,
      role,
      code,
      shiftPattern,
      licenseExpiry: licenseExpiryRaw ? new Date(licenseExpiryRaw) : null,
      status,
    },
  });
  await logTransferIfChanged("Employees", id, existingEmployee.plantId, plantId);

  await logAudit({ module: "Employees", recordId: id, afterValue: name, reasonCode: "EMPLOYEE_UPDATED" });
  revalidatePath("/employees");
}

// Lets an Admin grow the "admin" tab's role picker from the screen itself
// instead of a code change — see JobTitle in schema.prisma. Silently
// no-ops on an empty or duplicate name rather than surfacing a unique-
// constraint error, since the outcome ("this title is now selectable") is
// the same either way.
export async function createJobTitle(formData: FormData) {
  const user = await getCurrentUser();
  requireRole(user, ["ADMIN"]);

  const name = String(formData.get("name") ?? "").trim();
  if (!name) return;

  const existing = await prisma.jobTitle.findUnique({ where: { name } });
  if (existing) return;

  const jobTitle = await prisma.jobTitle.create({ data: { name } });

  await logAudit({ module: "Employees", recordId: jobTitle.id, afterValue: name, reasonCode: "JOB_TITLE_CREATED" });
  revalidatePath("/employees");
}

// --- Pump crew (operator/assistant tabs) — separate roster, see
// PumpCrewMember in schema.prisma for why it isn't merged into Employee. --

export async function createPumpCrewMember(formData: FormData) {
  const user = await getCurrentUser();
  requireRole(user, ["PLANT_OPERATOR", "ADMIN"]);

  const siteId = String(formData.get("siteId") ?? "");
  const name = String(formData.get("name") ?? "").trim();
  const role = String(formData.get("role") ?? "OPERATOR");
  const phone = String(formData.get("phone") ?? "").trim() || null;
  const code = String(formData.get("code") ?? "").trim() || null;
  if (!siteId || !name) return;
  if (!isSiteInScope(siteId, effectiveSiteId(user))) return;
  const plantId = await resolvePlantIdForSite(siteId);
  if (!plantId) return;

  const member = await prisma.pumpCrewMember.create({ data: { plantId, name, role, phone, code } });

  await logAudit({ module: "Employees", recordId: member.id, afterValue: name, reasonCode: "PUMP_CREW_CREATED" });
  revalidatePath("/employees");
}

export async function updatePumpCrewMember(formData: FormData) {
  const user = await getCurrentUser();
  requireRole(user, ["PLANT_OPERATOR", "ADMIN"]);

  const id = String(formData.get("id") ?? "");
  const siteId = String(formData.get("siteId") ?? "");
  const name = String(formData.get("name") ?? "").trim();
  const role = String(formData.get("role") ?? "OPERATOR");
  const phone = String(formData.get("phone") ?? "").trim() || null;
  const code = String(formData.get("code") ?? "").trim() || null;
  const status = String(formData.get("status") ?? "ACTIVE");
  if (!id || !siteId || !name) return;
  if (!isSiteInScope(siteId, effectiveSiteId(user))) return;
  const existingMember = await prisma.pumpCrewMember.findUnique({ where: { id }, select: { plantId: true } });
  if (!existingMember) return;
  const plantId = await resolvePlantIdForSite(siteId, existingMember.plantId);
  if (!plantId) return;

  await prisma.pumpCrewMember.update({ where: { id }, data: { plantId, name, role, phone, code, status } });
  await logTransferIfChanged("Employees", id, existingMember.plantId, plantId);

  await logAudit({ module: "Employees", recordId: id, afterValue: name, reasonCode: "PUMP_CREW_UPDATED" });
  revalidatePath("/employees");
}
