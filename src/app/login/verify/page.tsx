import { redirect } from "next/navigation";
import { getPending2faUserId } from "@/lib/session";
import { verifyTotpLogin } from "../actions";
import { getDictionary } from "@/lib/i18n";

export default async function VerifyTotpPage({
  searchParams,
}: {
  searchParams: Promise<{ error?: string }>;
}) {
  const userId = await getPending2faUserId();
  if (!userId) redirect("/login");

  const { error } = await searchParams;
  const { dict } = await getDictionary();
  const t = dict.login.twoFactor;

  return (
    <div className="mx-auto flex min-h-screen max-w-sm flex-col justify-center gap-6 bg-bg px-6 py-10">
      <div>
        <span className="font-display text-2xl font-semibold tracking-tight">{t.title}</span>
        <p className="mt-1 text-sm text-ink-muted">{t.intro}</p>
      </div>

      {error && <div className="rounded-md bg-critical-soft px-3 py-2 text-sm text-critical">{t.error}</div>}

      <form action={verifyTotpLogin} className="flex flex-col gap-3">
        <div>
          <label className="mb-1 block text-xs font-medium text-ink-muted">{t.codeLabel}</label>
          <input
            name="code"
            type="text"
            inputMode="numeric"
            pattern="[0-9]{6}"
            maxLength={6}
            required
            autoFocus
            dir="ltr"
            className="w-full rounded-md border border-border bg-surface px-3 py-2.5 text-center font-mono text-lg tracking-[0.5em]"
            placeholder="000000"
          />
        </div>
        <button className="mt-2 rounded-md bg-accent px-4 py-2.5 text-sm font-medium text-white hover:bg-accent-strong">
          {t.verify}
        </button>
      </form>
    </div>
  );
}
