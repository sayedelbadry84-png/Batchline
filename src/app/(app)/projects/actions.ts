"use server";

import { prisma } from "@/lib/prisma";
import { logAudit } from "@/lib/audit";
import { getCurrentUser, requireRole } from "@/lib/session";
import { revalidatePath } from "next/cache";

// Company-wide — a project isn't tied to any one plant/line (see the
// Project model comment in schema.prisma), so there's no site to scope
// these against. Which plant actually produces for it is decided per
// Reservation instead.
export async function createProject(formData: FormData) {
  const user = await getCurrentUser();
  requireRole(user, ["PLANT_OPERATOR", "ACCOUNTANT", "ADMIN"]);

  const name = String(formData.get("name") ?? "").trim();
  const customerId = String(formData.get("customerId") ?? "");
  const siteAddress = String(formData.get("siteAddress") ?? "").trim();
  const contractedVolumeM3 = Number(formData.get("contractedVolumeM3") ?? 0) || null;

  if (!name || !customerId || !siteAddress) return;

  const project = await prisma.project.create({
    data: { name, customerId, siteAddress, contractedVolumeM3, status: "ACTIVE" },
  });

  await logAudit({ module: "Projects", recordId: project.id, afterValue: name, reasonCode: "PROJECT_CREATED" });
  revalidatePath("/projects");
}

export async function updateProject(formData: FormData) {
  const user = await getCurrentUser();
  requireRole(user, ["PLANT_OPERATOR", "ACCOUNTANT", "ADMIN"]);

  const id = String(formData.get("id") ?? "");
  const name = String(formData.get("name") ?? "").trim();
  const customerId = String(formData.get("customerId") ?? "");
  const siteAddress = String(formData.get("siteAddress") ?? "").trim();
  const contractedVolumeM3 = Number(formData.get("contractedVolumeM3") ?? 0) || null;
  const status = String(formData.get("status") ?? "ACTIVE");

  if (!id || !name || !customerId || !siteAddress) return;

  await prisma.project.update({
    where: { id },
    data: { name, customerId, siteAddress, contractedVolumeM3, status },
  });

  await logAudit({ module: "Projects", recordId: id, afterValue: name, reasonCode: "PROJECT_UPDATED" });
  revalidatePath("/projects");
}
