import { login } from "./actions";
import { setLocale } from "@/app/locale-actions";
import { getDictionary } from "@/lib/i18n";

export default async function LoginPage({
  searchParams,
}: {
  searchParams: Promise<{ error?: string }>;
}) {
  const { error } = await searchParams;
  const { locale, dict } = await getDictionary();

  return (
    <div className="mx-auto flex min-h-screen max-w-sm flex-col justify-center gap-6 bg-bg px-6 py-10">
      <div className="flex items-start justify-between">
        <div>
          <span className="font-display text-2xl font-semibold tracking-tight">{dict.login.title}</span>
          <p className="mt-1 text-sm text-ink-muted">{dict.login.subtitle}</p>
        </div>
        <form action={setLocale}>
          <input type="hidden" name="locale" value={locale === "ar" ? "en" : "ar"} />
          <button className="rounded-md border border-border px-3 py-1.5 font-mono text-xs text-ink-muted hover:bg-surface-alt hover:text-ink">
            {dict.common.switchLocale}
          </button>
        </form>
      </div>

      {error && (
        <div className="rounded-md bg-critical-soft px-3 py-2 text-sm text-critical">{dict.login.error}</div>
      )}

      <form action={login} className="flex flex-col gap-3">
        <div>
          <label className="mb-1 block text-xs font-medium text-ink-muted">{dict.login.email}</label>
          <input
            name="email"
            type="email"
            required
            dir="ltr"
            className="w-full rounded-md border border-border bg-surface px-3 py-2.5 text-start text-sm"
            placeholder="you@plant.example"
          />
        </div>
        <div>
          <label className="mb-1 block text-xs font-medium text-ink-muted">{dict.login.password}</label>
          <input
            name="password"
            type="password"
            required
            dir="ltr"
            className="w-full rounded-md border border-border bg-surface px-3 py-2.5 text-start text-sm"
          />
        </div>
        <button className="mt-2 rounded-md bg-accent px-4 py-2.5 text-sm font-medium text-white hover:bg-accent-strong">
          {dict.login.signIn}
        </button>
      </form>

      <div className="rounded-lg border border-dashed border-border p-3 text-xs text-ink-muted">
        <p className="mb-1 font-medium text-ink">{dict.login.demoTitle}</p>
        <p dir="ltr" className="text-start">plant.operator@batchline.dev · quality@batchline.dev</p>
        <p dir="ltr" className="text-start">accountant@batchline.dev · admin@batchline.dev</p>
        <p dir="ltr" className="text-start">karim.driver@batchline.dev · hassan.driver@batchline.dev</p>
        <p className="mt-1">
          {dict.login.demoPasswordLabel} <span className="font-mono" dir="ltr">batchline123</span>
        </p>
      </div>
    </div>
  );
}
