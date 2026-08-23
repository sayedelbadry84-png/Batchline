"use server";

import bcrypt from "bcryptjs";
import { prisma } from "@/lib/prisma";
import { logAudit } from "@/lib/audit";
import { getCurrentUser } from "@/lib/session";
import { generateTotpSecret, verifyTotpCode } from "@/lib/totp";
import { revalidatePath } from "next/cache";

// Generates a fresh secret and stashes it as UNCONFIRMED — see
// User.totpTempSecret in schema.prisma. Re-running this (e.g. the user
// lost the setup screen) simply replaces the pending secret; nothing is
// enabled until confirmTotpSetup succeeds.
export async function startTotpSetup() {
  const user = await getCurrentUser();
  if (!user) return;

  const secret = generateTotpSecret();
  await prisma.user.update({ where: { id: user.id }, data: { totpTempSecret: secret } });
  revalidatePath("/account");
}

export async function cancelTotpSetup() {
  const user = await getCurrentUser();
  if (!user) return;
  await prisma.user.update({ where: { id: user.id }, data: { totpTempSecret: null } });
  revalidatePath("/account");
}

export async function confirmTotpSetup(formData: FormData) {
  const user = await getCurrentUser();
  if (!user) return;

  const fresh = await prisma.user.findUnique({ where: { id: user.id } });
  if (!fresh?.totpTempSecret) return;

  const code = String(formData.get("code") ?? "");
  if (!verifyTotpCode(fresh.totpTempSecret, code)) {
    revalidatePath("/account");
    return;
  }

  await prisma.user.update({
    where: { id: user.id },
    data: { totpSecret: fresh.totpTempSecret, totpTempSecret: null, totpEnabled: true },
  });
  await logAudit({ module: "Account", recordId: user.id, reasonCode: "TOTP_ENABLED" });
  revalidatePath("/account");
}

// Requires the current password, not just an active session — a second
// factor shouldn't be removable by anyone who merely finds an unattended,
// still-logged-in browser tab.
export async function disableTotp(formData: FormData) {
  const user = await getCurrentUser();
  if (!user) return;

  const password = String(formData.get("password") ?? "");
  const fresh = await prisma.user.findUnique({ where: { id: user.id } });
  if (!fresh) return;

  const valid = await bcrypt.compare(password, fresh.passwordHash);
  if (!valid) {
    revalidatePath("/account");
    return;
  }

  await prisma.user.update({ where: { id: user.id }, data: { totpEnabled: false, totpSecret: null, totpTempSecret: null } });
  await logAudit({ module: "Account", recordId: user.id, reasonCode: "TOTP_DISABLED" });
  revalidatePath("/account");
}
