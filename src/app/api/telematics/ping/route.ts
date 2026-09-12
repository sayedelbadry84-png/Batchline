import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { writeAudit } from "@/lib/audit";
import { verifyIntegrationRequest } from "@/lib/integration-auth";
import { allowTelemetryBurst, resolveObservedAt, TELEMETRY_BURST_LIMIT, TELEMETRY_BURST_WINDOW_MS } from "@/lib/telemetry";

// GPS telematics webhook — matches the integration described in the
// Batchline design spec: a GPS/fleet telematics provider pushes a location
// ping per truck. Identify the truck by its configured gpsDeviceId (not an
// internal database id) since that's the identifier the real device knows.
//
// Example: POST /api/telematics/ping
// Authorization: Bearer <INTEGRATION_API_KEY>
// { "deviceId": "GPS-114", "lat": 29.9765, "lng": 30.9188, "observedAt": "2026-09-12T08:15:00Z" }
//
// `observedAt` is optional and backward compatible — a device that does
// not send it gets the previous behaviour (receipt time). See
// src/lib/telemetry.ts.
export async function POST(request: NextRequest) {
  const principal = await verifyIntegrationRequest(request, "TELEMATICS");
  if (principal instanceof NextResponse) return principal;

  const body = await request.json().catch(() => null);
  if (body && typeof body.deviceId === "string" && !allowTelemetryBurst(`gps:${principal.keyId}:${body.deviceId}`, Date.now(), TELEMETRY_BURST_LIMIT, TELEMETRY_BURST_WINDOW_MS)) {
    return NextResponse.json({ error: "Too many pings for this device — slow down." }, { status: 429 });
  }
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

  const observed = resolveObservedAt(body.observedAt, new Date());
  if (observed.status === "INVALID") {
    return NextResponse.json({ error: observed.reason }, { status: 400 });
  }

  // Same ordering rule as the SCADA route: a ping delayed in transit must
  // not move a truck backwards on the dispatcher's map. `applied: false`
  // is a 200 — a device resending a ping it already delivered has done
  // nothing wrong.
  const applied = await prisma.$transaction(async (tx) => {
    const claim = await tx.truck.updateMany({
      where: {
        id: truck.id,
        OR: [{ lastPingAt: null }, { lastPingAt: { lt: observed.observedAt } }],
      },
      data: { lastLat: body.lat, lastLng: body.lng, lastPingAt: observed.observedAt },
    });
    if (claim.count !== 1) return false;

    await writeAudit(tx, null, {
      module: "Fleet",
      recordId: truck.id,
      field: "location",
      afterValue: `${body.lat}, ${body.lng}`,
      reasonCode: "GPS_PING",
    });
    return true;
  });

  const current = await prisma.truck.findUniqueOrThrow({ where: { id: truck.id }, select: { code: true, lastLat: true, lastLng: true, lastPingAt: true } });
  return NextResponse.json({
    truckCode: current.code,
    lat: current.lastLat,
    lng: current.lastLng,
    pingAt: current.lastPingAt,
    applied,
  });
}
