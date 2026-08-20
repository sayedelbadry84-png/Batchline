"use server";

import { prisma } from "@/lib/prisma";
import { logAudit } from "@/lib/audit";
import { getCurrentUser, requireRole } from "@/lib/session";
import { parseNetDays } from "@/lib/billing";
import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";

// Create is an upsert (same customer+mix re-submitted just updates the
// price, matching how MixDesign's addComponent behaves) — edit passes an
// id and updates that row directly.
export async function savePriceListEntry(formData: FormData) {
  const user = await getCurrentUser();
  requireRole(user, ["ACCOUNTANT", "ADMIN"]);

  const id = String(formData.get("id") ?? "");
  const pricePerM3 = Number(formData.get("pricePerM3") ?? 0);
  if (!pricePerM3 || pricePerM3 <= 0) return;

  if (id) {
    await prisma.priceListEntry.update({ where: { id }, data: { pricePerM3 } });
    await logAudit({ module: "Billing", recordId: id, afterValue: `${pricePerM3}/m3`, reasonCode: "PRICE_UPDATED" });
  } else {
    const customerId = String(formData.get("customerId") ?? "");
    const mixId = String(formData.get("mixId") ?? "");
    if (!customerId || !mixId) return;

    const entry = await prisma.priceListEntry.upsert({
      where: { customerId_mixId: { customerId, mixId } },
      create: { customerId, mixId, pricePerM3 },
      update: { pricePerM3 },
    });
    await logAudit({ module: "Billing", recordId: entry.id, afterValue: `${pricePerM3}/m3`, reasonCode: "PRICE_CREATED" });
  }

  revalidatePath("/billing");
}

// The delivery ticket (a closed Trip) is the billing unit — a split
// reservation dispatched as several trucks bills as several lines. Every
// currently-unbilled closed trip for the project goes into one invoice;
// any trip whose mix has no price on file for this customer is silently
// left out (it stays "ready to invoice" for next time) rather than
// blocking the whole invoice or guessing a price.
export async function generateInvoiceForProject(formData: FormData) {
  const user = await getCurrentUser();
  requireRole(user, ["ACCOUNTANT", "ADMIN"]);

  const projectId = String(formData.get("projectId") ?? "");
  if (!projectId) return;

  const project = await prisma.project.findUnique({
    where: { id: projectId },
    include: { customer: true, plant: true },
  });
  if (!project) return;

  const uninvoicedTrips = await prisma.trip.findMany({
    where: { status: "CLOSED", invoiceLine: null, batchTicket: { reservation: { projectId } } },
    include: { batchTicket: { include: { reservation: { include: { mix: true } } } } },
  });
  if (uninvoicedTrips.length === 0) return;

  const priceEntries = await prisma.priceListEntry.findMany({ where: { customerId: project.customerId } });
  const priceByMix = new Map(priceEntries.map((p) => [p.mixId, p.pricePerM3]));

  const lines = uninvoicedTrips
    .map((trip) => {
      const mix = trip.batchTicket.reservation.mix;
      const unitPrice = priceByMix.get(mix.id);
      if (unitPrice == null) return null;
      const volumeM3 = trip.volumeDeliveredM3 ?? trip.batchTicket.volumeM3;
      return {
        tripId: trip.id,
        description: `${trip.batchTicket.ticketNumber} — ${mix.code}`,
        volumeM3,
        unitPrice,
        lineTotal: volumeM3 * unitPrice,
      };
    })
    .filter((l): l is NonNullable<typeof l> => l !== null);

  if (lines.length === 0) return;

  const subtotal = lines.reduce((sum, l) => sum + l.lineTotal, 0);
  const dueDate = new Date(Date.now() + parseNetDays(project.customer.paymentTerms) * 24 * 60 * 60 * 1000);
  const invoiceCount = await prisma.invoice.count();
  const invoiceNumber = `INV-${new Date().getFullYear()}-${String(invoiceCount + 1).padStart(4, "0")}`;

  const invoice = await prisma.invoice.create({
    data: {
      invoiceNumber,
      customerId: project.customerId,
      projectId,
      dueDate,
      subtotal,
      total: subtotal,
      currency: project.plant.currency,
      lines: { create: lines },
    },
  });

  await logAudit({
    module: "Billing",
    recordId: invoice.id,
    afterValue: `${invoiceNumber} — ${subtotal} ${project.plant.currency}`,
    reasonCode: "INVOICE_GENERATED",
  });

  revalidatePath("/billing");
  redirect(`/billing/${invoice.id}`);
}

