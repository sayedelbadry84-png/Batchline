"use server";

import bcrypt from "bcryptjs";
import { prisma } from "@/lib/prisma";
import { logAudit } from "@/lib/audit";
import { getCurrentUser, requireActionPermission } from "@/lib/session";
import { effectiveSiteId, isSiteInScope, resolvePlantIdForSite } from "@/lib/siteScope";
import { logTransferIfChanged } from "@/lib/transferAudit";
import { OTHER_ROLE_SENTINEL } from "@/lib/employeeRole";
import { withSequentialNumber } from "@/lib/sequence";
import { postCashTransaction } from "@/lib/ledger";
import { calculateEndOfServiceEntitlement, TERMINATION_TYPES, type TerminationType } from "@/lib/endOfService";
import { revalidatePath } from "next/cache";

const LOGIN_SALT_ROUNDS = 10;
// See the same note on billing/actions.ts's own TX_OPTIONS — several
// sequential round trips to Neon inside one interactive transaction can
// exceed Prisma's 5s default timeout, especially on a cold connection.
const TX_OPTIONS = { timeout: 15000 };

// Auto-provisions a login the moment a driver or pump-crew member is
// added, instead of requiring a separate manual trip through /users
// afterward (see createEmployee/createPumpCrewMember below — the only
// two rosters with their own phone-first app to log into: /driver and
// /pump-crew). Both email and password are optional fields on the create
// form; this silently does nothing if either is blank, the password is
// under the same 8-char minimum users/actions.ts's createUser enforces,
// or the email is already taken — the roster entry itself always
// succeeds regardless, and an admin can still link/create the account by
// hand from /users afterward in any of those cases.
async function createLoginAccountIfRequested(params: {
  email: string;
  password: string;
  name: string;
  role: string;
  plantId: string;
  employeeId?: string;
  pumpCrewMemberId?: string;
}): Promise<void> {
  const email = params.email.trim().toLowerCase();
  if (!email || params.password.length < 8) return;
  const existing = await prisma.user.findUnique({ where: { email } });
  if (existing) return;

  const passwordHash = await bcrypt.hash(params.password, LOGIN_SALT_ROUNDS);
  const created = await prisma.user.create({
    data: {
      email,
      name: params.name,
      passwordHash,
      role: params.role,
      plantId: params.plantId,
      employeeId: params.employeeId,
      pumpCrewMemberId: params.pumpCrewMemberId,
    },
  });
  await logAudit({ module: "Users", recordId: created.id, afterValue: `${email} / ${params.role}`, reasonCode: "USER_CREATED" });
}

// Picking "Other" in the admin-tab role select submits this sentinel plus
// a typed newRoleName instead of a catalog value — resolve it down to a
// real role string, growing the JobTitle catalog on the way so the same
// title shows up as a normal option next time (same dedupe-safe upsert
// createJobTitle below uses standalone).
async function resolveRole(role: string, newRoleNameRaw: string): Promise<string | null> {
  if (role !== OTHER_ROLE_SENTINEL) return role || null;
  const name = newRoleNameRaw.trim();
  if (!name) return null;
  const existing = await prisma.jobTitle.findUnique({ where: { name } });
  if (!existing) await prisma.jobTitle.create({ data: { name } });
  return name;
}

