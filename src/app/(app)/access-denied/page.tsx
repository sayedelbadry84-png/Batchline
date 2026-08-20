import Link from "next/link";
import { ui } from "@/lib/ui";

export default async function AccessDeniedPage({
  searchParams,
}: {
  searchParams: Promise<{ module?: string }>;
}) {
  const { module } = await searchParams;

  return (
    <div className="flex flex-col gap-4">
      <div className={ui.eyebrow}>Access denied</div>
      <h1 className={ui.h1}>Your role can&apos;t open this</h1>
      <p className={`${ui.intro} max-w-xl`}>
        {module ? (
          <>
            Your account doesn&apos;t have access to <span className="font-mono text-ink">{module}</span>. This
            isn&apos;t a bug — it&apos;s the same role check the write actions enforce, applied to viewing the page
            too.
          </>
        ) : (
          "Your account doesn't have access to this page."
        )}
      </p>
      <Link href="/" className={`${ui.button} self-start`}>
        Back to dashboard
      </Link>
    </div>
  );
}
