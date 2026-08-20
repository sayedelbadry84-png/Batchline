import { Sidebar } from "@/components/Sidebar";

export default function AppLayout({ children }: LayoutProps<"/">) {
  return (
    <div className="flex min-h-full">
      <Sidebar />
      <main className="min-w-0 flex-1 px-10 py-8">{children}</main>
    </div>
  );
}
