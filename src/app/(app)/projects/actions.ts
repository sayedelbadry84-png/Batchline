"use server";

import { prisma } from "@/lib/prisma";
import { logAudit } from "@/lib/audit";
import { revalidatePath } from "next/cache";

export async function createProject(formData: FormData) {
  const name = String(formData.get("name") ?? "").trim();
  const customerId = String(formData.get("customerId") ?? "");
  const plantId = String(formData.get("plantId") ?? "");
  const siteAddress = String(formData.get("siteAddress") ?? "").trim();
  const contractedVolumeM3 = Number(formData.get("contractedVolumeM3") ?? 0) || null;

  if (!name || !customerId || !plantId || !siteAddress) return;

  const project = await prisma.project.create({
    data: { name, customerId, plantId, siteAddress, contractedVolumeM3, status: "ACTIVE" },
  });

  await logAudit({ module: "Projects", recordId: project.id, afterValue: name, reasonCode: "PROJECT_CREATED" });
  revalidatePath("/projects");
}

export async function updateProject(formData: FormData) {
  const id = String(formData.get("id") ?? "");
  const name = String(formData.get("name") ?? "").trim();
  const customerId = String(formData.get("customerId") ?? "");
  const plantId = String(formData.get("plantId") ?? "");
  const siteAddress = String(formData.get("siteAddress") ?? "").trim();
  const contractedVolumeM3 = Number(formData.get("contractedVolumeM3") ?? 0) || null;
  const status = String(formData.get("status") ?? "ACTIVE");

  if (!id || !name || !customerId || !plantId || !siteAddress) return;

  await prisma.project.update({
    where: { id },
    data: { name, customerId, plantId, siteAddress, contractedVolumeM3, status },
  });

  await logAudit({ module: "Projects", recordId: id, afterValue: name, reasonCode: "PROJECT_UPDATED" });
  revalidatePath("/projects");
}
