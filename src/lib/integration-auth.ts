import "server-only";
import { timingSafeEqual } from "crypto";
import { NextRequest, NextResponse } from "next/server";

// Constant-time string compare — a plain === leaks how many leading bytes
// matched through response timing, letting an attacker recover the key one
// byte at a time. timingSafeEqual needs equal-length buffers, so a length
// mismatch is itself compared against a dummy buffer of the right length
// rather than short-circuiting (which would leak the length check timing).
function safeEqual(a: string, b: string): boolean {
  const bufA = Buffer.from(a);
  const bufB = Buffer.from(b);
  if (bufA.length !== bufB.length) {
    timingSafeEqual(bufA, bufA);
    return false;
  }
  return timingSafeEqual(bufA, bufB);
}

// Shared secret for machine-to-machine webhooks (SCADA silo readings, GPS
// telematics pings) — these never go through the session cookie, since the
// caller is a gateway device, not a logged-in user. Fails closed: with no
// key configured, every request is rejected rather than silently accepted.
export function verifyIntegrationRequest(request: NextRequest): NextResponse | null {
  const configuredKey = process.env.INTEGRATION_API_KEY;
  if (!configuredKey) {
    return NextResponse.json({ error: "Integration endpoint not configured (INTEGRATION_API_KEY unset)." }, { status: 503 });
  }

  const auth = request.headers.get("authorization") ?? "";
  const presentedKey = auth.startsWith("Bearer ") ? auth.slice(7) : "";
  if (!presentedKey || !safeEqual(presentedKey, configuredKey)) {
    return NextResponse.json({ error: "Missing or invalid Authorization bearer token." }, { status: 401 });
  }

  return null;
}
