"use server";

import { prisma } from "@/lib/prisma";
import { logAudit } from "@/lib/audit";
import { revalidatePath } from "next/cache";

export async function createCustomer(formData: FormData) {
  const legalName = String(formData.get("legalName") ?? "").trim();
  const taxId = String(formData.get("taxId") ?? "").trim();
  const creditLimit = Number(formData.get("creditLimit") ?? 0);
  const paymentTerms = String(formData.get("paymentTerms") ?? "Net 30").trim();
  const contactEmail = String(formData.get("contactEmail") ?? "").trim();
  const contactPhone = String(formData.get("contactPhone") ?? "").trim();

  if (!legalName) return;

  const customer = await prisma.customer.create({
    data: { legalName, taxId, creditLimit, paymentTerms, contactEmail, contactPhone },
  });

  await logAudit({ module: "Customers", recordId: customer.id, afterValue: legalName, reasonCode: "CUSTOMER_CREATED" });
  revalidatePath("/customers");
}

export async function updateCustomer(formData: FormData) {
  const id = String(formData.get("id") ?? "");
  const legalName = String(formData.get("legalName") ?? "").trim();
  const taxId = String(formData.get("taxId") ?? "").trim();
  const creditLimit = Number(formData.get("creditLimit") ?? 0);
  const paymentTerms = String(formData.get("paymentTerms") ?? "Net 30").trim();
  const contactEmail = String(formData.get("contactEmail") ?? "").trim();
  const contactPhone = String(formData.get("contactPhone") ?? "").trim();

  if (!id || !legalName) return;

  await prisma.customer.update({
    where: { id },
    data: { legalName, taxId, creditLimit, paymentTerms, contactEmail, contactPhone },
  });

  await logAudit({ module: "Customers", recordId: id, afterValue: legalName, reasonCode: "CUSTOMER_UPDATED" });
  revalidatePath("/customers");
}
