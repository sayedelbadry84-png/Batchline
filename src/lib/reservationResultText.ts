// Banner text for the `reservationResult` query parameter the reservation
// actions redirect with (reservations/actions.ts). Those actions used to
// return void on every refusal, so a refused edit reloaded the page as if
// it had worked. An unknown code (a hand-edited URL) renders nothing
// rather than a misleading message.
export type ReservationResultMessages = {
  CANCELLED: string;
  NOT_FOUND: string;
  INVALID_INPUT: string;
  INVALID_STATE: string;
  TERMINAL: string;
  STATUS_NOT_ALLOWED: string;
  NO_PRICE_ON_FILE: string;
  BELOW_RELEASED: string;
  FROZEN_AFTER_RELEASE: string;
  CREDIT_HOLD: string;
  HAS_RELEASED_VOLUME: string;
};

const CODES: readonly (keyof ReservationResultMessages)[] = [
  "CANCELLED",
  "NOT_FOUND",
  "INVALID_INPUT",
  "INVALID_STATE",
  "TERMINAL",
  "STATUS_NOT_ALLOWED",
  "NO_PRICE_ON_FILE",
  "BELOW_RELEASED",
  "FROZEN_AFTER_RELEASE",
  "CREDIT_HOLD",
  "HAS_RELEASED_VOLUME",
];

export function describeReservationResult(messages: ReservationResultMessages, code: string | undefined): { text: string; ok: boolean } | null {
  const known = CODES.find((c) => c === code);
  if (!known) return null;
  return { text: messages[known], ok: known === "CANCELLED" };
}
