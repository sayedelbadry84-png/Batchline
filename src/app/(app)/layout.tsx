import { redirect } from "next/navigation";
import { getCurrentUser } from "@/lib/session";
import { getDictionary } from "@/lib/i18n";
import { getAccessibleModules } from "@/lib/permissions";
import { Sidebar } from "@/components/Sidebar";

export default async function AppLayout({ children }: LayoutProps<"/">) {
  const user = await getCurrentUser();
  if (!user) redirect("/login");
  // Drivers have their own phone-first surface — the back office isn't for them.
  if (user.role === "DRIVER") redirect("/driver");

  const { locale, dict } = await getDictionary();
  // Computed here, not inside Sidebar — permissions are database-backed
  // now (see src/lib/permissions.ts), and Sidebar is a Client Component
  // that can't reach the database itself.
  const allowedModules = await getAccessibleModules(user.role);

  return (
    <div className="flex min-h-full">
      <Sidebar
        user={{ name: user.name, role: user.role }}
        allowedModules={allowedModules}
        nav={dict.nav}
        common={dict.common}
        locale={locale}
      />
      <main className="min-w-0 flex-1 px-10 py-8">{children}</main>
    </div>
  );
}
