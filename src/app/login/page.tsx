import { login } from "./actions";

export default async function LoginPage({
  searchParams,
}: {
  searchParams: Promise<{ error?: string }>;
}) {
  const { error } = await searchParams;

  return (
    <div className="mx-auto flex min-h-screen max-w-sm flex-col justify-center gap-6 bg-bg px-6 py-10">
      <div>
        <span className="font-display text-2xl font-semibold tracking-tight">Batchline</span>
        <p className="mt-1 text-sm text-ink-muted">Plant operations platform</p>
      </div>

      {error && (
        <div className="rounded-md bg-critical-soft px-3 py-2 text-sm text-critical">
          Incorrect email or password.
        </div>
      )}

      <form action={login} className="flex flex-col gap-3">
        <div>
          <label className="mb-1 block text-xs font-medium text-ink-muted">Email</label>
          <input
            name="email"
            type="email"
            required
            className="w-full rounded-md border border-border bg-surface px-3 py-2.5 text-sm"
            placeholder="you@plant.example"
          />
        </div>
        <div>
          <label className="mb-1 block text-xs font-medium text-ink-muted">Password</label>
          <input
            name="password"
            type="password"
            required
            className="w-full rounded-md border border-border bg-surface px-3 py-2.5 text-sm"
          />
        </div>
        <button className="mt-2 rounded-md bg-accent px-4 py-2.5 text-sm font-medium text-white hover:bg-accent-strong">
          Sign in
        </button>
      </form>

      <div className="rounded-lg border border-dashed border-border p-3 text-xs text-ink-muted">
        <p className="mb-1 font-medium text-ink">Seeded demo accounts (dev only)</p>
        <p>plant.operator@batchline.dev · quality@batchline.dev</p>
        <p>accountant@batchline.dev · admin@batchline.dev</p>
        <p>karim.driver@batchline.dev · hassan.driver@batchline.dev</p>
        <p className="mt-1">Password for all: <span className="font-mono">batchline123</span></p>
      </div>
    </div>
  );
}
