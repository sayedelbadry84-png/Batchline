"use server";

import { prisma } from "@/lib/prisma";
import { logAudit } from "@/lib/audit";
import { revalidatePath } from "next/cache";

export async function createPlant(formData: FormData) {
  const name = String(formData.get("name") ?? "").trim();
  const city = String(formData.get("city") ?? "").trim();
  const currency = String(formData.get("currency") ?? "EGP").trim();
  const timezone = String(formData.get("timezone") ?? "Africa/Cairo").trim();

  if (!name || !city) return;

  const plant = await prisma.plant.create({
    data: { name, city, currency, timezone },
  });

  await logAudit({
    module: "PlantManagement",
    recordId: plant.id,
    afterValue: name,
    reasonCode: "PLANT_CREATED",
  });

  revalidatePath("/plants");
}