export async function createEmployee(formData: FormData) {
  const user = await getCurrentUser();
  await requireActionPermission(user, "employees", "createEmployee");

  const siteId = String(formData.get("siteId") ?? "");
  const name = String(formData.get("name") ?? "").trim();
  const role = await resolveRole(String(formData.get("role") ?? "").trim(), String(formData.get("newRoleName") ?? ""));
  const code = String(formData.get("code") ?? "").trim() || null;
  const nationalId = String(formData.get("nationalId") ?? "").trim() || null;
  const iban = String(formData.get("iban") ?? "").trim() || null;
  const hireDateRaw = String(formData.get("hireDate") ?? "");
  const licenseExpiryRaw = String(formData.get("licenseExpiry") ?? "");
  const shiftPattern = String(formData.get("shiftPattern") ?? "").trim();
  const wageType = String(formData.get("wageType") ?? "").trim() || null;
  const wageRateRaw = String(formData.get("wageRate") ?? "").trim();
  const wageRate = wageType && wageRateRaw ? Number(wageRateRaw) : null;
  const isSaudiNational = String(formData.get("isSaudiNational") ?? "true") === "true";
  const employeeGosiRateRaw = String(formData.get("employeeGosiRatePct") ?? "").trim();
  const employeeGosiRatePct = employeeGosiRateRaw ? Number(employeeGosiRateRaw) : null;
  const employerGosiRateRaw = String(formData.get("employerGosiRatePct") ?? "").trim();
  const employerGosiRatePct = employerGosiRateRaw ? Number(employerGosiRateRaw) : null;

  if (!siteId || !name || !role) return;
  if (!isSiteInScope(siteId, effectiveSiteId(user))) return;
  const plantId = await resolvePlantIdForSite(siteId);
  if (!plantId) return;

  const employee = await prisma.employee.create({
    data: {
      plantId,
      name,
      role,
      code,
      nationalId,
      iban,
      hireDate: hireDateRaw ? new Date(hireDateRaw) : null,
      shiftPattern,
      licenseExpiry: licenseExpiryRaw ? new Date(licenseExpiryRaw) : null,
      wageType,
      wageRate,
      isSaudiNational,
      employeeGosiRatePct,
      employerGosiRatePct,
    },
  });

  await logAudit({ module: "Employees", recordId: employee.id, afterValue: name, reasonCode: "EMPLOYEE_CREATED" });

  // Only the standard mixer-truck DRIVER role has a phone app to log
  // into (/driver) — a bulker/water-tanker/loader driver is tracked here
  // for roster/payroll purposes but never gets assigned a Trip (see the
  // driver picker in production/[id]/page.tsx, which only ever offers
  // role "DRIVER"), so there's nothing for them to log into yet.
  if (role === "DRIVER") {
    await createLoginAccountIfRequested({
      email: String(formData.get("loginEmail") ?? ""),
      password: String(formData.get("loginPassword") ?? ""),
      name,
      role: "DRIVER",
      plantId,
      employeeId: employee.id,
    });
  }

  revalidatePath("/employees");
}

// Status (ACTIVE/FROZEN/REMOVED — "removed" never a real row delete, same
// non-destructive convention as User.status) and site transfer both go
// through this one edit form, same as every other equipment/roster screen
// in this app — no separate freeze/remove/transfer actions needed.
export async function updateEmployee(formData: FormData) {
  const user = await getCurrentUser();
  await requireActionPermission(user, "employees", "updateEmployee");

  const id = String(formData.get("id") ?? "");
  const siteId = String(formData.get("siteId") ?? "");
  const name = String(formData.get("name") ?? "").trim();
  const role = await resolveRole(String(formData.get("role") ?? "").trim(), String(formData.get("newRoleName") ?? ""));
  const code = String(formData.get("code") ?? "").trim() || null;
  const nationalId = String(formData.get("nationalId") ?? "").trim() || null;
  const iban = String(formData.get("iban") ?? "").trim() || null;
  const hireDateRaw = String(formData.get("hireDate") ?? "");
  const licenseExpiryRaw = String(formData.get("licenseExpiry") ?? "");
  const shiftPattern = String(formData.get("shiftPattern") ?? "").trim();
  const status = String(formData.get("status") ?? "ACTIVE");
  const wageType = String(formData.get("wageType") ?? "").trim() || null;
  const wageRateRaw = String(formData.get("wageRate") ?? "").trim();
  const wageRate = wageType && wageRateRaw ? Number(wageRateRaw) : null;
  const isSaudiNational = String(formData.get("isSaudiNational") ?? "true") === "true";
  const employeeGosiRateRaw = String(formData.get("employeeGosiRatePct") ?? "").trim();
  const employeeGosiRatePct = employeeGosiRateRaw ? Number(employeeGosiRateRaw) : null;
  const employerGosiRateRaw = String(formData.get("employerGosiRatePct") ?? "").trim();
  const employerGosiRatePct = employerGosiRateRaw ? Number(employerGosiRateRaw) : null;

  if (!id || !siteId || !name || !role) return;
  if (!isSiteInScope(siteId, effectiveSiteId(user))) return;
  const existingEmployee = await prisma.employee.findUnique({ where: { id }, select: { plantId: true } });
  if (!existingEmployee) return;
  const plantId = await resolvePlantIdForSite(siteId, existingEmployee.plantId);
  if (!plantId) return;

  await prisma.employee.update({
    where: { id },
    data: {
      plantId,
      name,
      role,
      code,
      nationalId,
      iban,
      hireDate: hireDateRaw ? new Date(hireDateRaw) : null,
      shiftPattern,
      licenseExpiry: licenseExpiryRaw ? new Date(licenseExpiryRaw) : null,
      status,
      wageType,
      wageRate,
      isSaudiNational,
      employeeGosiRatePct,
      employerGosiRatePct,
    },
  });
  await logTransferIfChanged("Employees", id, existingEmployee.plantId, plantId);

  await logAudit({ module: "Employees", recordId: id, afterValue: name, reasonCode: "EMPLOYEE_UPDATED" });
  revalidatePath("/employees");
}

