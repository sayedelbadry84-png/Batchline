import { redirect } from "next/navigation";
import { getCurrentUser } from "@/lib/session";
import { getDictionary } from "@/lib/i18n";
import { Sidebar } from "@/components/Sidebar";

export default async function AppLayout({ children }: LayoutProps<"/">) {
  const user = await getCurrentUser();
  if (!user) redirect("/login");
  // Drivers have their own phone-first surface — the back office isn't for them.
  if (user.role === "DRIVER") redirect("/driver");

  const { locale, dict } = await getDictionary();

  return (
    <div className="flex min-h-full">
      <Sidebar user={{ name: user.name, role: user.role }} nav={dict.nav} common={dict.common} locale={locale} />
      <main className="min-w-0 flex-1 px-10 py-8">{children}</main>
    </div>
  );
}
