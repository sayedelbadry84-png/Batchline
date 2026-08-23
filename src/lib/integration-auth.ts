import "server-only";
import { timingSafeEqual } from "crypto";
import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { hashApiKey } from "@/lib/apiKeys";

export type IntegrationScope = "TELEMATICS" | "SCADA" | "REPORTS";

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

// Auth for machine-to-machine webhooks (SCADA silo readings, GPS
// telematics pings) — these never go through the session cookie, since the
// caller is a gateway device, not a logged-in user. Two accepted forms:
// a database-managed ApiKey (see the /integrations screen — revocable,
// scoped, hashed at rest) or, for backward compatibility, the single
// INTEGRATION_API_KEY env var as an ALL-scope key. No hash comparison
// needs to be constant-time (an exact-match DB lookup on a SHA-256 hash
// already gives an attacker nothing to time against), but the legacy env
// var is still compared with safeEqual since that's a direct string
// compare, not a hash lookup.
export async function verifyIntegrationRequest(request: NextRequest, requiredScope: IntegrationScope): Promise<NextResponse | null> {
  const auth = request.headers.get("authorization") ?? "";
  const presentedKey = auth.startsWith("Bearer ") ? auth.slice(7) : "";
  if (!presentedKey) {
    return NextResponse.json({ error: "Missing or invalid Authorization bearer token." }, { status: 401 });
  }

  const legacyKey = process.env.INTEGRATION_API_KEY;
  if (legacyKey && safeEqual(presentedKey, legacyKey)) return null;

  const key = await prisma.apiKey.findUnique({ where: { keyHash: hashApiKey(presentedKey) } });
  if (!key || key.revokedAt) {
    return NextResponse.json({ error: "Missing or invalid Authorization bearer token." }, { status: 401 });
  }
  if (key.scope !== "ALL" && key.scope !== requiredScope) {
    return NextResponse.json({ error: `This key is not scoped for ${requiredScope}.` }, { status: 403 });
  }

  await prisma.apiKey.update({ where: { id: key.id }, data: { lastUsedAt: new Date() } });
  return null;
}
