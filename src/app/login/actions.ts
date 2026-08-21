"use server";

import bcrypt from "bcryptjs";
import { prisma } from "@/lib/prisma";
import { createSession, destroySession } from "@/lib/session";
import { redirect } from "next/navigation";

const MAX_FAILED_ATTEMPTS = 5;
const LOCKOUT_MINUTES = 15;

export async function login(formData: FormData) {
  const email = String(formData.get("email") ?? "").trim().toLowerCase();
  const password = String(formData.get("password") ?? "");

  if (!email || !password) redirect("/login?error=1");

  const user = await prisma.user.findUnique({ where: { email } });
  if (!user) redirect("/login?error=1");

  // Locked accounts fail with the exact same generic error as a wrong
  // password — a distinct "locked" message would let an attacker use the
  // lockout itself to fingerprint which emails have real accounts.
  if (user.lockedUntil && user.lockedUntil > new Date()) redirect("/login?error=1");

  const valid = await bcrypt.compare(password, user.passwordHash);
  if (!valid) {
    const failedLoginAttempts = user.failedLoginAttempts + 1;
    const lockedUntil =
      failedLoginAttempts >= MAX_FAILED_ATTEMPTS
        ? new Date(Date.now() + LOCKOUT_MINUTES * 60 * 1000)
        : null;
    await prisma.user.update({ where: { id: user.id }, data: { failedLoginAttempts, lockedUntil } });
    redirect("/login?error=1");
  }

  if (user.failedLoginAttempts > 0 || user.lockedUntil) {
    await prisma.user.update({ where: { id: user.id }, data: { failedLoginAttempts: 0, lockedUntil: null } });
  }

  // Logging in again without signing out first shouldn't leave the previous
  // session orphaned in the database.
  await destroySession();
  await createSession(user.id);
  redirect(user.role === "DRIVER" ? "/driver" : "/");
}

export async function logout() {
  await destroySession();
  redirect("/login");
}
