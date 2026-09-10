// PR4-R4 / BL-CR-S2, external-review validation (2026-09-10): which
// header may be believed when identifying the client for rate limiting.
//
// The previous rule — "take the first element of x-forwarded-for, most
// proxies set it" — is exactly backwards as a trust decision. Any client
// can send that header with any value, so a single attacker rotates it
// per request and the per-IP login throttle never fires at all. It
// happened to be safe on Vercel today only because Vercel OVERWRITES
// x-forwarded-for rather than appending to it; the code did not know
// that, and would have been wrong anywhere else.
//
// The policy this implements, per the reviewer's own analysis:
//
//  - on Vercel (VERCEL === "1"), believe x-vercel-forwarded-for first —
//    it stays Vercel's own value even when another proxy sits in front —
//    then Vercel's x-real-ip. Never parse a client-supplied chain.
//  - off Vercel, believe nothing by default. Without knowing which proxy
//    terminates the connection, an unauthenticated header is an attacker
//    input, so it falls into a single shared "unknown" bucket instead.
//
// Failing into one bucket is the deliberate trade: it throttles unknown
// sources collectively rather than pretending to identify them. If a
// non-Vercel deployment ever needs real per-IP limits, name the trusted
// proxy header here — that is a configuration decision someone has to
// make on purpose, not a default.
export const UNKNOWN_CLIENT_IP = "unknown";

// Rejects the empty string, header chains, and anything that is not a
// plausible single IPv4/IPv6 literal — a value that reaches the database
// as a rate-limit key must not be attacker-shaped text.
function asSingleIp(value: string | null | undefined): string | null {
  if (!value) return null;
  const trimmed = value.trim();
  if (!trimmed || trimmed.length > 45 || trimmed.includes(",")) return null;
  const ipv4 = /^(\d{1,3}\.){3}\d{1,3}$/;
  const ipv6 = /^[0-9a-fA-F:]+$/;
  if (ipv4.test(trimmed)) {
    return trimmed.split(".").every((o) => Number(o) <= 255) ? trimmed : null;
  }
  return ipv6.test(trimmed) && trimmed.includes(":") ? trimmed : null;
}

export function resolveClientIp(
  getHeader: (name: string) => string | null,
  env: { VERCEL?: string } = { VERCEL: process.env.VERCEL },
): string {
  if (env.VERCEL === "1") {
    return asSingleIp(getHeader("x-vercel-forwarded-for")) ?? asSingleIp(getHeader("x-real-ip")) ?? UNKNOWN_CLIENT_IP;
  }
  return UNKNOWN_CLIENT_IP;
}
