"use server";

import { prisma } from "@/lib/prisma";
import { logAudit } from "@/lib/audit";
import { getCurrentUser, requireRole } from "@/lib/session";
import { revalidatePath } from "next/cache";

// "C-00001" style — one past whatever the highest existing auto-generated
// number is. Only ever consulted when the operator leaves the code field
// blank; typing a code by hand always wins.
async function generateNextCustomerCode(): Promise<string> {
  const customers = await prisma.customer.findMany({
    where: { code: { startsWith: "C-" } },
    select: { code: true },
  });
  let max = 0;
  for (const c of customers) {
    const match = c.code?.match(/^C-(\d+)$/);
    if (match) max = Math.max(max, Number(match[1]));
  }
  return `C-${String(max + 1).padStart(5, "0")}`;
}

export async function createCustomer(formData: FormData) {
  const user = await getCurrentUser();
  requireRole(user, ["ACCOUNTANT", "PLANT_OPERATOR", "ADMIN"]);

  const legalName = String(formData.get("legalName") ?? "").trim();
  const codeInput = String(formData.get("code") ?? "").trim();
  const taxId = String(formData.get("taxId") ?? "").trim();
  const creditLimit = Number(formData.get("creditLimit") ?? 0);
  const paymentTerms = String(formData.get("paymentTerms") ?? "Net 30").trim();
  const contactEmail = String(formData.get("contactEmail") ?? "").trim();
  const contactPhone = String(formData.get("contactPhone") ?? "").trim();

  if (!legalName) return;
  const code = codeInput || (await generateNextCustomerCode());

  const customer = await prisma.customer.create({
    data: { code, legalName, taxId, creditLimit, paymentTerms, contactEmail, contactPhone },
  });

  await logAudit({ module: "Customers", recordId: customer.id, afterValue: `${code} — ${legalName}`, reasonCode: "CUSTOMER_CREATED" });
  revalidatePath("/customers");
}

export async function updateCustomer(formData: FormData) {
  const user = await getCurrentUser();
  requireRole(user, ["ACCOUNTANT", "PLANT_OPERATOR", "ADMIN"]);

  const id = String(formData.get("id") ?? "");
  const legalName = String(formData.get("legalName") ?? "").trim();
  const codeInput = String(formData.get("code") ?? "").trim();
  const taxId = String(formData.get("taxId") ?? "").trim();
  const creditLimit = Number(formData.get("creditLimit") ?? 0);
  const paymentTerms = String(formData.get("paymentTerms") ?? "Net 30").trim();
  const contactEmail = String(formData.get("contactEmail") ?? "").trim();
  const contactPhone = String(formData.get("contactPhone") ?? "").trim();

  if (!id || !legalName) return;

  await prisma.customer.update({
    where: { id },
    // A blank code field leaves the existing code untouched rather than
    // clearing it — the edit form always renders it pre-filled, so blank
    // here means "wasn't submitted," not "the operator wants it removed."
    data: { ...(codeInput ? { code: codeInput } : {}), legalName, taxId, creditLimit, paymentTerms, contactEmail, contactPhone },
  });

  await logAudit({ module: "Customers", recordId: id, afterValue: legalName, reasonCode: "CUSTOMER_UPDATED" });
  revalidatePath("/customers");
}
