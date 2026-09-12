import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { writeAudit } from "@/lib/audit";
import { verifyIntegrationRequest } from "@/lib/integration-auth";
import { allowTelemetryBurst, resolveObservedAt, TELEMETRY_BURST_LIMIT, TELEMETRY_BURST_WINDOW_MS } from "@/lib/telemetry";

// SCADA silo-level webhook — the design spec routes silo/hopper instrumentation
// through an on-site edge gateway that translates OPC-UA/MQTT into this kind
// of REST call. Distinct from the manual "Update" control on the Silos
// screen: this path stamps lastSensorReadingAt so the UI can eventually
// distinguish a live sensor feed from a human override.
//
// Example: POST /api/scada/silo-reading
// Authorization: Bearer <INTEGRATION_API_KEY>
// { "siloId": "cmt1...", "levelTons": 11.6, "observedAt": "2026-09-12T08:15:00Z" }
//
// `observedAt` is optional and backward compatible — a gateway that does
// not send it gets the previous behaviour (receipt time). See
// src/lib/telemetry.ts for why ordering by observation time matters.
export async function POST(request: NextRequest) {
  const principal = await verifyIntegrationRequest(request, "SCADA");
  if (principal instanceof NextResponse) return principal;

  const body = await request.json().catch(() => null);
  if (body && typeof body.siloId === "string" && !allowTelemetryBurst(`scada:${principal.keyId}:${body.siloId}`, Date.now(), TELEMETRY_BURST_LIMIT, TELEMETRY_BURST_WINDOW_MS)) {
    return NextResponse.json({ error: "Too many readings for this silo — slow down." }, { status: 429 });
  }
  if (!body || typeof body.siloId !== "string" || !body.siloId.trim() || typeof body.levelTons !== "number" || !Number.isFinite(body.levelTons) || body.levelTons < 0) {
    return NextResponse.json({ error: "Expected { siloId: string, levelTons: number }" }, { status: 400 });
  }

  const silo = await prisma.silo.findFirst({ where: { id: body.siloId, ...(principal.global ? {} : { plant: { siteId: principal.siteId! } }) } });
  if (!silo) {
    return NextResponse.json({ error: `No silo with id "${body.siloId}"` }, { status: 404 });
  }

  if (body.levelTons > silo.capacityTons) {
    return NextResponse.json({ error: "Reading exceeds silo capacity." }, { status: 400 });
  }

  const observed = resolveObservedAt(body.observedAt, new Date());
  if (observed.status === "INVALID") {
    return NextResponse.json({ error: observed.reason }, { status: 400 });
  }

  // The level this reading would set decides whether an auto-requisition
  // fires, so a stale reading applied over a fresh one is a real
  // operational error, not a cosmetic one. The WHERE clause is what
  // refuses it: a row whose stored observation is at or after this one
  // matches nothing.
  //
  // `applied: false` is a 200, not an error. A gateway resending a reading
  // it already delivered has done nothing wrong, and answering 4xx would
  // push it into a retry loop over a message that can never be accepted.
  const applied = await prisma.$transaction(async (tx) => {
    const claim = await tx.silo.updateMany({
      where: {
        id: silo.id,
        OR: [{ lastSensorReadingAt: null }, { lastSensorReadingAt: { lt: observed.observedAt } }],
      },
      data: { currentLevelTons: body.levelTons, lastSensorReadingAt: observed.observedAt },
    });
    if (claim.count !== 1) return false;

    // Audited inside the same transaction as the level change, like every
    // other weighed-record write in this codebase (AGENTS.md rule 5). A
    // superseded reading writes no audit row at all, which is also what
    // keeps this table from filling with duplicate telemetry.
    await writeAudit(tx, null, {
      module: "Silos",
      recordId: silo.id,
      field: "currentLevelTons",
      beforeValue: String(silo.currentLevelTons),
      afterValue: String(body.levelTons),
      reasonCode: "SCADA_SENSOR_READING",
    });
    return true;
  });

  const current = await prisma.silo.findUniqueOrThrow({ where: { id: silo.id }, select: { name: true, currentLevelTons: true, lastSensorReadingAt: true } });
  return NextResponse.json({
    siloName: current.name,
    currentLevelTons: current.currentLevelTons,
    readingAt: current.lastSensorReadingAt,
    applied,
  });
}