// Lets an Admin grow the "admin" tab's role picker from the screen itself
// instead of a code change — see JobTitle in schema.prisma. Silently
// no-ops on an empty or duplicate name rather than surfacing a unique-
// constraint error, since the outcome ("this title is now selectable") is
// the same either way.
export async function createJobTitle(formData: FormData) {
  const user = await getCurrentUser();
  await requireActionPermission(user, "employees", "createJobTitle");

  const name = String(formData.get("name") ?? "").trim();
  if (!name) return;

  const existing = await prisma.jobTitle.findUnique({ where: { name } });
  if (existing) return;

  const jobTitle = await prisma.jobTitle.create({ data: { name } });

  await logAudit({ module: "Employees", recordId: jobTitle.id, afterValue: name, reasonCode: "JOB_TITLE_CREATED" });
  revalidatePath("/employees");
}

// --- Pump crew (operator/assistant tabs) — separate roster, see
// PumpCrewMember in schema.prisma for why it isn't merged into Employee. --

export async function createPumpCrewMember(formData: FormData) {
  const user = await getCurrentUser();
  await requireActionPermission(user, "employees", "createPumpCrewMember");

  const siteId = String(formData.get("siteId") ?? "");
  const name = String(formData.get("name") ?? "").trim();
  const role = String(formData.get("role") ?? "OPERATOR");
  const phone = String(formData.get("phone") ?? "").trim() || null;
  const code = String(formData.get("code") ?? "").trim() || null;
  if (!siteId || !name) return;
  if (!isSiteInScope(siteId, effectiveSiteId(user))) return;
  const plantId = await resolvePlantIdForSite(siteId);
  if (!plantId) return;

  const member = await prisma.pumpCrewMember.create({ data: { plantId, name, role, phone, code } });

  await logAudit({ module: "Employees", recordId: member.id, afterValue: name, reasonCode: "PUMP_CREW_CREATED" });

  // Both OPERATOR and HELPER get the same PUMP_OPERATOR login role and
  // land on the same /pump-crew view — the two only differ in their
  // on-site duty, not in what they need to see in the app.
  await createLoginAccountIfRequested({
    email: String(formData.get("loginEmail") ?? ""),
    password: String(formData.get("loginPassword") ?? ""),
    name,
    role: "PUMP_OPERATOR",
    plantId,
    pumpCrewMemberId: member.id,
  });

  revalidatePath("/employees");
}

export async function updatePumpCrewMember(formData: FormData) {
  const user = await getCurrentUser();
  await requireActionPermission(user, "employees", "updatePumpCrewMember");

  const id = String(formData.get("id") ?? "");
  const siteId = String(formData.get("siteId") ?? "");
  const name = String(formData.get("name") ?? "").trim();
  const role = String(formData.get("role") ?? "OPERATOR");
  const phone = String(formData.get("phone") ?? "").trim() || null;
  const code = String(formData.get("code") ?? "").trim() || null;
  const status = String(formData.get("status") ?? "ACTIVE");
  if (!id || !siteId || !name) return;
  if (!isSiteInScope(siteId, effectiveSiteId(user))) return;
  const existingMember = await prisma.pumpCrewMember.findUnique({ where: { id }, select: { plantId: true } });
  if (!existingMember) return;
  const plantId = await resolvePlantIdForSite(siteId, existingMember.plantId);
  if (!plantId) return;

  await prisma.pumpCrewMember.update({ where: { id }, data: { plantId, name, role, phone, code, status } });
  await logTransferIfChanged("Employees", id, existingMember.plantId, plantId);

  await logAudit({ module: "Employees", recordId: id, afterValue: name, reasonCode: "PUMP_CREW_UPDATED" });
  revalidatePath("/employees");
}

