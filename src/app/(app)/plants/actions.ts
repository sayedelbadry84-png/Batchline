"use server";

import { prisma } from "@/lib/prisma";
import { logAudit } from "@/lib/audit";
import { getCurrentUser, requireActionPermission } from "@/lib/session";
import { extractYardLatLng } from "@/lib/mapLink";
import { effectiveSiteId, isPlantInScope, isSiteInScope } from "@/lib/siteScope";
import { isValidHexColor } from "@/lib/accentColor";
import { revalidatePath } from "next/cache";

const PLANT_STATUSES = ["ACTIVE", "FROZEN", "DECOMMISSIONED"] as const;

export async function createSite(formData: FormData) {
  const user = await getCurrentUser();
  await requireActionPermission(user, "plants", "createSite");

  const code = String(formData.get("code") ?? "").trim();
  const name = String(formData.get("name") ?? "").trim();
  const city = String(formData.get("city") ?? "").trim();
  const country = String(formData.get("country") ?? "").trim() || null;
  if (!code || !name || !city) return;

  const site = await prisma.site.create({ data: { code, name, city, country } });

  await logAudit({ module: "PlantManagement", recordId: site.id, afterValue: name, reasonCode: "SITE_CREATED" });
  revalidatePath("/plants");
}

export async function updateSite(formData: FormData) {
  const user = await getCurrentUser();
  await requireActionPermission(user, "plants", "updateSite");

  const id = String(formData.get("id") ?? "");
  const code = String(formData.get("code") ?? "").trim();
  const name = String(formData.get("name") ?? "").trim();
  const city = String(formData.get("city") ?? "").trim();
  const country = String(formData.get("country") ?? "").trim() || null;
  const accentColorRaw = String(formData.get("accentColor") ?? "").trim();
  // Malformed input (shouldn't happen from the <input type="color"> this
  // form actually submits, but defends the field either way) is dropped
  // rather than saved as garbage — same "silently skip, don't corrupt"
  // posture as every other soft-validated field in this app.
  const accentColor = accentColorRaw && isValidHexColor(accentColorRaw) ? accentColorRaw.toLowerCase() : null;
  if (!id || !code || !name || !city) return;

  const before = await prisma.site.findUnique({ where: { id } });
  await prisma.site.update({ where: { id }, data: { code, name, city, country, accentColor } });

  await logAudit({
    module: "PlantManagement",
    recordId: id,
    field: "code/name/city/country",
    beforeValue: `${before?.code} / ${before?.name} / ${before?.city} / ${before?.country}`,
    afterValue: `${code} / ${name} / ${city} / ${country}`,
    reasonCode: "SITE_UPDATED",
  });

  revalidatePath("/plants");
}

// "Plant" here means a production line within a Site — see the model
// comment in schema.prisma for why the two are now separate.
export async function createPlant(formData: FormData) {
  const user = await getCurrentUser();
  await requireActionPermission(user, "plants", "createPlant");

  const siteId = String(formData.get("siteId") ?? "");
  const name = String(formData.get("name") ?? "").trim();
  const currency = String(formData.get("currency") ?? "EGP").trim();
  const timezone = String(formData.get("timezone") ?? "Africa/Cairo").trim();
  const taxRatePct = Number(formData.get("taxRatePct") ?? 0) || 0;
  const taxLabel = String(formData.get("taxLabel") ?? "VAT").trim() || "VAT";
  const poApprovalThreshold = Number(formData.get("poApprovalThreshold") ?? 0) || null;

  if (!siteId || !name) return;
  if (!isSiteInScope(siteId, effectiveSiteId(user))) return;

  const plant = await prisma.plant.create({
    data: { siteId, name, currency, timezone, taxRatePct, taxLabel, poApprovalThreshold },
  });

  await logAudit({
    module: "PlantManagement",
    recordId: plant.id,
    afterValue: name,
    reasonCode: "PLANT_CREATED",
  });

  revalidatePath("/plants");
}

