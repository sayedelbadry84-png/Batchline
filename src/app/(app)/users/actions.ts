"use server";

import bcrypt from "bcryptjs";
import { prisma } from "@/lib/prisma";
import { logAudit } from "@/lib/audit";
import { getCurrentUser, requireRole } from "@/lib/session";
import { revalidatePath } from "next/cache";

const SALT_ROUNDS = 10;

export async function createUser(formData: FormData) {
  const actor = await getCurrentUser();
  requireRole(actor, ["ADMIN"]);

  const email = String(formData.get("email") ?? "").trim().toLowerCase();
  const name = String(formData.get("name") ?? "").trim();
  const password = String(formData.get("password") ?? "");
  const role = String(formData.get("role") ?? "").trim();
  const plantId = String(formData.get("plantId") ?? "") || null;
  const employeeId = String(formData.get("employeeId") ?? "") || null;

  if (!email || !name || !password || !role) return;
  if (password.length < 8) return;

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
  const plantId = String(formData.get("plantId") ?? "") || null;
  const employeeId = String(formData.get("employeeId") ?? "") || null;
  const status = String(formData.get("status") ?? "ACTIVE");

  if (!id || !name || !role) return;

  await prisma.user.update({
    where: { id },
    data: { name, role, plantId, employeeId, status },
  });

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

  await logAudit({ module: "Users", recordId: id, reasonCode: "USER_PASSWORD_RESET" });
  revalidatePath("/users");
}
