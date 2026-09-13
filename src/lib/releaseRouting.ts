// Where releaseBatchTicket sends the browser after a release attempt —
// pulled out into pure functions (no Next.js redirect() call, no
// FormData access beyond the one parse step) so the actual routing
// logic is unit-testable without a request context, and so a
// form-supplied value can never become part of the redirect target
// itself (RMR-R4-P2-01: the previous version concatenated a raw
// `returnPrefix` form field straight into the redirect URL — an
// authenticated caller could submit an arbitrary string there and get
// an open redirect). Only two destinations exist; anything else in the
// form field falls back to "production" silently, the same fail-closed
// posture every other "picker only ever offers valid options, but
// re-check anyway" guard in this app already uses.
export type ReleaseReturnTarget = "production" | "operator";

export function parseReturnTarget(value: FormDataEntryValue | null): ReleaseReturnTarget {
  return value === "operator" ? "operator" : "production";
}

export function releaseSuccessPath(target: ReleaseReturnTarget, ticketId: string): string {
  return target === "operator" ? `/operator/ticket/${ticketId}` : `/production/${ticketId}`;
}

export function releaseFailurePath(target: ReleaseReturnTarget, params: URLSearchParams): string {
  const base = target === "operator" ? "/operator" : "/production";
  return `${base}?${params.toString()}`;
}

// startTrip's own returnTo field (production/actions.ts) — same open-
// redirect shape as returnPrefix above (PL-P2-02, first production-
// lifecycle review): Next's redirect() accepts an absolute external URL,
// so a form field read straight into it is an authenticated open
// redirect. Same closed two-value fix; "trips" (the desktop Trip Board)
// is the default for anything else the form didn't send.
export type TripReturnTarget = "trips" | "operator";

export function parseTripReturnTarget(value: FormDataEntryValue | null): TripReturnTarget {
  return value === "operator" ? "operator" : "trips";
}

export function tripReturnPath(target: TripReturnTarget): string {
  return target === "operator" ? "/operator" : "/trips";
}