// Status (ACTIVE/FROZEN/DECOMMISSIONED — see the Plant.status comment in
// schema.prisma) and moving to a different site both go through this one
// edit form, same convention as every other roster/equipment screen. Only
// ADMIN can move a line between sites — that's a structural reorg, not a
// day-to-day edit a site's own PLANT_OPERATOR should be able to trigger —
// so a non-ADMIN's submitted siteId is silently ignored if it names a
// different site than the line is already on (their own site's status
// changes still go through).
export async function updatePlant(formData: FormData) {
  const user = await getCurrentUser();
  await requireActionPermission(user, "plants", "updatePlant");

  const id = String(formData.get("id") ?? "");
  const requestedSiteId = String(formData.get("siteId") ?? "");
  const name = String(formData.get("name") ?? "").trim();
  const currency = String(formData.get("currency") ?? "").trim();
  const timezone = String(formData.get("timezone") ?? "").trim();
  const taxRatePct = Number(formData.get("taxRatePct") ?? 0) || 0;
  const taxLabel = String(formData.get("taxLabel") ?? "VAT").trim() || "VAT";
  const poApprovalThreshold = Number(formData.get("poApprovalThreshold") ?? 0) || null;
  const statusRaw = String(formData.get("status") ?? "ACTIVE");
  const status = (PLANT_STATUSES as readonly string[]).includes(statusRaw) ? statusRaw : "ACTIVE";
  if (!id || !requestedSiteId || !name) return;

  const before = await prisma.plant.findUnique({ where: { id } });
  if (!before) return;
  if (!(await isPlantInScope(id, effectiveSiteId(user)))) return;

  const isAdmin = user?.role === "ADMIN";
  const siteId = isAdmin ? requestedSiteId : before.siteId;
  if (isAdmin && !isSiteInScope(siteId, effectiveSiteId(user))) return;

  await prisma.plant.update({ where: { id }, data: { siteId, name, currency, timezone, taxRatePct, taxLabel, poApprovalThreshold, status } });

  await logAudit({
    module: "PlantManagement",
    recordId: id,
    field: "site/name/currency/timezone/tax/status",
    beforeValue: `${before.siteId} / ${before.name} / ${before.currency} / ${before.timezone} / ${before.taxLabel} ${before.taxRatePct}% / ${before.status}`,
    afterValue: `${siteId} / ${name} / ${currency} / ${timezone} / ${taxLabel} ${taxRatePct}% / ${status}`,
    reasonCode: siteId !== before.siteId ? "PLANT_TRANSFERRED" : "PLANT_UPDATED",
  });

  revalidatePath("/plants");
}

export async function updatePlantThresholds(formData: FormData) {
  const user = await getCurrentUser();
  await requireActionPermission(user, "plants", "updatePlantThresholds");

  const id = String(formData.get("id") ?? "");
  const drumTimerLimitMinutes = Number(formData.get("drumTimerLimitMinutes") ?? 90);
  const returnAbsorptionThresholdM3 = Number(formData.get("returnAbsorptionThresholdM3") ?? 0.2);
  const maintenanceIntervalTrips = Number(formData.get("maintenanceIntervalTrips") ?? 150);
  // Geofenced yard — all three left blank turns geofencing off for this
  // plant (see the distance check in the telematics webhook). A pasted
  // Google Maps link is just a convenience input path for the same two
  // fields — if it parses, it wins over whatever the manual lat/lng boxes
  // say; if it doesn't parse (or is blank), the manual boxes stand as-is.
  let yardLat = Number(formData.get("yardLat") ?? 0) || null;
  let yardLng = Number(formData.get("yardLng") ?? 0) || null;
  const yardRadiusM = Number(formData.get("yardRadiusM") ?? 0) || null;
  const yardLocationLink = String(formData.get("yardLocationLink") ?? "").trim();
  if (yardLocationLink) {
    const extracted = await extractYardLatLng(yardLocationLink);
    if (extracted) {
      yardLat = extracted.lat;
      yardLng = extracted.lng;
    }
  }
  if (!id) return;
  if (!(await isPlantInScope(id, effectiveSiteId(user)))) return;

  const before = await prisma.plant.findUnique({ where: { id } });
  await prisma.plant.update({
    where: { id },
    data: { drumTimerLimitMinutes, returnAbsorptionThresholdM3, maintenanceIntervalTrips, yardLat, yardLng, yardRadiusM },
  });

  await logAudit({
    module: "PlantManagement",
    recordId: id,
    field: "thresholds",
    beforeValue: `${before?.drumTimerLimitMinutes}min / ${before?.returnAbsorptionThresholdM3}m3 / ${before?.maintenanceIntervalTrips}trips`,
    afterValue: `${drumTimerLimitMinutes}min / ${returnAbsorptionThresholdM3}m3 / ${maintenanceIntervalTrips}trips`,
    reasonCode: "TOLERANCE_UPDATED",
  });

  revalidatePath("/plants");
}

