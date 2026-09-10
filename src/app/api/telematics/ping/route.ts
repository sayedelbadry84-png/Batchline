import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { logAudit } from "@/lib/audit";
import { verifyIntegrationRequest } from "@/lib/integration-auth";

// GPS telematics webhook — matches the integration described in the
// Batchline design spec: a GPS/fleet telematics provider pushes a location
// ping per truck. Identify the truck by its configured gpsDeviceId (not an
// internal database id) since that's the identifier the real device knows.
//
// Example: POST /api/telematics/ping
// Authorization: Bearer <INTEGRATION_API_KEY>
// { "deviceId": "GPS-114", "lat": 29.9765, "lng": 30.9188 }
export async function POST(request: NextRequest) {
  const principal = await verifyIntegrationRequest(request, "TELEMATICS");
  if (principal instanceof NextResponse) return principal;

  const body = await request.json().catch(() => null);
  if (!body || typeof body.deviceId !== "string" || !body.deviceId.trim() ||
      typeof body.lat !== "number" || !Number.isFinite(body.lat) || Math.abs(body.lat) > 90 ||
      typeof body.lng !== "number" || !Number.isFinite(body.lng) || Math.abs(body.lng) > 180) {
    return NextResponse.json(
      { error: "Expected { deviceId: string, lat: number, lng: number }" },
      { status: 400 },
    );
  }

  const truck = await prisma.truck.findFirst({ where: { gpsDeviceId: body.deviceId, ...(principal.global ? {} : { plant: { siteId: principal.siteId! } }) } });
  if (!truck) {
    return NextResponse.json({ error: `No truck registered with gpsDeviceId "${body.deviceId}"` }, { status: 404 });
  }

  const updated = await prisma.truck.update({
    where: { id: truck.id },
    data: { lastLat: body.lat, lastLng: body.lng, lastPingAt: new Date() },
  });

  await logAudit({
    module: "Fleet",
    recordId: truck.id,
    field: "location",
    afterValue: `${body.lat}, ${body.lng}`,
    reasonCode: "GPS_PING",
  });

  return NextResponse.json({
    truckCode: updated.code,
    lat: updated.lastLat,
    lng: updated.lastLng,
    pingAt: updated.lastPingAt,
  });
}
