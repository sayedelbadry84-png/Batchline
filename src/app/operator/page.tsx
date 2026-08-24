import { redirect } from "next/navigation";
import Link from "next/link";
import { prisma } from "@/lib/prisma";
import { getCurrentUser } from "@/lib/session";
import { getDictionary } from "@/lib/i18n";
import { logout } from "@/app/login/actions";
import { setLocale } from "@/app/locale-actions";
import { releaseBatchTicket } from "@/app/(app)/production/actions";

const ACTION_STATUS_CHIP: Record<string, string> = {
  RELEASED: "bg-info-soft text-ink",
  BATCHING: "bg-accent-soft text-accent-strong",
  COMPLETE: "bg-good-soft text-good",
};

export default async function OperatorHomePage() {
  const user = await getCurrentUser();
  if (!user) redirect("/login");
  if (user.role !== "PLANT_OPERATOR" && user.role !== "ADMIN") redirect("/");
  if (!user.plantId || !user.plant) redirect("/");

  // A site can run more than one production line (Plant) sharing the same
  // yard/stock — an operator's account is still linked to one line
  // (User.plantId), but the field view shows every line at that SAME
  // SITE, not just the one the account happens to point at, since one
  // person commonly runs both. Each item below is labeled with its own
  // line so it's clear which physical station to actually go work.
  const siteId = user.plant.siteId;

  const { locale, dict } = await getDictionary();
  const o = dict.operator;
  const m = dict.modules.production;

  const [readyReservationsRaw, actionTickets] = await Promise.all([
    prisma.reservation.findMany({
      where: {
        status: { in: ["CONFIRMED", "IN_PRODUCTION"] },
        siteId,
      },
      include: {
        project: { include: { customer: true } },
        mix: true,
        batchTickets: { where: { status: { not: "CANCELLED" } }, select: { volumeM3: true } },
        // The station (line) is picked right here at release time, from
        // this reservation's own plant's ACTIVE lines — see the
        // Reservation model comment in schema.prisma.
        site: { include: { plants: { where: { status: "ACTIVE" }, orderBy: { name: "asc" }, select: { id: true, name: true } } } },
      },
      orderBy: { pourWindowStart: "asc" },
    }),
    prisma.batchTicket.findMany({
      where: {
        plant: { siteId },
        OR: [{ status: { in: ["RELEASED", "BATCHING"] } }, { status: "COMPLETE", trip: null }],
      },
      include: { mix: true, plant: true, reservation: { include: { project: true } } },
      orderBy: { releasedAt: "asc" },
    }),
  ]);

  const readyReservations = readyReservationsRaw
    .map((r) => {
      const released = r.batchTickets.reduce((sum, t) => sum + t.volumeM3, 0);
      return { ...r, remaining: Math.max(0, r.requestedVolumeM3 - released) };
    })
    .filter((r) => r.remaining > 0.001);

  return (
    <div className="mx-auto flex min-h-screen max-w-sm flex-col gap-5 bg-bg px-5 py-6">
      <div className="flex items-center justify-between">
        <div>
          <div className="font-mono text-xs tracking-widest text-accent-strong uppercase">{o.brand}</div>
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
            <button className="rounded-md border border-border px-2.5 py-1.5 text-xs text-ink-muted">{o.signOut}</button>
          </form>
        </div>
      </div>

      <div className="flex flex-col gap-3">
        <div className="font-mono text-xs text-ink-muted uppercase">{o.actionTitle}</div>
        {actionTickets.map((t) => (
          <Link
            key={t.id}
            href={`/operator/ticket/${t.id}`}
            className="flex flex-col gap-1 rounded-xl border border-border bg-surface p-4 shadow-sm"
          >
            <div className="flex items-center justify-between">
              <span className="font-medium">{t.reservation.project.name}</span>
              <span className={`rounded-full px-2 py-0.5 font-mono text-xs ${ACTION_STATUS_CHIP[t.status] ?? ""}`}>
                {dict.status[t.status as keyof typeof dict.status] ?? t.status}
              </span>
            </div>
            <div className="text-xs text-ink-muted" dir="ltr">
              {t.ticketNumber} · {t.mix.code} · {t.volumeM3} m³ · {t.plant.name}
            </div>
          </Link>
        ))}
        {actionTickets.length === 0 && (
          <div className="rounded-xl border border-dashed border-border p-4 text-center text-sm text-ink-muted">
            {o.emptyAction}
          </div>
        )}
      </div>

      <div className="flex flex-col gap-3">
        <div className="font-mono text-xs text-ink-muted uppercase">{m.readyTitle}</div>
        {readyReservations.map((r) => (
          <form
            key={r.id}
            action={releaseBatchTicket}
            className="flex flex-col gap-2 rounded-xl border border-border bg-surface p-4 shadow-sm"
          >
            <input type="hidden" name="reservationId" value={r.id} />
            <input type="hidden" name="returnPrefix" value="/operator/ticket" />
            <div>
              <span className="font-medium">{r.project.name}</span>
              <div className="text-xs text-ink-muted">{r.project.customer.legalName} · {r.site.name}</div>
            </div>
            <select name="plantId" required defaultValue="" className="w-full rounded-md border border-border bg-bg px-2 py-1.5 text-sm">
              <option value="" disabled>{dict.field.selectPlant}</option>
              {r.site.plants.map((p) => (
                <option key={p.id} value={p.id}>{p.name}</option>
              ))}
            </select>
            <div className="flex items-center justify-between gap-2" dir="ltr">
              <span className="font-mono text-xs text-ink-muted">{r.mix.code}</span>
              <input
                name="volumeM3"
                type="number"
                step="0.5"
                max={r.remaining}
                defaultValue={r.remaining}
                className="w-24 rounded-md border border-border bg-bg px-2 py-1.5 text-end font-mono text-sm"
              />
            </div>
            <button type="submit" className="rounded-md bg-accent px-4 py-2 text-sm font-medium text-white">
              {m.release}
            </button>
          </form>
        ))}
        {readyReservations.length === 0 && (
          <div className="rounded-xl border border-dashed border-border p-4 text-center text-sm text-ink-muted">
            {m.emptyReady}
          </div>
        )}
      </div>
    </div>
  );
}
