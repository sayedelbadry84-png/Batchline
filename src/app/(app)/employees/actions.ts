"use server";

import { prisma } from "@/lib/prisma";
import { logAudit } from "@/lib/audit";
import { getCurrentUser, requireRole } from "@/lib/session";
import { revalidatePath } from "next/cache";

export async function createEmployee(formData: FormData) {
  const user = await getCurrentUser();
  requireRole(user, ["ADMIN"]);

  const plantId = String(formData.get("plantId") ?? "");
  const name = String(formData.get("name") ?? "").trim();
  const role = String(formData.get("role") ?? "").trim();
  const licenseExpiryRaw = String(formData.get("licenseExpiry") ?? "");
  const shiftPattern = String(formData.get("shiftPattern") ?? "").trim();

  if (!plantId || !name || !role) return;

  const employee = await prisma.employee.create({
    data: {
      plantId,
      name,
      role,
      shiftPattern,
      licenseExpiry: licenseExpiryRaw ? new Date(licenseExpiryRaw) : null,
    },
  });

  await logAudit({ module: "Employees", recordId: employee.id, afterValue: name, reasonCode: "EMPLOYEE_CREATED" });
  revalidatePath("/employees");
}

export async function updateEmployee(formData: FormData) {
  const user = await getCurrentUser();
  requireRole(user, ["ADMIN"]);

  const id = String(formData.get("id") ?? "");
  const plantId = String(formData.get("plantId") ?? "");
  const name = String(formData.get("name") ?? "").trim();
  const role = String(formData.get("role") ?? "").trim();
  const licenseExpiryRaw = String(formData.get("licenseExpiry") ?? "");
  const shiftPattern = String(formData.get("shiftPattern") ?? "").trim();

  if (!id || !plantId || !name || !role) return;

  await prisma.employee.update({
    where: { id },
    data: {
      plantId,
      name,
      role,
      shiftPattern,
      licenseExpiry: licenseExpiryRaw ? new Date(licenseExpiryRaw) : null,
    },
  });

  await logAudit({ module: "Employees", recordId: id, afterValue: name, reasonCode: "EMPLOYEE_UPDATED" });
  revalidatePath("/employees");
}
