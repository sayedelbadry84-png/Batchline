"use server";

import { prisma } from "@/lib/prisma";
import { writeAudit } from "@/lib/audit";
import { getCurrentUser, requireActionPermission } from "@/lib/session";
import { revalidatePath } from "next/cache";
import { effectiveSiteId } from "@/lib/siteScope";
import { requestCreditLimitIncrease, decideCreditLimitRequest } from "@/lib/creditLimitRequests";
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

function customersResultPath(code: string) {
  return `/customers?${new URLSearchParams({ customerResult: code }).toString()}`;
}

// Neither customer form writes Customer.creditLimit. It gates every
// reservation (creditPolicy.ts), and these actions are open to every role
// with customers.createCustomer/updateCustomer, PLANT_OPERATOR included,
// so a limit set here would be an authorization nobody approved. A new
// customer starts at 0 (no credit); the only way up is
// requestCreditLimitIncrease followed by a different person's approval
// (src/lib/creditLimitRequests.ts). A creditLimit field in a crafted
// submission is ignored, not stored.
export async function createCustomer(formData: FormData) {
  const user = await getCurrentUser();
  await requireActionPermission(user, "customers", "createCustomer");

  const legalName = String(formData.get("legalName") ?? "").trim();
  const codeInput = String(formData.get("code") ?? "").trim();
  const taxId = String(formData.get("taxId") ?? "").trim();
  const paymentTerms = String(formData.get("paymentTerms") ?? "Net 30").trim();
  const contactEmail = String(formData.get("contactEmail") ?? "").trim();
  const contactPhone = String(formData.get("contactPhone") ?? "").trim();

  if (!legalName) return;
  const code = codeInput || (await generateNextCustomerCode());

  // The customer and its audit row commit together.
  await prisma.$transaction(async (tx) => {
    const customer = await tx.customer.create({
      data: { code, legalName, taxId, creditLimit: 0, paymentTerms, contactEmail, contactPhone },
    });
    await writeAudit(tx, { id: user!.id, role: user!.role }, { module: "Customers", recordId: customer.id, afterValue: `${code} — ${legalName}`, reasonCode: "CUSTOMER_CREATED" });
  });
  revalidatePath("/customers");
}

export async function updateCustomer(formData: FormData) {
  const user = await getCurrentUser();
  await requireActionPermission(user, "customers", "updateCustomer");

  const id = String(formData.get("id") ?? "");
  const legalName = String(formData.get("legalName") ?? "").trim();
  const codeInput = String(formData.get("code") ?? "").trim();
  const taxId = String(formData.get("taxId") ?? "").trim();
  const paymentTerms = String(formData.get("paymentTerms") ?? "Net 30").trim();
  const contactEmail = String(formData.get("contactEmail") ?? "").trim();
  const contactPhone = String(formData.get("contactPhone") ?? "").trim();

  if (!id || !legalName) return;

  // creditLimit is deliberately absent from this write (see above). The
  // update and its audit row commit together; the audit used to be
  // written after the change had already committed.
  const updated = await prisma.$transaction(async (tx) => {
    const result = await tx.customer.updateMany({
      where: { id },
      // A blank code field leaves the existing code untouched rather than
      // clearing it — the edit form always renders it pre-filled, so blank
      // here means "wasn't submitted," not "the operator wants it removed."
      data: { ...(codeInput ? { code: codeInput } : {}), legalName, taxId, paymentTerms, contactEmail, contactPhone },
    });
    if (result.count !== 1) return false;
    await writeAudit(tx, { id: user!.id, role: user!.role }, { module: "Customers", recordId: id, afterValue: legalName, reasonCode: "CUSTOMER_UPDATED" });
    return true;
  });
  if (!updated) return;
  revalidatePath("/customers");
}

export async function requestCreditLimitIncreaseAction(formData: FormData) {
  const user = await getCurrentUser();
  await requireActionPermission(user, "customers", "requestCreditLimitIncrease");

  const customerId = String(formData.get("customerId") ?? "");
  if (!customerId) redirect(customersResultPath("NOT_FOUND"));
  const result = await requestCreditLimitIncrease(
    customerId,
    { proposedLimit: formData.get("proposedLimit"), reason: String(formData.get("reason") ?? "") },
    { id: user!.id, role: user!.role, allowedSiteId: effectiveSiteId(user) },
  );
  revalidatePath("/customers");
  redirect(customersResultPath(result.status === "OK" ? "REQUESTED" : result.status));
}

export async function decideCreditLimitRequestAction(formData: FormData) {
  const user = await getCurrentUser();
  const decision = formData.get("decision") === "APPROVE" ? "APPROVE" : "REJECT";
  await requireActionPermission(user, "customers", decision === "APPROVE" ? "approveCreditLimitIncrease" : "rejectCreditLimitIncrease");

  const requestId = String(formData.get("requestId") ?? "");
  if (!requestId) redirect(customersResultPath("NOT_FOUND"));
  const result = await decideCreditLimitRequest(requestId, decision, String(formData.get("decisionNote") ?? ""), {
    id: user!.id,
    role: user!.role,
    allowedSiteId: effectiveSiteId(user),
  });
  revalidatePath("/customers");
  revalidatePath("/reservations");
  redirect(customersResultPath(result.status));
}
