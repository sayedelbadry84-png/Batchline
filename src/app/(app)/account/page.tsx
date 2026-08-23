import { redirect } from "next/navigation";
import { prisma } from "@/lib/prisma";
import { ui } from "@/lib/ui";
import { getCurrentUser } from "@/lib/session";
import { getDictionary } from "@/lib/i18n";
import { totpUri } from "@/lib/totp";
import { startTotpSetup, cancelTotpSetup, confirmTotpSetup, disableTotp } from "./actions";

export default async function AccountPage() {
  const sessionUser = await getCurrentUser();
  if (!sessionUser) redirect("/login");

  const user = await prisma.user.findUniqueOrThrow({ where: { id: sessionUser.id } });
  const { dict } = await getDictionary();
  const m = dict.modules.account;

  return (
    <div className="flex flex-col gap-8">
      <header>
        <div className={ui.eyebrow}>{m.eyebrow}</div>
        <h1 className={ui.h1}>{m.title}</h1>
        <p className={ui.intro}>{m.intro}</p>
      </header>

      <div className={`${ui.card} flex flex-col gap-1`}>
        <div className="text-sm font-medium">{user.name}</div>
        <div className="font-mono text-xs text-ink-muted" dir="ltr">{user.email}</div>
      </div>

      <div className="flex flex-col gap-4">
        <h2 className="font-display text-lg font-semibold">{m.twoFactorTitle}</h2>

        {user.totpEnabled ? (
          <div className="flex flex-col gap-3">
            <div className={`${ui.card} flex items-center gap-2`}>
              <span className={`${ui.chip} bg-good-soft text-good`}>{m.enabled}</span>
              <span className="text-sm text-ink-muted">{m.enabledIntro}</span>
            </div>
            <form action={disableTotp} className={`${ui.card} flex flex-wrap items-end gap-3`}>
              <div>
                <label className={ui.label}>{m.currentPassword}</label>
                <input name="password" type="password" required dir="ltr" className={`${ui.input} w-56`} />
              </div>
              <button className="rounded-md border border-critical/40 px-3 py-2 text-sm text-critical hover:bg-critical-soft">
                {m.disable}
              </button>
            </form>
          </div>
        ) : user.totpTempSecret ? (
          <div className={`${ui.card} flex flex-col gap-3`}>
            <p className="text-sm text-ink-muted">{m.setupIntro}</p>
            <div>
              <div className={ui.label}>{m.manualEntryKey}</div>
              <div className="rounded-md border border-border bg-surface-alt px-3 py-2 font-mono text-sm tracking-wider" dir="ltr">
                {user.totpTempSecret}
              </div>
            </div>
            <div>
              <div className={ui.label}>{m.setupUri}</div>
              <div className="break-all rounded-md border border-border bg-surface-alt px-3 py-2 font-mono text-xs" dir="ltr">
                {totpUri(user.totpTempSecret, user.email)}
              </div>
            </div>
            <div className="flex flex-wrap items-end gap-3">
              <form action={confirmTotpSetup} className="flex flex-wrap items-end gap-3">
                <div>
                  <label className={ui.label}>{m.codeLabel}</label>
                  <input
                    name="code"
                    type="text"
                    inputMode="numeric"
                    pattern="[0-9]{6}"
                    maxLength={6}
                    required
                    dir="ltr"
                    className={`${ui.input} w-32 text-center font-mono tracking-widest`}
                    placeholder="000000"
                  />
                </div>
                <button className={ui.button}>{m.confirm}</button>
              </form>
              <form action={cancelTotpSetup}>
                <button className="rounded-md border border-border px-3 py-2 text-sm hover:bg-surface-alt">{dict.field.cancel}</button>
              </form>
            </div>
          </div>
        ) : (
          <div className={`${ui.card} flex flex-col gap-3`}>
            <p className="text-sm text-ink-muted">{m.disabledIntro}</p>
            <form action={startTotpSetup}>
              <button className={ui.button}>{m.enable}</button>
            </form>
          </div>
        )}
      </div>
    </div>
  );
}
