import { redirect } from "next/navigation";
import { prisma } from "@/lib/prisma";
import { getCurrentUser } from "@/lib/session";
import { getDictionary } from "@/lib/i18n";
import { NotificationPermissionButton } from "@/components/NotificationPermissionButton";
import { logout } from "@/app/login/actions";
import { setLocale } from "@/app/locale-actions";

// Read-only, deliberately — a pump crew member doesn't own a Trip's stage
// transitions the way a driver does (see /driver): the driver is who
// actually advances LOADING → IN_TRANSIT → ON_SITE → DISCHARGING →
// delivery confirmation. This page exists so a pump operator/assistant's
// account has something real and useful to land on — today's assigned
// jobs, with the same "know how to get there" location link the driver
// app surfaces — not to duplicate the driver's execution flow.
export default async function PumpCrewHomePage() {
  const user = await getCurrentUser();
  if (!user) redirect("/login");
  if (user.role !== "PUMP_OPERATOR") redirect("/");

  const { locale, dict } = await getDictionary();
  const d = dict.pumpCrew;

  if (!user.pumpCrewMemberId) {
    return (
      <div className="mx-auto flex min-h-screen max-w-sm flex-col justify-center gap-4 bg-bg px-6 py-10 text-center">
        <p className="text-sm text-ink-muted">{d.notLinked}</p>
        <form action={logout}>
          <button className="rounded-md border border-border px-4 py-2 text-sm">{d.signOut}</button>
        </form>
      </div>
    );
  }

  const memberId = user.pumpCrewMemberId;
  const [openTrips, closedTrips] = await Promise.all([
    prisma.trip.findMany({
      where: { OR: [{ pumpOperatorId: memberId }, { pumpAssistantId: memberId }], status: { not: "CLOSED" } },
      include: { batchTicket: { include: { mix: true, reservation: { include: { project: true } } } } },
      orderBy: { batchTime: "asc" },
    }),
    prisma.trip.findMany({
      where: { OR: [{ pumpOperatorId: memberId }, { pumpAssistantId: memberId }], status: "CLOSED" },
      include: { batchTicket: { include: { mix: true, reservation: { include: { project: true } } } } },
      orderBy: { updatedAt: "desc" },
      take: 5,
    }),
  ]);

  return (
    <div className="mx-auto flex min-h-screen max-w-sm flex-col gap-5 bg-bg px-5 py-6">
      <div className="flex items-center justify-between">
        <div>
          <div className="font-mono text-xs tracking-widest text-accent-strong uppercase">{d.brand}</div>
          <h1 className="font-display text-xl font-semibold">{user.name}</h1>
        </div>
        <div className="flex gap-1.5">
          <form action={setLocale}>
            <input type="hidden" name="locale" value={locale === "ar" ? "en" : "ar"} />
            <button className="rounded-md border border-border px-2.5 py-1.5 font-mono text-xs text-ink-muted">
              {dict.common.switchLocale}
            </button>
          </form>
          <form action={logout}>
            <button className="rounded-md border border-border px-2.5 py-1.5 text-xs text-ink-muted">{d.signOut}</button>
          </form>
        </div>
      </div>

      <div className="flex justify-end">
        <NotificationPermissionButton
          enableLabel={dict.driver.enableNotifications}
          enabledLabel={dict.driver.notificationsEnabled}
          deniedLabel={dict.driver.notificationsDenied}
        />
      </div>

      <div className="flex flex-col gap-3">
        <div className="font-mono text-xs text-ink-muted uppercase">{d.todaysJobs}</div>
        {openTrips.map((t) => {
          const duty = t.pumpOperatorId === memberId ? "OPERATOR" : "HELPER";
          const url = t.batchTicket.reservation.siteLocationUrl;
          return (
            <div key={t.id} className="flex flex-col gap-1 rounded-xl border border-border bg-surface p-4 shadow-sm">
              <div className="flex items-center justify-between">
                <span className="font-medium">{t.batchTicket.reservation.project.name}</span>
                <span className="font-mono text-xs text-ink-muted">{d.roleLabel[duty]}</span>
              </div>
              <div className="text-xs text-ink-muted" dir="ltr">
                {t.batchTicket.ticketNumber} · {t.batchTicket.reservation.reservationNumber} · {t.batchTicket.mix.code} ({t.batchTicket.mix.grade}) · {t.batchTicket.volumeM3} m³
              </div>
              {t.batchTicket.reservation.siteLocation && (
                <div className="text-xs text-ink-muted">{t.batchTicket.reservation.siteLocation}</div>
              )}
              <div className="mt-1 flex items-center justify-between">
                <span className="text-xs font-medium">{dict.driver.status[t.status as keyof typeof dict.driver.status] ?? t.status}</span>
                {url && (
                  <a href={url} target="_blank" rel="noopener noreferrer" className="text-xs font-medium text-accent-strong hover:underline">
                    {d.openLocation}
                  </a>
                )}
              </div>
            </div>
          );
        })}
        {openTrips.length === 0 && (
          <div className="rounded-xl border border-dashed border-border p-4 text-center text-sm text-ink-muted">
            {d.noJobsAssigned}
          </div>
        )}
      </div>

      {closedTrips.length > 0 && (
        <div className="flex flex-col gap-2">
          <div className="font-mono text-xs text-ink-muted uppercase">{d.recentlyCompleted}</div>
          {closedTrips.map((t) => (
            <div key={t.id} className="rounded-lg border border-border bg-surface px-3 py-2 text-sm">
              {t.batchTicket.reservation.project.name}
              <span className="ms-2 font-mono text-xs text-ink-muted">{t.volumeDeliveredM3?.toFixed(1)} m³</span>
              <div className="font-mono text-xs text-ink-muted" dir="ltr">
                {t.batchTicket.ticketNumber} · {t.batchTicket.reservation.reservationNumber} · {t.batchTicket.mix.code}
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