// --- HR: attendance & leave ------------------------------------------------

// One row per employee per day, upserted — re-recording the same day (a
// correction, or filling in a check-out time later) is always an update,
// never a duplicate, thanks to the @@unique([employeeId, date]) constraint.
export async function recordAttendance(formData: FormData) {
  const user = await getCurrentUser();
  await requireActionPermission(user, "employees", "recordAttendance");

  const employeeId = String(formData.get("employeeId") ?? "");
  const dateRaw = String(formData.get("date") ?? "");
  const checkInRaw = String(formData.get("checkInAt") ?? "");
  const checkOutRaw = String(formData.get("checkOutAt") ?? "");
  const status = String(formData.get("status") ?? "PRESENT");
  const notes = String(formData.get("notes") ?? "").trim() || null;

  if (!employeeId || !dateRaw) return;
  const date = new Date(`${dateRaw}T00:00:00`);

  await prisma.attendanceRecord.upsert({
    where: { employeeId_date: { employeeId, date } },
    create: {
      employeeId,
      date,
      status,
      notes,
      checkInAt: checkInRaw ? new Date(`${dateRaw}T${checkInRaw}`) : null,
      checkOutAt: checkOutRaw ? new Date(`${dateRaw}T${checkOutRaw}`) : null,
      recordedById: user!.id,
    },
    update: {
      status,
      notes,
      checkInAt: checkInRaw ? new Date(`${dateRaw}T${checkInRaw}`) : null,
      checkOutAt: checkOutRaw ? new Date(`${dateRaw}T${checkOutRaw}`) : null,
      recordedById: user!.id,
    },
  });

  await logAudit({ module: "Employees", recordId: employeeId, afterValue: `${dateRaw} — ${status}`, reasonCode: "ATTENDANCE_RECORDED" });
  revalidatePath("/employees");
}

export async function createLeaveRequest(formData: FormData) {
  const user = await getCurrentUser();
  await requireActionPermission(user, "employees", "createLeaveRequest");

  const employeeId = String(formData.get("employeeId") ?? "");
  const type = String(formData.get("type") ?? "");
  const startDateRaw = String(formData.get("startDate") ?? "");
  const endDateRaw = String(formData.get("endDate") ?? "");
  const reason = String(formData.get("reason") ?? "").trim() || null;

  if (!employeeId || !type || !startDateRaw || !endDateRaw) return;
  const startDate = new Date(`${startDateRaw}T00:00:00`);
  const endDate = new Date(`${endDateRaw}T00:00:00`);
  if (endDate < startDate) return;
  const daysCount = Math.round((endDate.getTime() - startDate.getTime()) / 86400000) + 1;

  const leave = await withSequentialNumber(
    "LV",
    () => prisma.leaveRequest.count(),
    (requestNumber) =>
      prisma.leaveRequest.create({
        data: { requestNumber, employeeId, type, startDate, endDate, daysCount, reason, requestedById: user!.id },
      }),
  );

  await logAudit({ module: "Employees", recordId: leave.id, afterValue: `${leave.requestNumber} — ${type}, ${daysCount}d`, reasonCode: "LEAVE_REQUESTED" });
  revalidatePath("/employees");
}

