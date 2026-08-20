import { PrismaClient } from "@prisma/client";
import bcrypt from "bcryptjs";

const prisma = new PrismaClient();

async function main() {
  const plant = await prisma.plant.create({
    data: { name: "Plant 02 — 6th of October", city: "6th of October City", currency: "EGP" },
  });

  await prisma.silo.createMany({
    data: [
      { plantId: plant.id, name: "S-1", materialType: "CEMENT", capacityTons: 100, currentLevelTons: 14, minThresholdPct: 15 },
      { plantId: plant.id, name: "S-2", materialType: "FLY_ASH", capacityTons: 60, currentLevelTons: 36.6, minThresholdPct: 15 },
      { plantId: plant.id, name: "S-3", materialType: "CEMENT", capacityTons: 100, currentLevelTons: 38, minThresholdPct: 15 },
    ],
  });

  await prisma.hopper.createMany({
    data: [
      { plantId: plant.id, name: "H-1", aggregateType: "SAND", capacityTons: 200, currentLevelTons: 154 },
      { plantId: plant.id, name: "H-2", aggregateType: "COARSE_AGGREGATE_20MM", capacityTons: 200, currentLevelTons: 120 },
    ],
  });

  const supplier = await prisma.supplier.create({
    data: { name: "Suez Aggregates Co.", materialCatalog: "Sand, coarse aggregate", leadTimeDays: 2, rejectionRatePct: 0.8 },
  });
  const cementSupplier = await prisma.supplier.create({
    data: { name: "El-Sewedy Cement", materialCatalog: "OPC, fly ash", leadTimeDays: 3, rejectionRatePct: 0.2 },
  });

  const cement = await prisma.material.create({
    data: { name: "Ordinary Portland Cement (OPC 42.5)", type: "CEMENT", supplierId: cementSupplier.id, specificGravity: 3.15, absorptionPct: 0 },
  });
  const sand = await prisma.material.create({
    data: { name: "Natural sand", type: "SAND", supplierId: supplier.id, specificGravity: 2.65, absorptionPct: 1.1 },
  });
  const coarse = await prisma.material.create({
    data: { name: "Coarse aggregate 20mm", type: "COARSE_AGGREGATE", supplierId: supplier.id, specificGravity: 2.7, absorptionPct: 0.6 },
  });
  const water = await prisma.material.create({
    data: { name: "Batching water", type: "WATER", specificGravity: 1.0, absorptionPct: 0 },
  });
  const admix = await prisma.material.create({
    data: { name: "Superplasticizer (PCE-based)", type: "ADMIXTURE", specificGravity: 1.08, absorptionPct: 0 },
  });

  const mix = await prisma.mixDesign.create({
    data: {
      code: "C30-20-S3",
      grade: "C30/37",
      exposureClass: "XC2",
      slumpTargetMm: 100,
      wcRatio: 0.5,
      yieldTargetM3: 1,
      status: "APPROVED",
      standardCost: 1450,
    },
  });

  await prisma.mixComponent.createMany({
    data: [
      { mixId: mix.id, materialId: cement.id, designMassKgPerM3: 340, tolerancePct: 1 },
      { mixId: mix.id, materialId: sand.id, designMassKgPerM3: 780, tolerancePct: 2 },
      { mixId: mix.id, materialId: coarse.id, designMassKgPerM3: 1040, tolerancePct: 2 },
      { mixId: mix.id, materialId: water.id, designMassKgPerM3: 170, tolerancePct: 1 },
      { mixId: mix.id, materialId: admix.id, designMassKgPerM3: 3.4, tolerancePct: 3 },
    ],
  });

  const customer = await prisma.customer.create({
    data: {
      legalName: "Nile Towers Development",
      taxId: "EG-100-223-451",
      creditLimit: 2_500_000,
      paymentTerms: "Net 30",
      contactEmail: "procurement@niletowers.example",
    },
  });

  const project = await prisma.project.create({
    data: {
      name: "Nile Towers — Phase 2",
      customerId: customer.id,
      plantId: plant.id,
      siteAddress: "Gate 4, Nile Towers Site, 6th of October",
      contractedVolumeM3: 12000,
      status: "ACTIVE",
    },
  });

  await prisma.reservation.create({
    data: {
      projectId: project.id,
      mixId: mix.id,
      requestedVolumeM3: 7,
      pourWindowStart: new Date(Date.now() + 1000 * 60 * 60 * 24),
      status: "CONFIRMED",
    },
  });

  const empAhmed = await prisma.employee.create({
    data: { plantId: plant.id, name: "Ahmed Farouk", role: "PLANT_OPERATOR", shiftPattern: "Day / 6am–6pm" },
  });
  const empMona = await prisma.employee.create({
    data: { plantId: plant.id, name: "Mona Ezzat", role: "QUALITY_SUPERVISOR", shiftPattern: "Day / 8am–4pm" },
  });
  const empNour = await prisma.employee.create({
    data: { plantId: plant.id, name: "Nourhan Sami", role: "ACCOUNTANT", shiftPattern: "Day / 9am–5pm" },
  });
  const empKarim = await prisma.employee.create({
    data: {
      plantId: plant.id, name: "Karim Adel", role: "DRIVER", shiftPattern: "Day / 6am–6pm",
      licenseNumber: "DL-88213", licenseExpiry: new Date(Date.now() + 1000 * 60 * 60 * 24 * 20),
    },
  });
  const empHassan = await prisma.employee.create({
    data: {
      plantId: plant.id, name: "Hassan Zaki", role: "DRIVER", shiftPattern: "Day / 6am–6pm",
      licenseNumber: "DL-77410", licenseExpiry: new Date(Date.now() + 1000 * 60 * 60 * 24 * 400),
    },
  });

  // Dev-only seeded logins — same password for every account, printed to
  // the console below. Never do this for a real deployment.
  const DEV_PASSWORD_HASH = await bcrypt.hash("batchline123", 10);
  await prisma.user.createMany({
    data: [
      { email: "plant.operator@batchline.dev", name: "Ahmed Farouk", passwordHash: DEV_PASSWORD_HASH, role: "PLANT_OPERATOR", plantId: plant.id, employeeId: empAhmed.id },
      { email: "quality@batchline.dev", name: "Mona Ezzat", passwordHash: DEV_PASSWORD_HASH, role: "QUALITY_SUPERVISOR", plantId: plant.id, employeeId: empMona.id },
      { email: "accountant@batchline.dev", name: "Nourhan Sami", passwordHash: DEV_PASSWORD_HASH, role: "ACCOUNTANT", plantId: plant.id, employeeId: empNour.id },
      { email: "admin@batchline.dev", name: "Batchline Admin", passwordHash: DEV_PASSWORD_HASH, role: "ADMIN", plantId: plant.id },
      { email: "karim.driver@batchline.dev", name: "Karim Adel", passwordHash: DEV_PASSWORD_HASH, role: "DRIVER", plantId: plant.id, employeeId: empKarim.id },
      { email: "hassan.driver@batchline.dev", name: "Hassan Zaki", passwordHash: DEV_PASSWORD_HASH, role: "DRIVER", plantId: plant.id, employeeId: empHassan.id },
    ],
  });

  await prisma.complianceCertificate.create({
    data: {
      mixId: mix.id,
      standardRef: "ES 4756-1 / EN 206",
      issuingBody: "Egyptian Organization for Standardization & Quality",
      issuedDate: new Date(Date.now() - 1000 * 60 * 60 * 24 * 200),
      expiryDate: new Date(Date.now() + 1000 * 60 * 60 * 24 * 45),
    },
  });

  await prisma.truck.createMany({
    data: [
      { plantId: plant.id, code: "MX-14", drumCapacityM3: 8, maxAgitationRpm: 14, gpsDeviceId: "GPS-114", status: "ACTIVE" },
      { plantId: plant.id, code: "MX-08", drumCapacityM3: 7, maxAgitationRpm: 14, gpsDeviceId: "GPS-108", status: "ACTIVE" },
      { plantId: plant.id, code: "MX-21", drumCapacityM3: 9, maxAgitationRpm: 12, gpsDeviceId: "GPS-121", status: "MAINTENANCE" },
    ],
  });

  await prisma.pump.createMany({
    data: [
      { plantId: plant.id, code: "PMP-1", pumpType: "BOOM", reachM: 37, hourlyRate: 850, standbyRate: 400, status: "ACTIVE" },
      { plantId: plant.id, code: "PMP-2", pumpType: "LINE", reachM: 60, hourlyRate: 500, standbyRate: 250, status: "ACTIVE" },
    ],
  });

  const siloS3 = await prisma.silo.findFirstOrThrow({ where: { plantId: plant.id, name: "S-3" } });
  await prisma.materialReceipt.create({
    data: {
      plantId: plant.id,
      supplierId: cementSupplier.id,
      materialId: cement.id,
      poNumber: "PO-4471",
      orderedMassKg: 30000,
      grossWeightKg: 42800,
      tareWeightKg: 13100,
      netWeightKg: 42800 - 13100,
      moisturePct: 0,
      destinationSiloId: siloS3.id,
      qcStatus: "PENDING",
    },
  });

  console.log("Seed complete. Log in at /login with any seeded email and password 'batchline123'.");
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
