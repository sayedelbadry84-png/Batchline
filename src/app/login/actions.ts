"use server";

import bcrypt from "bcryptjs";
import { prisma } from "@/lib/prisma";
import { createSession, destroySession, setPending2faUser, getPending2faUserId, clearPending2fa } from "@/lib/session";
import { getClientIp, isIpRateLimited, recordFailedAttempt } from "@/lib/rateLimit";
import { consumeTotpCode, recordAccountFailure } from "@/lib/loginSecurity";
import { redirect } from "next/navigation";

// Same cost as provisioned passwords; missing/disabled accounts must do
// comparable password work instead of exposing a fast enumeration path.
const DUMMY_PASSWORD_HASH = bcrypt.hashSync("not-a-login-password", 10);

// DRIVER and PUMP_OPERATOR each have their own phone-first surface instead
// of the back-office sidebar — see the matching redirect in
// src/app/(app)/layout.tsx, and the exclusion of both roles from
// ASSIGNABLE_ROLES/getAllRoles in src/lib/permissions.ts.
function postLoginPath(role: string): string {
  if (role === "DRIVER") return "/driver";
  if (role === "PUMP_OPERATOR") return "/pump-crew";
  return "/";
}

export async function login(formData: FormData) {
  const email = String(formData.get("email") ?? "").trim().toLowerCase();
  const password = String(formData.get("password") ?? "");

  if (!email || !password) redirect("/login?error=1");

  const ip = await getClientIp();
  if (await isIpRateLimited(ip)) redirect("/login?error=1");

  const user = await prisma.user.findUnique({ where: { email } });
  const valid = await bcrypt.compare(password, user?.passwordHash ?? DUMMY_PASSWORD_HASH);
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

  if (!valid) {
    await recordFailedAttempt(ip);
    await recordAccountFailure(user.id);
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
  redirect(postLoginPath(user.role));
}

export async function verifyTotpLogin(formData: FormData) {
  const code = String(formData.get("code") ?? "");
  const userId = await getPending2faUserId();
  if (!userId) redirect("/login");

  const ip = await getClientIp();
  if (await isIpRateLimited(ip)) redirect("/login?error=1");

  const user = await prisma.user.findUnique({ where: { id: userId } });
  if (!user || user.status !== "ACTIVE" || (user.lockedUntil && user.lockedUntil > new Date()) || !user.totpEnabled || !user.totpSecret) {
    await clearPending2fa();
    redirect("/login");
  }

  if (!(await consumeTotpCode(user.id, user.totpSecret, code))) {
    await recordFailedAttempt(ip);
    await recordAccountFailure(user.id);
    redirect("/login/verify?error=1");
  }

  await clearPending2fa();
  await destroySession();
  await createSession(user.id);
  redirect(postLoginPath(user.role));
}

export async function logout() {
  await destroySession();
  redirect("/login");
}