export async function markInvoiceSent(formData: FormData) {
  const user = await getCurrentUser();
  requireRole(user, ["ACCOUNTANT", "ADMIN"]);

  const id = String(formData.get("id") ?? "");
  if (!id) return;

  const invoice = await prisma.invoice.findUnique({ where: { id } });
  if (!invoice || invoice.status !== "DRAFT") return;

  await prisma.invoice.update({ where: { id }, data: { status: "SENT" } });
  await logAudit({ module: "Billing", recordId: id, field: "status", afterValue: "SENT", reasonCode: "INVOICE_SENT" });

  revalidatePath(`/billing/${id}`);
  revalidatePath("/billing");
}

// Voids an invoice rather than deleting it — the header (number, total,
// dates, CANCELLED status) stays on file as the audit record of what was
// generated and why it didn't stand. Its line items are removed so the
// trips they billed become "ready to invoice" again (a trip can only carry
// one InvoiceLine — that's how "already billed" is detected), rather than
// staying stuck against a voided invoice forever. Refused once a payment
// exists: that money is real and cancelling would orphan it — reconciling
// that is a manual step outside this pass's scope.
export async function cancelInvoice(formData: FormData) {
  const user = await getCurrentUser();
  requireRole(user, ["ACCOUNTANT", "ADMIN"]);

  const id = String(formData.get("id") ?? "");
  if (!id) return;

  const invoice = await prisma.invoice.findUnique({ where: { id }, include: { payments: true } });
  if (!invoice || invoice.status === "CANCELLED" || invoice.status === "PAID" || invoice.payments.length > 0) return;

  await prisma.$transaction([
    prisma.invoiceLine.deleteMany({ where: { invoiceId: id } }),
    prisma.invoice.update({ where: { id }, data: { status: "CANCELLED" } }),
  ]);

  await logAudit({
    module: "Billing",
    recordId: id,
    field: "status",
    beforeValue: invoice.status,
    afterValue: "CANCELLED",
    reasonCode: "INVOICE_CANCELLED",
  });

  revalidatePath(`/billing/${id}`);
  revalidatePath("/billing");
}

export async function recordPayment(formData: FormData) {
  const user = await getCurrentUser();
  requireRole(user, ["ACCOUNTANT", "ADMIN"]);

  const invoiceId = String(formData.get("invoiceId") ?? "");
  const amount = Number(formData.get("amount") ?? 0);
  const method = String(formData.get("method") ?? "") || null;
  const reference = String(formData.get("reference") ?? "").trim() || null;
  if (!invoiceId || !amount || amount <= 0) return;

  const invoice = await prisma.invoice.findUnique({ where: { id: invoiceId }, include: { payments: true } });
  if (!invoice || invoice.status === "CANCELLED" || invoice.status === "PAID") return;

  await prisma.payment.create({ data: { invoiceId, amount, method, reference } });

  const totalPaid = invoice.payments.reduce((sum, p) => sum + p.amount, 0) + amount;
  if (totalPaid >= invoice.total - 0.01) {
    await prisma.invoice.update({ where: { id: invoiceId }, data: { status: "PAID" } });
  }

  await logAudit({
    module: "Billing",
    recordId: invoiceId,
    afterValue: `${amount} ${invoice.currency}`,
    reasonCode: "PAYMENT_RECORDED",
  });

  revalidatePath(`/billing/${invoiceId}`);
  revalidatePath("/billing");
}
