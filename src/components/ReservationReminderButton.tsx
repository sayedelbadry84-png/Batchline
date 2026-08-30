"use client";

// Unlike WhatsAppShareButton, the number is already known (Reservation.
// siteContactPhone) so there's nothing to prompt for — one click opens the
// prefilled wa.me chat AND submits the form below it, which stamps
// reminderSentAt via markReservationReminderSent so the reservation drops
// out of the "due for reminder" list. The two are independent (the form
// still submits even if the popup was blocked), same tradeoff
// WhatsAppShareButton already accepts: nothing here proves the message was
// actually sent, only that someone clicked.
export function ReservationReminderButton({
  reservationId,
  phone,
  message,
  label,
  markAction,
}: {
  reservationId: string;
  phone: string;
  message: string;
  label: string;
  markAction: (formData: FormData) => void;
}) {
  function handleClick() {
    const digits = phone.replace(/[^\d]/g, "");
    if (!digits) return;
    window.open(`https://wa.me/${digits}?text=${encodeURIComponent(message)}`, "_blank", "noopener,noreferrer");
  }

  return (
    <form action={markAction}>
      <input type="hidden" name="id" value={reservationId} />
      <button
        type="submit"
        onClick={handleClick}
        className="rounded-md border border-good bg-good-soft px-3 py-1.5 text-xs font-medium text-good hover:opacity-80"
      >
        {label}
      </button>
    </form>
  );
}
