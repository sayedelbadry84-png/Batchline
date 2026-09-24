"use server";

import { prisma } from "@/lib/prisma";
import { logAudit } from "@/lib/audit";
import { getCurrentUser, requireActionPermission } from "@/lib/session";
import { revalidatePath } from "next/cache";
import { parseMoneyInput } from "@/lib/money";
import { redirect } from "next/navigation";

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

// The credit limit is money and gates every reservation (creditPolicy.ts),
// so it goes through the same parser as every other money input. It used
// to be Number(raw): "Infinity" stored an infinite limit that no balance
// could reach, which switched the credit check off for that customer, and
// negative, NaN or three-decimal values went in unchecked. A blank field
// means 0, the existing default: no credit until someone sets a limit.
// A CHECK constraint (migration 20260925120000) backs this at the database.
function parseCreditLimit(raw: FormDataEntryValue | null): number | null {
  if (raw === null || (typeof raw === "string" && raw.trim() === "")) return 0;
  return parseMoneyInput(raw);
}

function customersResultPath(code: string) {
  return `/customers?${new URLSearchParams({ customerResult: code }).toString()}`;
}

export async function createCustomer(formData: FormData) {
  const user = await getCurrentUser();
  await requireActionPermission(user, "customers", "createCustomer");

  const legalName = String(formData.get("legalName") ?? "").trim();
  const codeInput = String(formData.get("code") ?? "").trim();
  const taxId = String(formData.get("taxId") ?? "").trim();
  const creditLimit = parseCreditLimit(formData.get("creditLimit"));
  const paymentTerms = String(formData.get("paymentTerms") ?? "Net 30").trim();
  const contactEmail = String(formData.get("contactEmail") ?? "").trim();
  const contactPhone = String(formData.get("contactPhone") ?? "").trim();

  if (!legalName) return;
  if (creditLimit === null) redirect(customersResultPath("INVALID_CREDIT_LIMIT"));
  const code = codeInput || (await generateNextCustomerCode());

  const customer = await prisma.customer.create({
    data: { code, legalName, taxId, creditLimit, paymentTerms, contactEmail, contactPhone },
  });

  await logAudit({ module: "Customers", recordId: customer.id, afterValue: `${code} — ${legalName}`, reasonCode: "CUSTOMER_CREATED" });
  revalidatePath("/customers");
}

export async function updateCustomer(formData: FormData) {
  const user = await getCurrentUser();
  await requireActionPermission(user, "customers", "updateCustomer");

  const id = String(formData.get("id") ?? "");
  const legalName = String(formData.get("legalName") ?? "").trim();
  const codeInput = String(formData.get("code") ?? "").trim();
  const taxId = String(formData.get("taxId") ?? "").trim();
  const creditLimit = parseCreditLimit(formData.get("creditLimit"));
  const paymentTerms = String(formData.get("paymentTerms") ?? "Net 30").trim();
  const contactEmail = String(formData.get("contactEmail") ?? "").trim();
  const contactPhone = String(formData.get("contactPhone") ?? "").trim();

  if (!id || !legalName) return;
  if (creditLimit === null) redirect(customersResultPath("INVALID_CREDIT_LIMIT"));

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
