"use server";

import { prisma } from "@/lib/prisma";
import { logAudit } from "@/lib/audit";
import { getCurrentUser, requireRole } from "@/lib/session";
import { effectiveSiteId, isSiteInScope, resolvePlantIdForSite } from "@/lib/siteScope";
import { logTransferIfChanged } from "@/lib/transferAudit";
import { OTHER_ROLE_SENTINEL } from "@/lib/employeeRole";
import { withSequentialNumber } from "@/lib/sequence";
import { revalidatePath } from "next/cache";

const HR_ROLES = ["ADMIN", "PLANT_ADMIN"];

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
  requireRole(user, ["ADMIN"]);

  const siteId = String(formData.get("siteId") ?? "");
  const name = String(formData.get("name") ?? "").trim();
  const role = await resolveRole(String(formData.get("role") ?? "").trim(), String(formData.get("newRoleName") ?? ""));
  const code = String(formData.get("code") ?? "").trim() || null;
  const licenseExpiryRaw = String(formData.get("licenseExpiry") ?? "");
  const shiftPattern = String(formData.get("shiftPattern") ?? "").trim();

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
      shiftPattern,
      licenseExpiry: licenseExpiryRaw ? new Date(licenseExpiryRaw) : null,
    },
  });

  await logAudit({ module: "Employees", recordId: employee.id, afterValue: name, reasonCode: "EMPLOYEE_CREATED" });
  revalidatePath("/employees");
}

// Status (ACTIVE/FROZEN/REMOVED — "removed" never a real row delete, same
// non-destructive convention as User.status) and site transfer both go
// through this one edit form, same as every other equipment/roster screen
// in this app — no separate freeze/remove/transfer actions needed.
export async function updateEmployee(formData: FormData) {
  const user = await getCurrentUser();
  requireRole(user, ["ADMIN"]);

  const id = String(formData.get("id") ?? "");
  const siteId = String(formData.get("siteId") ?? "");
  const name = String(formData.get("name") ?? "").trim();
  const role = await resolveRole(String(formData.get("role") ?? "").trim(), String(formData.get("newRoleName") ?? ""));
  const code = String(formData.get("code") ?? "").trim() || null;
  const licenseExpiryRaw = String(formData.get("licenseExpiry") ?? "");
  const shiftPattern = String(formData.get("shiftPattern") ?? "").trim();
  const status = String(formData.get("status") ?? "ACTIVE");

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
      shiftPattern,
      licenseExpiry: licenseExpiryRaw ? new Date(licenseExpiryRaw) : null,
      status,
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
  requireRole(user, ["ADMIN"]);

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
  requireRole(user, ["PLANT_OPERATOR", "ADMIN"]);

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
  revalidatePath("/employees");
}

export async function updatePumpCrewMember(formData: FormData) {
  const user = await getCurrentUser();
  requireRole(user, ["PLANT_OPERATOR", "ADMIN"]);

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
  requireRole(user, HR_ROLES);

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
  requireRole(user, HR_ROLES);

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
  requireRole(user, HR_ROLES);

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
  requireRole(user, HR_ROLES);

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
  requireRole(user, HR_ROLES);

  const id = String(formData.get("id") ?? "");
  if (!id) return;

  const leave = await prisma.leaveRequest.findUnique({ where: { id } });
  if (!leave || leave.status !== "PENDING") return;

  await prisma.leaveRequest.update({ where: { id }, data: { status: "CANCELLED" } });

  await logAudit({ module: "Employees", recordId: id, afterValue: "CANCELLED", reasonCode: "LEAVE_CANCELLED" });
  revalidatePath("/employees");
}