// ZATCA (Saudi e-invoicing) registration for a site — see ZatcaSettings'
// own schema comment for why only the non-secret identifiers (VAT/CR
// number, seller legal name, sandbox/production) live here at all; the
// actual CSID certificate/private key from onboarding go in environment
// variables, never through this form. Gated to Accountant/Admin, not the
// plant-operator roles that manage the rest of this page — this is a tax
// compliance fact, not an operational plant setting.
export async function updateZatcaSettings(formData: FormData) {
  const user = await getCurrentUser();
  await requireActionPermission(user, "plants", "updateZatcaSettings");

  const siteId = String(formData.get("siteId") ?? "");
  if (!siteId) return;
  if (!isSiteInScope(siteId, effectiveSiteId(user))) return;

  const sellerLegalName = String(formData.get("sellerLegalName") ?? "").trim() || null;
  const vatNumber = String(formData.get("vatNumber") ?? "").trim() || null;
  const crNumber = String(formData.get("crNumber") ?? "").trim() || null;
  const environment = String(formData.get("environment") ?? "SANDBOX") === "PRODUCTION" ? "PRODUCTION" : "SANDBOX";

  const before = await prisma.zatcaSettings.findUnique({ where: { siteId } });
  await prisma.zatcaSettings.upsert({
    where: { siteId },
    create: { siteId, sellerLegalName, vatNumber, crNumber, environment },
    update: { sellerLegalName, vatNumber, crNumber, environment },
  });

  await logAudit({
    module: "PlantManagement",
    recordId: siteId,
    field: "zatcaSettings",
    beforeValue: before ? `${before.vatNumber ?? "—"} / ${before.crNumber ?? "—"} / ${before.environment}` : "—",
    afterValue: `${vatNumber ?? "—"} / ${crNumber ?? "—"} / ${environment}`,
    reasonCode: "ZATCA_SETTINGS_UPDATED",
  });

  revalidatePath("/plants");
}

// WPS (Wage Protection System) establishment registration for a site — see
// WpsSettings' own schema comment. Same Accountant/Admin gate as ZATCA:
// this is a payroll-compliance fact, not an operational plant setting.
export async function updateWpsSettings(formData: FormData) {
  const user = await getCurrentUser();
  await requireActionPermission(user, "plants", "updateWpsSettings");

  const siteId = String(formData.get("siteId") ?? "");
  if (!siteId) return;
  if (!isSiteInScope(siteId, effectiveSiteId(user))) return;

  const establishmentId = String(formData.get("establishmentId") ?? "").trim() || null;

  const before = await prisma.wpsSettings.findUnique({ where: { siteId } });
  await prisma.wpsSettings.upsert({
    where: { siteId },
    create: { siteId, establishmentId },
    update: { establishmentId },
  });

  await logAudit({
    module: "PlantManagement",
    recordId: siteId,
    field: "wpsSettings",
    beforeValue: before?.establishmentId ?? "—",
    afterValue: establishmentId ?? "—",
    reasonCode: "WPS_SETTINGS_UPDATED",
  });

  revalidatePath("/plants");
}
