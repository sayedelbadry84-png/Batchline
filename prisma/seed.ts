import { PrismaClient } from "@prisma/client";

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

  await prisma.employee.createMany({
    data: [
      { plantId: plant.id, name: "Ahmed Farouk", role: "PLANT_OPERATOR", shiftPattern: "Day / 6am–6pm" },
      { plantId: plant.id, name: "Mona Ezzat", role: "QUALITY_SUPERVISOR", shiftPattern: "Day / 8am–4pm" },
      { plantId: plant.id, name: "Karim Adel", role: "DRIVER", shiftPattern: "Day / 6am–6pm", licenseNumber: "DL-88213", licenseExpiry: new Date(Date.now() + 1000 * 60 * 60 * 24 * 20) },
      { plantId: plant.id, name: "Hassan Zaki", role: "DRIVER", shiftPattern: "Day / 6am–6pm", licenseNumber: "DL-77410", licenseExpiry: new Date(Date.now() + 1000 * 60 * 60 * 24 * 400) },
    ],
  });

  await prisma.truck.createMany({
    data: [
      { plantId: plant.id, code: "MX-14", drumCapacityM3: 8, maxAgitationRpm: 14, gpsDeviceId: "GPS-114", status: "ACTIVE" },
      { plantId: plant.id, code: "MX-08", drumCapacityM3: 7, maxAgitationRpm: 14, gpsDeviceId: "GPS-108", status: "ACTIVE" },
      { plantId: plant.id, code: "MX-21", drumCapacityM3: 9, maxAgitationRpm: 12, gpsDeviceId: "GPS-121", status: "MAINTENANCE" },
    ],
  });

  console.log("Seed complete.");
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
