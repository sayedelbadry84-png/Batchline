"use server";

import { cookies, headers } from "next/headers";
import { redirect } from "next/navigation";
import { THEME_COOKIE } from "@/lib/theme";

// Mirrors setLocale (src/app/locale-actions.ts) exactly — a cookie write
// plus a redirect back to whatever page the toggle was clicked from.
export async function setTheme(formData: FormData) {
  const theme = String(formData.get("theme") ?? "");
  if (theme !== "light" && theme !== "dark") return;

  const store = await cookies();
  store.set(THEME_COOKIE, theme, { path: "/", maxAge: 60 * 60 * 24 * 365 });

  const referer = (await headers()).get("referer");
  redirect(referer ?? "/");
}
