"use server";

import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import { revalidatePath } from "next/cache";
import { prisma } from "@/lib/prisma";
import { logAudit } from "@/lib/audit";
import { getCurrentUser, requireRole } from "@/lib/session";
import { generateApiKey } from "@/lib/apiKeys";
import { NEW_KEY_REVEAL_COOKIE } from "./constants";

// Holds the raw key just long enough for the Admin to copy it — a short
// httpOnly cookie rather than a URL query param, so the secret never lands
// in the browser's address bar, history, or any server access log. Cleared
// either by its own 60s expiry or by the "I've copied it" button below.

export async function createApiKey(formData: FormData) {
  const user = await getCurrentUser();
  requireRole(user, ["ADMIN"]);

  const label = String(formData.get("label") ?? "").trim();
  const scope = String(formData.get("scope") ?? "ALL");
  if (!label || !["ALL", "TELEMATICS", "SCADA", "REPORTS"].includes(scope)) return;

  const { raw, hash, prefix } = generateApiKey();
  await prisma.apiKey.create({
    data: { label, keyHash: hash, keyPrefix: prefix, scope, createdById: user!.id },
  });

  await logAudit({ module: "Integrations", recordId: prefix, afterValue: `${label} (${scope})`, reasonCode: "API_KEY_CREATED" });

  const store = await cookies();
  store.set(NEW_KEY_REVEAL_COOKIE, raw, {
    path: "/integrations",
    httpOnly: true,
    sameSite: "lax",
    secure: process.env.NODE_ENV === "production",
    maxAge: 60,
  });

  revalidatePath("/integrations");
  redirect("/integrations");
}

export async function dismissNewApiKeyReveal() {
  const store = await cookies();
  store.delete(NEW_KEY_REVEAL_COOKIE);
  redirect("/integrations");
}

export async function revokeApiKey(formData: FormData) {
  const user = await getCurrentUser();
  requireRole(user, ["ADMIN"]);

  const id = String(formData.get("id") ?? "");
  if (!id) return;

  await prisma.apiKey.update({ where: { id }, data: { revokedAt: new Date() } });
  await logAudit({ module: "Integrations", recordId: id, reasonCode: "API_KEY_REVOKED" });
  revalidatePath("/integrations");
}
