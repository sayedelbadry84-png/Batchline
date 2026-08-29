import "server-only";
import { cookies } from "next/headers";

// Same shape as getLocale (src/lib/i18n/index.ts) — a cookie read server-
// side so <html data-theme> is correct on the very first byte, no
// client-side script and no flash-of-wrong-theme to work around. null
// means "no explicit choice yet", which leaves the @media
// (prefers-color-scheme: dark) rule in globals.css to decide.
export const THEME_COOKIE = "batchline_theme";
export type Theme = "light" | "dark";

export async function getTheme(): Promise<Theme | null> {
  const store = await cookies();
  const value = store.get(THEME_COOKIE)?.value;
  return value === "light" || value === "dark" ? value : null;
}
