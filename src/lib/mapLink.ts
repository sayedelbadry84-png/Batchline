import "server-only";

// Parses a latitude/longitude pair out of a pasted Google Maps link (or a
// bare "lat,lng" string), so a plant admin can paste one link instead of
// looking up two separate decimal numbers for the yard geofence. Purely a
// convenience input path — the geofence itself is still just
// Plant.yardLat/yardLng/yardRadiusM (see schema.prisma); this never adds
// its own column, it only fills those two in.

const COORD_PATTERNS = [
  // Place-card precise marker: .../@30.05,31.23,17z/data=!...!3d30.0512!4d31.2334...
  /!3d(-?\d{1,3}\.\d+)!4d(-?\d{1,3}\.\d+)/,
  // q=lat,lng or query=lat,lng
  /[?&](?:q|query)=(-?\d{1,3}\.\d+),\s*(-?\d{1,3}\.\d+)/,
  // ll=lat,lng
  /[?&]ll=(-?\d{1,3}\.\d+),\s*(-?\d{1,3}\.\d+)/,
  // Map viewport center pin: /@30.05,31.23,17z
  /@(-?\d{1,3}\.\d+),(-?\d{1,3}\.\d+)/,
  // Bare "lat, lng" text with nothing else on it
  /^(-?\d{1,3}\.\d+),\s*(-?\d{1,3}\.\d+)$/,
];

function isValidLatLng(lat: number, lng: number): boolean {
  return Number.isFinite(lat) && Number.isFinite(lng) && Math.abs(lat) <= 90 && Math.abs(lng) <= 180;
}

export function parseLatLngFromText(input: string): { lat: number; lng: number } | null {
  const text = input.trim();
  if (!text) return null;
  for (const pattern of COORD_PATTERNS) {
    const match = text.match(pattern);
    if (!match) continue;
    const lat = Number(match[1]);
    const lng = Number(match[2]);
    if (isValidLatLng(lat, lng)) return { lat, lng };
  }
  return null;
}

const SHORT_LINK_HOSTS = new Set(["maps.app.goo.gl", "goo.gl", "g.co"]);

function isGoogleMapsShortLink(input: string): boolean {
  try {
    return SHORT_LINK_HOSTS.has(new URL(input).hostname);
  } catch {
    return false;
  }
}

// A short link carries no coordinates in the URL itself — they only appear
// after it redirects to the real maps.google.com URL. Only ever follows a
// Google-owned short-link host (never an arbitrary caller-supplied URL),
// so this can't be turned into an open server-side-request-forgery proxy.
async function resolveGoogleMapsShortLink(input: string): Promise<string | null> {
  if (!isGoogleMapsShortLink(input)) return null;
  try {
    const res = await fetch(input, { redirect: "follow", signal: AbortSignal.timeout(5000) });
    return res.url || null;
  } catch {
    return null;
  }
}

// Entry point for the plant edit form's "location link" field — tries a
// direct parse first, and only reaches out to Google's servers to resolve
// a short link if the direct parse comes up empty.
export async function extractYardLatLng(input: string): Promise<{ lat: number; lng: number } | null> {
  const direct = parseLatLngFromText(input);
  if (direct) return direct;
  const resolved = await resolveGoogleMapsShortLink(input);
  return resolved ? parseLatLngFromText(resolved) : null;
}
