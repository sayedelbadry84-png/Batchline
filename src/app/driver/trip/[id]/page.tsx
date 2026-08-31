import { notFound, redirect } from "next/navigation";
import Link from "next/link";
import { prisma } from "@/lib/prisma";
import { getCurrentUser } from "@/lib/session";
import { getDictionary } from "@/lib/i18n";
import { DrumTimer } from "@/components/DrumTimer";
import {
  driverAdvanceTrip,
  uploadDeliveryPhoto,
  confirmDeliveryFull,
  confirmDeliveryWithReturn,
} from "../../actions";

export default async function DriverTripPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  const user = await getCurrentUser();
  if (!user) redirect("/login");
  if (user.role !== "DRIVER" || !user.employeeId) redirect("/driver");

  const { locale, dict } = await getDictionary();
  const d = dict.driver;
  const backArrow = locale === "ar" ? "→" : "←";

  const trip = await prisma.trip.findUnique({
    where: { id },
    include: {
      truck: true,
      driver: true,
      batchTicket: {
        include: { plant: true, mix: true, reservation: { include: { project: { include: { customer: true } } } } },
      },
      drumReturn: true,
    },
  });
  if (!trip) notFound();
  if (trip.driverId !== user.employeeId) redirect("/driver");

  const project = trip.batchTicket.reservation.project;
  const statusLabel =
    trip.status in d.status ? d.status[trip.status as keyof typeof d.status] : trip.status;

  return (
    <div className="mx-auto flex min-h-screen max-w-sm flex-col gap-5 bg-bg px-5 py-6">
      <Link href="/driver" className="text-xs text-ink-muted">
        {backArrow} {d.backToTrips}
      </Link>

      <div>
        <div className="font-mono text-xs tracking-widest text-accent-strong uppercase" dir="ltr">
          {trip.batchTicket.ticketNumber}
        </div>
        <h1 className="font-display text-xl font-semibold">{project.name}</h1>
        <div className="text-xs text-ink-muted" dir="ltr">
          {trip.batchTicket.reservation.reservationNumber}
        </div>
        <div className="text-xs text-ink-muted">
          {project.customer.legalName} · {trip.batchTicket.mix.code} ({trip.batchTicket.mix.grade}) · {trip.batchTicket.volumeM3} m³
        </div>
      </div>

      <div className="rounded-xl border border-border bg-surface p-4 shadow-sm">
        <div className="flex items-center justify-between">
          <span className="text-sm font-medium">{statusLabel}</span>
          {trip.status !== "CLOSED" && (
            <DrumTimer batchTimeIso={trip.batchTime.toISOString()} limitMinutes={trip.batchTicket.plant.drumTimerLimitMinutes} />
          )}
        </div>
        <div className="mt-2 text-xs text-ink-muted" dir="ltr">
          {trip.truck.code} · {trip.batchTicket.reservation.siteLocation || project.siteAddress}
        </div>
      </div>

      {trip.batchTicket.reservation.siteLocationUrl && (
        <a
          href={trip.batchTicket.reservation.siteLocationUrl}
          target="_blank"
          rel="noopener noreferrer"
          className="flex items-center justify-center gap-2 rounded-md bg-accent-soft px-4 py-3 text-sm font-medium text-accent-strong"
        >
          {d.openLocation}
        </a>
      )}

      {["LOADING", "IN_TRANSIT", "ON_SITE"].includes(trip.status) && (
        <form action={driverAdvanceTrip}>
          <input type="hidden" name="tripId" value={trip.id} />
          <button className="w-full rounded-md bg-accent px-4 py-3 text-base font-medium text-white">
            {d.nextAction[trip.status as keyof typeof d.nextAction]}
          </button>
        </form>
      )}

      {trip.status === "DISCHARGING" && (
        <>
          <form action={uploadDeliveryPhoto} className="flex flex-col gap-2 rounded-xl border border-border bg-surface p-4">
            <div className="text-sm font-medium">{d.deliveryPhoto}</div>
            <input type="hidden" name="tripId" value={trip.id} />
            {trip.deliveryPhotoUrl ? (
              // eslint-disable-next-line @next/next/no-img-element
              <img src={trip.deliveryPhotoUrl} alt={d.deliveryPhoto} className="rounded-lg border border-border" />
            ) : (
              <div className="flex h-32 items-center justify-center rounded-lg border border-dashed border-border text-ink-faint">
                {d.noPhotoYet}
              </div>
            )}
            <input
              type="file"
              name="photo"
              accept="image/*"
              capture="environment"
              className="text-xs"
            />
            <button className="rounded-md border border-border py-2 text-sm">{d.uploadPhoto}</button>
          </form>

          <form action={confirmDeliveryFull} className="flex flex-col gap-2 rounded-xl border border-border bg-surface p-4">
            <div className="text-sm font-medium">{d.confirmFullTitle}</div>
            <input type="hidden" name="tripId" value={trip.id} />
            <input
              name="signedBy"
              required
              placeholder={d.siteContactName}
              className="rounded-md border border-border bg-surface px-3 py-2 text-sm"
            />
            <button className="rounded-md bg-accent px-4 py-2.5 text-sm font-medium text-white">
              {d.confirmFullButton}
            </button>
          </form>

          <form action={confirmDeliveryWithReturn} className="flex flex-col gap-2 rounded-xl border border-border bg-surface p-4">
            <div className="text-sm font-medium">{d.confirmReturnTitle}</div>
            <input type="hidden" name="tripId" value={trip.id} />
            <input
              name="signedBy"
              required
              placeholder={d.siteContactName}
              className="rounded-md border border-border bg-surface px-3 py-2 text-sm"
            />
            <input
              name="returnedVolumeM3"
              type="number"
              step="0.1"
              required
              placeholder={d.returnedVolume}
              className="rounded-md border border-border bg-surface px-3 py-2 text-sm"
            />
            <button className="rounded-md bg-warn-soft px-4 py-2.5 text-sm font-medium text-warn">
              {d.confirmReturnButton}
            </button>
          </form>
        </>
      )}

      {trip.status === "CLOSED" && (
        <div className="rounded-xl border border-border bg-surface p-4 text-sm">
          <div className="font-medium">{d.delivered(trip.volumeDeliveredM3?.toFixed(1) ?? "0.0")}</div>
          {trip.drumReturn && (
            <div className="mt-1 text-xs text-ink-muted">
              {d.returnedNote(trip.drumReturn.returnedVolumeM3, trip.drumReturn.disposition)}
            </div>
          )}
          {trip.deliverySignedBy && (
            <div className="mt-1 text-xs text-ink-muted">
              {d.signedBy(
                trip.deliverySignedBy,
                trip.deliverySignedAt ? new Date(trip.deliverySignedAt).toLocaleTimeString() : "",
              )}
            </div>
          )}
        </div>
      )}
    </div>
  );
}
