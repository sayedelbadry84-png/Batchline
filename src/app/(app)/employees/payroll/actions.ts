"use server";

import { prisma } from "@/lib/prisma";
import { logAudit } from "@/lib/audit";
import { getCurrentUser, requireRole } from "@/lib/session";
import { withSequentialNumber } from "@/lib/sequence";
import { revalidatePath } from "next/cache";

// Salary data is more sensitive than the rest of the Employees module
// (which PLANT_ADMIN can already use for attendance/leave), so every
// payroll action is gated to ADMIN specifically — the UI also hides the
// tab from non-admins, but this is the real boundary, independent of that.
const PAYROLL_ROLES = ["ADMIN"];

function daysInclusive(start: Date, end: Date): number {
  return Math.round((end.getTime() - start.getTime()) / 86400000) + 1;
}

// Company-wide by design, not site-scoped — a payroll run naturally spans
// every plant's staff at once (same reasoning as the Customer Statement
// being company-wide: filtering by "whichever site the caller happens to
// be viewing" would silently produce an incomplete run).
export async function generatePayrollRun(formData: FormData) {
  const user = await getCurrentUser();
  requireRole(user, PAYROLL_ROLES);

  const periodStartRaw = String(formData.get("periodStart") ?? "");
  const periodEndRaw = String(formData.get("periodEnd") ?? "");
  if (!periodStartRaw || !periodEndRaw) return;

  const periodStart = new Date(`${periodStartRaw}T00:00:00`);
  const periodEnd = new Date(`${periodEndRaw}T23:59:59`);
  if (periodEnd < periodStart) return;
  const periodDays = daysInclusive(new Date(`${periodStartRaw}T00:00:00`), new Date(`${periodEndRaw}T00:00:00`));

  // Only employees with both wageType and wageRate configured are payable —
  // everyone else is silently skipped (surfaced as a count in the UI), not
  // blocked, since not every role necessarily goes through this system yet.
  const employees = await prisma.employee.findMany({
    where: { status: "ACTIVE", wageType: { not: null }, wageRate: { not: null } },
  });

  const run = await withSequentialNumber(
    "PYR",
    () => prisma.payrollRun.count(),
    (runNumber) =>
      prisma.payrollRun.create({
        data: { runNumber, periodStart, periodEnd, createdById: user!.id },
      }),
  );

  for (const employee of employees) {
    const wageType = employee.wageType!;
    const wageRate = employee.wageRate!;

    const absentDays = await prisma.attendanceRecord.count({
      where: { employeeId: employee.id, date: { gte: periodStart, lte: periodEnd }, status: "ABSENT" },
    });

    // Full daysCount is counted on any overlap with the period — no
    // proration for a leave that only partially crosses the period
    // boundary. A deliberate MVP simplification, not a precise pro-rata
    // split.
    const unpaidLeaves = await prisma.leaveRequest.findMany({
      where: {
        employeeId: employee.id,
        type: "UNPAID",
        status: "APPROVED",
        startDate: { lte: periodEnd },
        endDate: { gte: periodStart },
      },
    });
    const unpaidLeaveDays = unpaidLeaves.reduce((sum, l) => sum + l.daysCount, 0);
    const unpaidDays = absentDays + unpaidLeaveDays;

    let grossPay: number;
    let deduction: number;
    if (wageType === "MONTHLY") {
      grossPay = wageRate;
      deduction = (wageRate / 30) * unpaidDays;
    } else {
      const workedDays = Math.max(periodDays - unpaidDays, 0);
      grossPay = wageRate * workedDays;
      deduction = 0;
    }
    const netPay = grossPay - deduction;

    await prisma.payrollLine.create({
      data: {
        payrollRunId: run.id,
        employeeId: employee.id,
        wageType,
        wageRate,
        periodDays,
        unpaidDays,
        grossPay,
        adjustment: 0,
        netPay,
      },
    });
  }

  await logAudit({ module: "Employees", recordId: run.id, afterValue: `${run.runNumber} — ${employees.length} lines`, reasonCode: "PAYROLL_RUN_GENERATED" });
  revalidatePath("/employees");
}