// Approving IS what puts the employee "on leave" on the attendance record —
// same "the action is the effect" shape as logFieldVisit auto-advancing an
// Opportunity's stage in the Sales module. One AttendanceRecord per day in
// the range, upserted so it overwrites whatever (if anything) was already
// recorded for those days.
export async function approveLeaveRequest(formData: FormData) {
  const user = await getCurrentUser();
  await requireActionPermission(user, "employees", "approveLeaveRequest");

  const id = String(formData.get("id") ?? "");
  if (!id) return;

  const leave = await prisma.leaveRequest.findUnique({ where: { id } });
  if (!leave || leave.status !== "PENDING") return;

  await prisma.leaveRequest.update({ where: { id }, data: { status: "APPROVED", approvedAt: new Date(), approvedById: user!.id } });

  const days: Date[] = [];
  for (let d = new Date(leave.startDate); d <= leave.endDate; d.setDate(d.getDate() + 1)) days.push(new Date(d));
  for (const date of days) {
    await prisma.attendanceRecord.upsert({
      where: { employeeId_date: { employeeId: leave.employeeId, date } },
      create: { employeeId: leave.employeeId, date, status: "ON_LEAVE", recordedById: user!.id },
      update: { status: "ON_LEAVE", recordedById: user!.id },
    });
  }

  await logAudit({ module: "Employees", recordId: id, afterValue: "APPROVED", reasonCode: "LEAVE_APPROVED" });
  revalidatePath("/employees");
}

export async function rejectLeaveRequest(formData: FormData) {
  const user = await getCurrentUser();
  await requireActionPermission(user, "employees", "rejectLeaveRequest");

  const id = String(formData.get("id") ?? "");
  const rejectionNote = String(formData.get("rejectionNote") ?? "").trim();
  if (!id || !rejectionNote) return;

  const leave = await prisma.leaveRequest.findUnique({ where: { id } });
  if (!leave || leave.status !== "PENDING") return;

  await prisma.leaveRequest.update({ where: { id }, data: { status: "REJECTED", approvedAt: new Date(), approvedById: user!.id, rejectionNote } });

  await logAudit({ module: "Employees", recordId: id, afterValue: `REJECTED — ${rejectionNote}`, reasonCode: "LEAVE_REJECTED" });
  revalidatePath("/employees");
}

export async function cancelLeaveRequest(formData: FormData) {
  const user = await getCurrentUser();
  await requireActionPermission(user, "employees", "cancelLeaveRequest");

  const id = String(formData.get("id") ?? "");
  if (!id) return;

  const leave = await prisma.leaveRequest.findUnique({ where: { id } });
  if (!leave || leave.status !== "PENDING") return;

  await prisma.leaveRequest.update({ where: { id }, data: { status: "CANCELLED" } });

  await logAudit({ module: "Employees", recordId: id, afterValue: "CANCELLED", reasonCode: "LEAVE_CANCELLED" });
  revalidatePath("/employees");
}

// --- End of service (مكافأة نهاية الخدمة) ----------------------------------
// See src/lib/endOfService.ts for the actual Article 84/85 formula this
// wraps. A DAILY-wage employee has no single monthly figure on file — the
// same ×30 approximation payroll/actions.ts's own MONTHLY-vs-DAILY split
// doesn't need to make (daily pay is already period-actual there), but a
// gratuity calculation has no period to be actual over, so this is the one
// place in the app that has to guess a monthly-equivalent from a daily
// rate. Flagged in the UI, not hidden.
export async function calculateEndOfServiceSettlement(formData: FormData) {
  const user = await getCurrentUser();
  await requireActionPermission(user, "employees", "calculateEndOfService");

  const employeeId = String(formData.get("employeeId") ?? "");
  const terminationDateRaw = String(formData.get("terminationDate") ?? "");
  const terminationTypeRaw = String(formData.get("terminationType") ?? "");
  const notes = String(formData.get("notes") ?? "").trim() || null;
  if (!employeeId || !terminationDateRaw || !TERMINATION_TYPES.includes(terminationTypeRaw as TerminationType)) return;
  const terminationType = terminationTypeRaw as TerminationType;

  const employee = await prisma.employee.findUnique({ where: { id: employeeId } });
  if (!employee || !employee.hireDate || !employee.wageRate || !employee.wageType) return;

  const terminationDate = new Date(terminationDateRaw);
  if (terminationDate < employee.hireDate) return;
  const basicMonthlySalary = employee.wageType === "MONTHLY" ? employee.wageRate : employee.wageRate * 30;

  const result = calculateEndOfServiceEntitlement({
    hireDate: employee.hireDate,
    terminationDate,
    terminationType,
    basicMonthlySalary,
  });

  const settlement = await withSequentialNumber(
    "EOS",
    () => prisma.endOfServiceSettlement.count(),
    (settlementNumber) =>
      prisma.endOfServiceSettlement.create({
        data: {
          settlementNumber,
          employeeId,
          hireDate: employee.hireDate!,
          terminationDate,
          terminationType,
          yearsOfService: result.yearsOfService,
          basicMonthlySalary,
          grossEntitlement: result.grossEntitlement,
          payableAmount: result.payableAmount,
          notes,
          calculatedById: user!.id,
        },
      }),
  );

  await logAudit({
    module: "Employees",
    recordId: settlement.id,
    afterValue: `${settlement.settlementNumber} — ${result.payableAmount.toFixed(2)} (${terminationType})`,
    reasonCode: "END_OF_SERVICE_CALCULATED",
  });
  revalidatePath("/employees");
}

