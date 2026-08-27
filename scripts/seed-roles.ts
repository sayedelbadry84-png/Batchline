// One-off backfill: create the Role table rows for the 5 existing system
// roles (isSystem: true, so /roles can't delete/rename them) plus the 8
// newly-requested roles (isSystem: false). Run once with:
//   npx tsx scripts/seed-roles.ts
import { PrismaClient } from "@prisma/client";

const prisma = new PrismaClient();

const ROLES: { key: string; labelAr: string; labelEn: string; isSystem: boolean }[] = [
  { key: "ADMIN", labelAr: "مسؤول النظام", labelEn: "Admin", isSystem: true },
  { key: "PLANT_OPERATOR", labelAr: "مشغل المصنع", labelEn: "Plant Operator", isSystem: true },
  { key: "QUALITY_SUPERVISOR", labelAr: "مشرف الجودة", labelEn: "Quality Supervisor", isSystem: true },
  { key: "ACCOUNTANT", labelAr: "محاسب", labelEn: "Accountant", isSystem: true },
  { key: "DRIVER", labelAr: "سائق", labelEn: "Driver", isSystem: true },

  { key: "RESERVATIONS_OFFICER", labelAr: "مسئول الحجوزات", labelEn: "Reservations Officer", isSystem: false },
  { key: "SALES_REP", labelAr: "مندوب المبيعات", labelEn: "Sales Rep", isSystem: false },
  { key: "SALES_MANAGER", labelAr: "مدير المبيعات", labelEn: "Sales Manager", isSystem: false },
  { key: "PLANTS_MANAGER", labelAr: "مدير المصانع", labelEn: "Plants Manager", isSystem: false },
  { key: "OPERATIONS_MANAGER", labelAr: "مدير التشغيل", labelEn: "Operations Manager", isSystem: false },
  { key: "PLANT_MANAGER", labelAr: "مدير المصنع", labelEn: "Plant Manager", isSystem: false },
  { key: "OPERATIONS_SUPERVISOR", labelAr: "مراقب التشغيل", labelEn: "Operations Supervisor", isSystem: false },
  { key: "PLANT_ADMIN", labelAr: "اداري المصنع", labelEn: "Plant Admin", isSystem: false },
];

async function main() {
  for (const role of ROLES) {
    await prisma.role.upsert({
      where: { key: role.key },
      update: {},
      create: role,
    });
  }
  const all = await prisma.role.findMany({ orderBy: { createdAt: "asc" } });
  console.log(`Seeded ${all.length} roles:`);
  for (const r of all) console.log(`  ${r.key} — ${r.labelAr} / ${r.labelEn} (isSystem=${r.isSystem})`);
}

main().finally(() => prisma.$disconnect());
