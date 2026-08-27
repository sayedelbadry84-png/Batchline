"use server";

import { cookies, headers } from "next/headers";
import { redirect } from "next/navigation";
import { prisma } from "@/lib/prisma";
import { getCurrentUser } from "@/lib/session";
import { ACTIVE_SITE_COOKIE } from "@/lib/siteScope";

// Sets (or clears, on an empty value) the admin-only "which plant am I
// currently viewing" preference — see getActiveSiteId in
// src/lib/siteScope.ts for how every screen reads it back. Only ADMIN can
// ever have an unrestricted view to narrow in the first place; every
// other role is already pinned to their one site and has nothing to pick.
export async function setActiveSite(formData: FormData) {
  const user = await getCurrentUser();
  if (!user || user.role !== "ADMIN") return;

  const siteId = String(formData.get("siteId") ?? "").trim();
  const store = await cookies();
  if (!siteId) {
    store.delete(ACTIVE_SITE_COOKIE);
  } else {
    const site = await prisma.site.findUnique({ where: { id: siteId }, select: { id: true } });
    if (!site) return;
    store.set(ACTIVE_SITE_COOKIE, siteId, { path: "/", maxAge: 60 * 60 * 24 * 365 });
  }

  const referer = (await headers()).get("referer");
  redirect(referer ?? "/");
}
