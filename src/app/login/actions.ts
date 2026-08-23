"use server";

import bcrypt from "bcryptjs";
import { prisma } from "@/lib/prisma";
import { createSession, destroySession, setPending2faUser, getPending2faUserId, clearPending2fa } from "@/lib/session";
import { getClientIp, isIpRateLimited, recordFailedAttempt } from "@/lib/rateLimit";
import { verifyTotpCode } from "@/lib/totp";
import { redirect } from "next/navigation";

const MAX_FAILED_ATTEMPTS = 5;
const LOCKOUT_MINUTES = 15;

export async function login(formData: FormData) {
  const email = String(formData.get("email") ?? "").trim().toLowerCase();
  const password = String(formData.get("password") ?? "");

  if (!email || !password) redirect("/login?error=1");

  const ip = await getClientIp();
  if (await isIpRateLimited(ip)) redirect("/login?error=1");

  const user = await prisma.user.findUnique({ where: { email } });
  if (!user) {
    await recordFailedAttempt(ip);
    redirect("/login?error=1");
  }

  // Disabled accounts fail with the exact same generic error as a wrong
  // password, for the same reason as the lockout below.
  if (user.status !== "ACTIVE") {
    await recordFailedAttempt(ip);
    redirect("/login?error=1");
  }

  // Locked accounts fail with the exact same generic error as a wrong
  // password — a distinct "locked" message would let an attacker use the
  // lockout itself to fingerprint which emails have real accounts.
  if (user.lockedUntil && user.lockedUntil > new Date()) {
    await recordFailedAttempt(ip);
    redirect("/login?error=1");
  }

  const valid = await bcrypt.compare(password, user.passwordHash);
  if (!valid) {
    await recordFailedAttempt(ip);
    const failedLoginAttempts = user.failedLoginAttempts + 1;
    const lockedUntil =
      failedLoginAttempts >= MAX_FAILED_ATTEMPTS
        ? new Date(Date.now() + LOCKOUT_MINUTES * 60 * 1000)
        : null;
    await prisma.user.update({ where: { id: user.id }, data: { failedLoginAttempts, lockedUntil } });
    redirect("/login?error=1");
  }

  if (user.totpEnabled) {
    // Password alone isn't enough yet — hold off on resetting the failed-
    // attempt counter and creating a real session until the TOTP step
    // also passes (see verifyTotpLogin).
    await setPending2faUser(user.id);
    redirect("/login/verify");
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

export async function verifyTotpLogin(formData: FormData) {
  const code = String(formData.get("code") ?? "");
  const userId = await getPending2faUserId();
  if (!userId) redirect("/login");

  const ip = await getClientIp();
  if (await isIpRateLimited(ip)) redirect("/login?error=1");

  const user = await prisma.user.findUnique({ where: { id: userId } });
  if (!user || !user.totpEnabled || !user.totpSecret) {
    await clearPending2fa();
    redirect("/login");
  }

  if (!verifyTotpCode(user.totpSecret, code)) {
    await recordFailedAttempt(ip);
    const failedLoginAttempts = user.failedLoginAttempts + 1;
    const lockedUntil =
      failedLoginAttempts >= MAX_FAILED_ATTEMPTS
        ? new Date(Date.now() + LOCKOUT_MINUTES * 60 * 1000)
        : null;
    await prisma.user.update({ where: { id: user.id }, data: { failedLoginAttempts, lockedUntil } });
    redirect("/login/verify?error=1");
  }

  await prisma.user.update({ where: { id: user.id }, data: { failedLoginAttempts: 0, lockedUntil: null } });
  await clearPending2fa();
  await destroySession();
  await createSession(user.id);
  redirect(user.role === "DRIVER" ? "/driver" : "/");
}

export async function logout() {
  await destroySession();
  redirect("/login");
}