export async function updatePayrollLine(formData: FormData) {
  const user = await getCurrentUser();
  requireRole(user, PAYROLL_ROLES);

  const id = String(formData.get("id") ?? "");
  const adjustment = Number(formData.get("adjustment") ?? 0);
  const notes = String(formData.get("notes") ?? "").trim() || null;
  if (!id) return;

  const line = await prisma.payrollLine.findUnique({ where: { id }, include: { payrollRun: true } });
  if (!line || line.payrollRun.status !== "DRAFT") return;

  const netPay = line.grossPay - (line.wageType === "MONTHLY" ? (line.wageRate / 30) * line.unpaidDays : 0) + adjustment;

  await prisma.payrollLine.update({ where: { id }, data: { adjustment, notes, netPay } });

  await logAudit({ module: "Employees", recordId: id, afterValue: `adjustment ${adjustment}`, reasonCode: "PAYROLL_LINE_ADJUSTED" });
  revalidatePath(`/employees/payroll/${line.payrollRunId}`);
}

export async function approvePayrollRun(formData: FormData) {
  const user = await getCurrentUser();
  requireRole(user, PAYROLL_ROLES);

  const id = String(formData.get("id") ?? "");
  if (!id) return;

  const run = await prisma.payrollRun.findUnique({ where: { id } });
  if (!run || run.status !== "DRAFT") return;

  await prisma.payrollRun.update({ where: { id }, data: { status: "APPROVED", approvedById: user!.id, approvedAt: new Date() } });

  await logAudit({ module: "Employees", recordId: id, afterValue: "APPROVED", reasonCode: "PAYROLL_RUN_APPROVED" });
  revalidatePath(`/employees/payroll/${id}`);
  revalidatePath("/employees");
}

// Marking a run paid is what actually posts the cash outflow — one
// CashTransaction PER SITE among the run's employees, never blended
// together, same "site boundaries are real money boundaries" reasoning
// used everywhere else PO/invoice totals are grouped in this app.
export async function markPayrollRunPaid(formData: FormData) {
  const user = await getCurrentUser();
  requireRole(user, PAYROLL_ROLES);

  const id = String(formData.get("id") ?? "");
  if (!id) return;

  const run = await prisma.payrollRun.findUnique({
    where: { id },
    include: { lines: { include: { employee: { include: { plant: true } } } } },
  });
  if (!run || run.status !== "APPROVED") return;

  const bySite = new Map<string, { siteId: string; currency: string; total: number }>();
  for (const line of run.lines) {
    const plant = line.employee.plant;
    const existing = bySite.get(plant.siteId);
    if (existing) {
      existing.total += line.netPay;
    } else {
      bySite.set(plant.siteId, { siteId: plant.siteId, currency: plant.currency, total: line.netPay });
    }
  }

  for (const site of bySite.values()) {
    if (site.total <= 0) continue;
    await withSequentialNumber(
      "TXN",
      () => prisma.cashTransaction.count(),
      (txnNumber) =>
        prisma.cashTransaction.create({
          data: {
            txnNumber,
            siteId: site.siteId,
            direction: "OUT",
            category: "PAYROLL",
            amount: site.total,
            currency: site.currency,
            description: `Payroll run ${run.runNumber}`,
            occurredAt: new Date(),
            createdById: user!.id,
          },
        }),
    );
  }

  await prisma.payrollRun.update({ where: { id }, data: { status: "PAID", paidAt: new Date() } });

  await logAudit({ module: "Employees", recordId: id, afterValue: "PAID", reasonCode: "PAYROLL_RUN_PAID" });
  revalidatePath(`/employees/payroll/${id}`);
  revalidatePath("/employees");
  revalidatePath("/finance");
}

export async function cancelPayrollRun(formData: FormData) {
  const user = await getCurrentUser();
  requireRole(user, PAYROLL_ROLES);

  const id = String(formData.get("id") ?? "");
  if (!id) return;

  const run = await prisma.payrollRun.findUnique({ where: { id } });
  if (!run || run.status !== "DRAFT") return;

  await prisma.payrollRun.update({ where: { id }, data: { status: "CANCELLED" } });

  await logAudit({ module: "Employees", recordId: id, afterValue: "CANCELLED", reasonCode: "PAYROLL_RUN_CANCELLED" });
  revalidatePath("/employees");
}
