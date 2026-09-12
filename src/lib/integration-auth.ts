import "server-only";
import { timingSafeEqual } from "crypto";
import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { hashApiKey } from "@/lib/apiKeys";

export type IntegrationPrincipal = Readonly<{ keyId: string; scope: string; siteId: string | null; global: boolean }>;

export type IntegrationScope = "TELEMATICS" | "SCADA" | "REPORTS";

// Constant-time string compare — a plain === leaks how many leading bytes
// matched through response timing, letting an attacker recover the key one
// byte at a time. timingSafeEqual needs equal-length buffers, so a length
// mismatch is itself compared against a dummy buffer of the right length
// rather than short-circuiting (which would leak the length check timing).
export function safeEqual(a: string, b: string): boolean {
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
// How stale lastUsedAt may get before it is refreshed. Fifteen minutes
// is far finer than any question anyone asks of this field, and coarse
// enough that a device polling every few seconds writes once per window
// instead of thousands of times.
const LAST_USED_REFRESH_MS = 15 * 60 * 1000;

export async function verifyIntegrationRequest(request: NextRequest, requiredScope: IntegrationScope): Promise<NextResponse | IntegrationPrincipal> {
  const auth = request.headers.get("authorization") ?? "";
  const presentedKey = auth.startsWith("Bearer ") ? auth.slice(7) : "";
  if (!presentedKey) {
    return NextResponse.json({ error: "Missing or invalid Authorization bearer token." }, { status: 401 });
  }

  const legacyKey = process.env.INTEGRATION_API_KEY;
  if (process.env.ALLOW_LEGACY_GLOBAL_INTEGRATION_KEY === "true" && legacyKey && safeEqual(presentedKey, legacyKey)) {
    console.warn("Legacy global integration key used", { scope: requiredScope });
    return { keyId: "legacy-environment", scope: "ALL", siteId: null, global: true };
  }

  const key = await prisma.apiKey.findUnique({ where: { keyHash: hashApiKey(presentedKey) } });
  if (!key || key.revokedAt) {
    return NextResponse.json({ error: "Missing or invalid Authorization bearer token." }, { status: 401 });
  }
  if (!key.global && !key.siteId) return NextResponse.json({ error: "Key has no assigned site." }, { status: 403 });
  if (key.scope !== "ALL" && key.scope !== requiredScope) {
    return NextResponse.json({ error: `This key is not scoped for ${requiredScope}.` }, { status: 403 });
  }

  // Performance audit (2026-09-12): this used to write lastUsedAt on
  // EVERY accepted request. SCADA and telematics are polling endpoints —
  // one row update per silo reading and per truck ping, forever — which
  // turns a liveness hint into the hottest write in the system, and one
  // that serialises every concurrent request from the same device behind
  // a single row lock.
  //
  // The field answers "is this key still in use", a question no one asks
  // to the second. Updating it at most once per staleness window keeps
  // that answer while removing the per-request write, and the conditional
  // WHERE means two concurrent requests cannot both perform it: the
  // second matches no row.
  const staleBefore = new Date(Date.now() - LAST_USED_REFRESH_MS);
  if (!key.lastUsedAt || key.lastUsedAt < staleBefore) {
    await prisma.apiKey.updateMany({
      where: { id: key.id, OR: [{ lastUsedAt: null }, { lastUsedAt: { lt: staleBefore } }] },
      data: { lastUsedAt: new Date() },
    });
  }
  return { keyId: key.id, scope: key.scope, siteId: key.siteId, global: key.global };
}
