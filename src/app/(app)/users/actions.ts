"use server";

import bcrypt from "bcryptjs";
import { prisma } from "@/lib/prisma";
import { logAudit } from "@/lib/audit";
import { getCurrentUser, requireRole } from "@/lib/session";
import { resolvePlantIdForSite } from "@/lib/siteScope";
import { revalidatePath } from "next/cache";

const SALT_ROUNDS = 10;

export async function createUser(formData: FormData) {
  const actor = await getCurrentUser();
  requireRole(actor, ["ADMIN"]);

  const email = String(formData.get("email") ?? "").trim().toLowerCase();
  const name = String(formData.get("name") ?? "").trim();
  const password = String(formData.get("password") ?? "");
  const role = String(formData.get("role") ?? "").trim();
  // Registered by Plant code, not a specific Station — same reasoning as
  // Employees/pump crew (see resolvePlantIdForSite in siteScope.ts). An
  // ADMIN account needs no home plant at all, so a blank siteId stays
  // plantId null rather than trying to resolve one.
  const siteId = String(formData.get("siteId") ?? "") || null;
  const employeeId = String(formData.get("employeeId") ?? "") || null;

  if (!email || !name || !password || !role) return;
  if (password.length < 8) return;

  const plantId = siteId ? await resolvePlantIdForSite(siteId) : null;

  const passwordHash = await bcrypt.hash(password, SALT_ROUNDS);

  const user = await prisma.user.create({
    data: { email, name, passwordHash, role, plantId, employeeId },
  });

  await logAudit({ module: "Users", recordId: user.id, afterValue: `${email} / ${role}`, reasonCode: "USER_CREATED" });
  revalidatePath("/users");
}

// Role, plant, employee link, and account status — deliberately not
// password, so a save here can never silently clear or reuse a stale
// password field left in the form. See resetUserPassword for that.
export async function updateUser(formData: FormData) {
  const actor = await getCurrentUser();
  requireRole(actor, ["ADMIN"]);

  const id = String(formData.get("id") ?? "");
  const name = String(formData.get("name") ?? "").trim();
  const role = String(formData.get("role") ?? "").trim();
  const siteId = String(formData.get("siteId") ?? "") || null;
  const employeeId = String(formData.get("employeeId") ?? "") || null;
  const status = String(formData.get("status") ?? "ACTIVE");

  if (!id || !name || !role) return;

  const existing = await prisma.user.findUnique({ where: { id }, select: { plantId: true, role: true, status: true } });
  if (!existing) return;
  const plantId = siteId ? await resolvePlantIdForSite(siteId, existing.plantId) : null;

  await prisma.user.update({
    where: { id },
    data: { name, role, plantId, employeeId, status },
  });

  // getCurrentUser already rejects a session the instant status flips off
  // ACTIVE (it re-checks on every request), so that specific case was
  // never actually exploitable — but a role change previously left an
  // already-open session logged in under the OLD role's own page/nav
  // state until they next navigated, and there was no "kick them out
  // right now" lever at all for either case. Deleting the sessions here
  // makes both immediate rather than eventually-consistent.
  if (existing.role !== role || existing.status !== status) {
    await prisma.session.deleteMany({ where: { userId: id } });
  }

  await logAudit({ module: "Users", recordId: id, afterValue: `${role} / ${status}`, reasonCode: "USER_UPDATED" });
  revalidatePath("/users");
}

// A fresh password also clears any brute-force lockout — an admin resetting
// a password is exactly the recovery path for someone locked out.
export async function resetUserPassword(formData: FormData) {
  const actor = await getCurrentUser();
  requireRole(actor, ["ADMIN"]);

  const id = String(formData.get("id") ?? "");
  const password = String(formData.get("password") ?? "");
  if (!id || password.length < 8) return;

  const passwordHash = await bcrypt.hash(password, SALT_ROUNDS);
  await prisma.user.update({
    where: { id },
    data: { passwordHash, failedLoginAttempts: 0, lockedUntil: null },
  });

  // A password reset is often exactly the response to a suspected
  // compromise — leaving a session opened under the OLD password still
  // valid afterward would defeat the point: whoever had that cookie stays
  // logged in regardless of the new password until it naturally expires.
  await prisma.session.deleteMany({ where: { userId: id } });

  await logAudit({ module: "Users", recordId: id, reasonCode: "USER_PASSWORD_RESET" });
  revalidatePath("/users");
}