// Only ever a real record correction while nothing has been paid yet — a
// wrong termination date/type gets cancelled and recalculated from
// scratch, not edited in place, same "the audit record doesn't get
// silently rewritten" reasoning as every other financial document here.
export async function cancelEndOfServiceSettlement(formData: FormData) {
  const user = await getCurrentUser();
  await requireActionPermission(user, "employees", "cancelEndOfServiceSettlement");

  const id = String(formData.get("id") ?? "");
  if (!id) return;

  const settlement = await prisma.endOfServiceSettlement.findUnique({ where: { id } });
  if (!settlement || settlement.status !== "CALCULATED") return;

  await prisma.endOfServiceSettlement.update({ where: { id }, data: { status: "CANCELLED" } });

  await logAudit({ module: "Employees", recordId: id, afterValue: "CANCELLED", reasonCode: "END_OF_SERVICE_CANCELLED" });
  revalidatePath("/employees");
}

// The real point of no return — posts the payout to the site's own cash
// ledger (same postCashTransaction/withSequentialNumber pairing every
// other cash-moving action in this app already uses) and, since a paid
// gratuity settlement only ever happens because the person is actually
// leaving, flips the employee to REMOVED here rather than requiring a
// separate manual status edit — same "the action IS the effect" shape as
// approveLeaveRequest marking attendance ON_LEAVE.
export async function markEndOfServiceSettlementPaid(formData: FormData) {
  const user = await getCurrentUser();
  await requireActionPermission(user, "employees", "markEndOfServiceSettlementPaid");

  const id = String(formData.get("id") ?? "");
  if (!id) return;

  const settlement = await prisma.endOfServiceSettlement.findUnique({
    where: { id },
    include: { employee: { include: { plant: true } } },
  });
  if (!settlement || settlement.status !== "CALCULATED") return;
  if (settlement.payableAmount <= 0) return;

  const plant = settlement.employee.plant;
  const description = `End of service — ${settlement.employee.name} (${settlement.settlementNumber})`;

  await prisma.$transaction(async (tx) => {
    const txn = await withSequentialNumber(
      "TXN",
      () => tx.cashTransaction.count(),
      (txnNumber) =>
        tx.cashTransaction.create({
          data: {
            txnNumber,
            siteId: plant.siteId,
            direction: "OUT",
            category: "END_OF_SERVICE",
            amount: settlement.payableAmount,
            currency: plant.currency,
            description,
            occurredAt: new Date(),
            createdById: user!.id,
          },
        }),
    );
    await postCashTransaction(tx, { siteId: plant.siteId, currency: plant.currency, txnId: txn.id, direction: "OUT", category: "END_OF_SERVICE", amount: settlement.payableAmount, description });
    await tx.endOfServiceSettlement.update({ where: { id }, data: { status: "PAID", paidAt: new Date() } });
    await tx.employee.update({ where: { id: settlement.employeeId }, data: { status: "REMOVED" } });
  }, TX_OPTIONS);

  await logAudit({ module: "Employees", recordId: id, afterValue: "PAID", reasonCode: "END_OF_SERVICE_PAID" });
  revalidatePath("/employees");
  revalidatePath("/finance");
}
