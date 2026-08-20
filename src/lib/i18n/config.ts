export const LOCALES = ["ar", "en"] as const;
export type Locale = (typeof LOCALES)[number];

// Arabic-first per the system design spec ("default Arabic language").
// English stays fully supported as an explicit switch.
export const DEFAULT_LOCALE: Locale = "ar";

export const LOCALE_COOKIE = "batchline_locale";

export function isLocale(value: string | undefined): value is Locale {
  return !!value && (LOCALES as readonly string[]).includes(value);
}

export function dirFor(locale: Locale): "rtl" | "ltr" {
  return locale === "ar" ? "rtl" : "ltr";
}
