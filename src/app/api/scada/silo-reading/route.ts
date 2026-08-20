import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { logAudit } from "@/lib/audit";

// SCADA silo-level webhook — the design spec routes silo/hopper instrumentation
// through an on-site edge gateway that translates OPC-UA/MQTT into this kind
// of REST call. Distinct from the manual "Update" control on the Silos
// screen: this path stamps lastSensorReadingAt so the UI can eventually
// distinguish a live sensor feed from a human override.
//
// Example: POST /api/scada/silo-reading
// { "siloId": "cmt1...", "levelTons": 11.6 }
export async function POST(request: NextRequest) {
  const body = await request.json().catch(() => null);
  if (!body || typeof body.siloId !== "string" || typeof body.levelTons !== "number") {
    return NextResponse.json({ error: "Expected { siloId: string, levelTons: number }" }, { status: 400 });
  }

  const silo = await prisma.silo.findUnique({ where: { id: body.siloId } });
  if (!silo) {
    return NextResponse.json({ error: `No silo with id "${body.siloId}"` }, { status: 404 });
  }

  const updated = await prisma.silo.update({
    where: { id: silo.id },
    data: { currentLevelTons: body.levelTons, lastSensorReadingAt: new Date() },
  });

  await logAudit({
    module: "Silos",
    recordId: silo.id,
    field: "currentLevelTons",
    beforeValue: String(silo.currentLevelTons),
    afterValue: String(body.levelTons),
    reasonCode: "SCADA_SENSOR_READING",
  });

  return NextResponse.json({
    siloName: updated.name,
    currentLevelTons: updated.currentLevelTons,
    readingAt: updated.lastSensorReadingAt,
  });
}
