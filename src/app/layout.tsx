import type { Metadata } from "next";
import { Oswald, IBM_Plex_Sans, IBM_Plex_Sans_Arabic, IBM_Plex_Mono } from "next/font/google";
import { getLocale } from "@/lib/i18n";
import { dirFor } from "@/lib/i18n/config";
import "./globals.css";

const oswald = Oswald({
  variable: "--font-oswald",
  subsets: ["latin"],
  weight: ["400", "500", "600", "700"],
});

const plexSans = IBM_Plex_Sans({
  variable: "--font-plex-sans",
  subsets: ["latin"],
  weight: ["400", "500", "600"],
});

const plexSansArabic = IBM_Plex_Sans_Arabic({
  variable: "--font-plex-sans-arabic",
  subsets: ["arabic"],
  weight: ["400", "500", "600"],
});

const plexMono = IBM_Plex_Mono({
  variable: "--font-plex-mono",
  subsets: ["latin"],
  weight: ["400", "500"],
});

export const metadata: Metadata = {
  title: "Batchline — Plant Operations",
  description: "Ready-mix concrete plant management",
};

// Shared by both surfaces: the back-office app (src/app/(app), sidebar layout)
// and the driver mobile app (src/app/driver, its own minimal layout) — this
// root sets up fonts, locale direction, and the HTML shell.
export default async function RootLayout({ children }: LayoutProps<"/">) {
  const locale = await getLocale();

  return (
    <html
      lang={locale}
      dir={dirFor(locale)}
      className={`${oswald.variable} ${plexSans.variable} ${plexSansArabic.variable} ${plexMono.variable} h-full`}
    >
      <body className="min-h-full font-sans antialiased">{children}</body>
    </html>
  );
}
