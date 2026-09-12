// Evidence that the composite indexes added on 2026-09-12 are (a) really
// in the database and shaped the way the schema says, and (b) actually
// chosen by the planner for the query shapes they were added for.
//
// Both halves matter, and the first is not a formality here. These
// indexes ship as hand-written `CREATE INDEX CONCURRENTLY` migrations
// because `prisma migrate diff` cannot generate that form (see
// prisma/MIGRATIONS.md), which means a column name or its position is
// typed by a human into SQL that Prisma never checks against the schema.
// Nothing else in this repo would notice the drift: `prisma migrate
// deploy` would succeed, the app would run, and the index would silently
// not serve the query it was written for.
//
// The second half is the part AGENTS.md asks for by name — "add composite
// ones from real query shapes with EXPLAIN evidence". An index nobody's
// plan uses is write amplification with extra steps, so each shape below
// is EXPLAINed against seeded volume and the plan must name the intended
// index. The planner is never coerced: no enable_seqscan=off, no index
// hints. If a seq scan wins, the index has not earned its place and this
// test says so.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";

if (!process.env.TEST_DATABASE_URL) {
  throw new Error("TEST_DATABASE_URL must be set to run these tests — see prisma/MIGRATIONS.md. Refusing to guess a database.");
}
if (process.env.TEST_DATABASE_URL === process.env.DATABASE_URL) {
  throw new Error("TEST_DATABASE_URL must differ from DATABASE_URL — refusing to run destructive tests against what may be a real database.");
}
process.env.DATABASE_URL = process.env.TEST_DATABASE_URL;

const { PrismaClient } = await import("@prisma/client");
const prisma = new PrismaClient();

// ---------------------------------------------------------------------
// Part 1 — the schema's @@index declarations exist, with the right
// columns in the right order.
// ---------------------------------------------------------------------

type DeclaredIndex = { model: string; columns: string[] };

// No model or field in this schema carries @map/@@map, so a Prisma name
// is the Postgres name verbatim. A test asserts that stays true, rather
// than leaving this parser quietly wrong the day someone adds one.
function declaredIndexes(schema: string): DeclaredIndex[] {
  const out: DeclaredIndex[] = [];
  let model: string | null = null;
  for (const line of schema.split("\n")) {
    const start = /^model (\w+) \{/.exec(line);
    if (start) {
      model = start[1];
      continue;
    }
    if (line === "}") {
      model = null;
      continue;
    }
    const idx = /^\s*@@index\(\[([^\]]+)\]/.exec(line);
    if (idx && model) {
      out.push({ model, columns: idx[1].split(",").map((c) => c.trim()) });
    }
  }
  return out;
}

const schemaText = readFileSync(join(process.cwd(), "prisma/schema.prisma"), "utf8");

test("the schema uses no @map/@@map, so Prisma names are Postgres names", () => {
  // The whole of Part 1 reads Prisma identifiers straight out of the
  // schema and looks them up in pg_catalog. That is only valid while no
  // name is remapped.
  assert.equal(/@@?map\s*\(/.test(schemaText), false, "a @map/@@map appeared — the index lookup below must learn to translate names");
});

test("every @@index in the schema exists in the database with matching columns", async () => {
  const declared = declaredIndexes(schemaText);
  assert.ok(declared.length >= 20, `expected the schema to declare a meaningful number of indexes, found ${declared.length}`);

  const actual = await prisma.$queryRawUnsafe<{ table_name: string; index_name: string; columns: string[] }[]>(`
    SELECT t.relname AS table_name,
           i.relname AS index_name,
           array_agg(a.attname ORDER BY k.ord) AS columns
    FROM pg_class t
    JOIN pg_index ix ON ix.indrelid = t.oid
    JOIN pg_class i ON i.oid = ix.indexrelid
    JOIN pg_namespace n ON n.oid = t.relnamespace
    CROSS JOIN LATERAL unnest(ix.indkey) WITH ORDINALITY AS k(attnum, ord)
    JOIN pg_attribute a ON a.attrelid = t.oid AND a.attnum = k.attnum
    WHERE n.nspname = current_schema() AND t.relkind = 'r'
    GROUP BY t.relname, i.relname
  `);

  const byTable = new Map<string, string[][]>();
  for (const row of actual) {
    if (!byTable.has(row.table_name)) byTable.set(row.table_name, []);
    byTable.get(row.table_name)!.push(row.columns);
  }

  const missing = declared.filter(({ model, columns }) => {
    const candidates = byTable.get(model) ?? [];
    return !candidates.some((cols) => cols.length === columns.length && cols.every((c, i) => c === columns[i]));
  });

  assert.deepEqual(
    missing.map((m) => `${m.model}(${m.columns.join(", ")})`),
    [],
    "these @@index declarations have no matching index in the database — a hand-written CONCURRENTLY migration is missing or has drifted from the schema",
  );
});

// ---------------------------------------------------------------------
// Part 2 — the planner actually uses them.
// ---------------------------------------------------------------------

const PREFIX = `IDXCOV-${Date.now()}`;
// Enough rows that a sequential scan is genuinely the more expensive
// option, and spread over five scopes and three years so a one-scope,
// one-month window is the ~0.5% slice these reports really ask for. A
// smaller table would let a seq scan win on cost alone and the test would
// be measuring the fixture rather than the index.
const ROWS = 20000;
const SCOPES = 5;
// Trips are spread over this many trucks and drivers, which is also the
// ceiling on how many may be open at once (see the partial unique indexes
// noted below).
const FLEET = 50;
const WINDOW_FROM = "2025-06-01";
const WINDOW_TO = "2025-06-30";

const siteIds: string[] = [];
const plantIds: string[] = [];
let userId = "";
const truckIds: string[] = [];
const driverIds: string[] = [];
let reservationId = "";
let mixId = "";

before(async () => {
  for (let i = 0; i < SCOPES; i += 1) {
    const site = await prisma.site.create({ data: { code: `${PREFIX}-S${i}`, name: `${PREFIX}-SITE-${i}`, city: "Test", country: "Test" } });
    siteIds.push(site.id);
    const plant = await prisma.plant.create({ data: { siteId: site.id, name: `${PREFIX}-PLANT-${i}` } });
    plantIds.push(plant.id);
  }

  const user = await prisma.user.create({
    data: { name: `${PREFIX}-USER`, email: `${PREFIX}@example.test`, passwordHash: "x", role: "ADMIN", plantId: plantIds[0] },
  });
  userId = user.id;

  // A fleet, not one truck. Two partial unique indexes from the
  // production-lifecycle hardening — Trip_one_open_per_truck and
  // Trip_one_open_per_driver — allow only ONE non-CLOSED trip per truck
  // and per driver, so the first version of this fixture (20k IN_TRANSIT
  // trips on a single truck) was rejected outright. That is the invariant
  // doing its job; the fixture had to become realistic instead.
  for (let i = 0; i < FLEET; i += 1) {
    const truck = await prisma.truck.create({ data: { plantId: plantIds[0], code: `${PREFIX}-TRK-${i}`, drumCapacityM3: 10 } });
    truckIds.push(truck.id);
    const driver = await prisma.employee.create({ data: { plantId: plantIds[0], name: `${PREFIX}-DRIVER-${i}`, role: "DRIVER" } });
    driverIds.push(driver.id);
  }

  const customer = await prisma.customer.create({ data: { legalName: `${PREFIX}-CUSTOMER`, creditLimit: 1 } });
  const project = await prisma.project.create({ data: { name: `${PREFIX}-PROJECT`, customerId: customer.id, siteAddress: "Test" } });
  const mix = await prisma.mixDesign.create({ data: { code: `${PREFIX}-MIX`, grade: "C25", slumpTargetMm: 100, wcRatio: 0.5 } });
  mixId = mix.id;
  const reservation = await prisma.reservation.create({
    data: {
      reservationNumber: `${PREFIX}-RES`,
      projectId: project.id,
      siteId: siteIds[0],
      mixId: mix.id,
      requestedVolumeM3: 1,
      originalVolumeM3: 1,
      pourWindowStart: new Date(),
      status: "CONFIRMED",
    },
  });
  reservationId = reservation.id;

  // Seeded with generate_series rather than createMany: 60k rows through
  // the JS client would dominate this suite's runtime, and the point of
  // the fixture is row count, not how it got there.
  const spread = `('2024-01-01'::timestamp + (g * interval '78 minutes'))`;

  await prisma.$executeRawUnsafe(
    `INSERT INTO "CashTransaction"
       (id, "txnNumber", "siteId", direction, category, amount, currency, description, "occurredAt", "createdById", "createdAt")
     SELECT $1 || '-CT-' || g, $1 || '-TXN-' || g, (ARRAY[${siteIds.map((_, i) => `$${i + 2}`).join(",")}])[1 + (g % ${SCOPES})],
            'OUT', 'FUEL', 100, 'EGP', $1, ${spread}, $${SCOPES + 2}, now()
     FROM generate_series(1, ${ROWS}) g`,
    PREFIX,
    ...siteIds,
    userId,
  );

  await prisma.$executeRawUnsafe(
    `INSERT INTO "BatchTicket"
       (id, "reservationId", "mixId", "plantId", "ticketNumber", "volumeM3", status, "releasedAt", "batchCompletedAt", "createdAt", "updatedAt")
     SELECT $1 || '-BT-' || g, $${SCOPES + 2}, $${SCOPES + 3}, (ARRAY[${plantIds.map((_, i) => `$${i + 2}`).join(",")}])[1 + (g % ${SCOPES})],
            $1 || '-TKT-' || g, 7.5,
            CASE WHEN g % 2 = 0 THEN 'COMPLETE' ELSE 'RELEASED' END,
            ${spread}, ${spread}, now(), now()
     FROM generate_series(1, ${ROWS}) g`,
    PREFIX,
    ...plantIds,
    reservationId,
    mixId,
  );

  // Only the first FLEET-1 rows are left open, and each of those lands on
  // its own truck and driver (g % FLEET === g while g < FLEET), so the
  // one-open-per-truck and one-open-per-driver indexes are satisfied. The
  // rest are CLOSED, which those partial indexes do not constrain at all.
  await prisma.$executeRawUnsafe(
    `INSERT INTO "Trip"
       (id, "batchTicketId", "truckId", "driverId", status, "batchTime", "dischargeEnd", "createdAt", "updatedAt")
     SELECT $1 || '-TP-' || g, $1 || '-BT-' || g,
            (ARRAY[${truckIds.map((_, i) => `$${i + 2}`).join(",")}])[1 + (g % ${FLEET})],
            (ARRAY[${driverIds.map((_, i) => `$${i + FLEET + 2}`).join(",")}])[1 + (g % ${FLEET})],
            CASE WHEN g < ${FLEET} THEN 'IN_TRANSIT' ELSE 'CLOSED' END,
            ${spread}, ${spread}, now(), now()
     FROM generate_series(1, ${ROWS}) g`,
    PREFIX,
    ...truckIds,
    ...driverIds,
  );

  // Without fresh statistics the planner costs these tables from whatever
  // the last autovacuum saw, which on a just-migrated CI database is zero
  // rows — and it would pick a seq scan for a table it believes is empty.
  await prisma.$executeRawUnsafe(`ANALYZE "CashTransaction", "BatchTicket", "Trip"`);
});

async function planFor(sql: string, params: unknown[]): Promise<string> {
  const rows = await prisma.$queryRawUnsafe<Record<string, string>[]>(`EXPLAIN ${sql}`, ...params);
  return rows.map((r) => Object.values(r)[0]).join("\n");
}

async function assertUsesIndex(label: string, index: string, sql: string, params: unknown[]) {
  const plan = await planFor(sql, params);
  assert.ok(
    plan.includes(index),
    `${label}: the planner did not choose ${index}. An index no plan uses is write cost for nothing — either the shape here is wrong or the index is.\n\nPlan:\n${plan}`,
  );
}

test("the cash-flow report's scope+date range uses CashTransaction(siteId, occurredAt)", async () => {
  // src/lib/reportQueries.ts:583, and the six expense-bucket queries at
  // :129-134 that share this shape.
  await assertUsesIndex(
    "cash flow",
    "CashTransaction_siteId_occurredAt_idx",
    `SELECT id, amount FROM "CashTransaction"
     WHERE "siteId" = $1 AND "occurredAt" >= $2::timestamp AND "occurredAt" <= $3::timestamp
     ORDER BY "occurredAt" ASC`,
    [siteIds[0], WINDOW_FROM, WINDOW_TO],
  );
});

test("the mix-yield report's plant+status+date shape uses the three-column BatchTicket index", async () => {
  // src/lib/reportQueries.ts:56 and :81. The status column sits between
  // the two because it is an equality and batchCompletedAt is a range —
  // reverse them and the range stops the index being usable for status.
  await assertUsesIndex(
    "mix yield",
    "BatchTicket_plantId_status_batchCompletedAt_idx",
    `SELECT id FROM "BatchTicket"
     WHERE "plantId" = $1 AND status = 'COMPLETE'
       AND "batchCompletedAt" >= $2::timestamp AND "batchCompletedAt" <= $3::timestamp`,
    [plantIds[0], WINDOW_FROM, WINDOW_TO],
  );
});

test("the production-volume report's plant+releasedAt shape uses its own index", async () => {
  // src/lib/reportQueries.ts:35 — a different date column from the one
  // above, which is why this is a second index and not a prefix of it.
  await assertUsesIndex(
    "production volume",
    "BatchTicket_plantId_releasedAt_idx",
    `SELECT id FROM "BatchTicket"
     WHERE "plantId" = $1 AND "releasedAt" >= $2::timestamp AND "releasedAt" <= $3::timestamp
     ORDER BY "releasedAt" ASC`,
    [plantIds[0], WINDOW_FROM, WINDOW_TO],
  );
});

test("the eight closed-trip reports use Trip(status, dischargeEnd)", async () => {
  // src/lib/reportQueries.ts:203, 241, 300, 343, 347, 351, 430, 437 —
  // every one of them status CLOSED plus a dischargeEnd range. Site scope
  // is a join through batchTicket.plant, not a column here, so it cannot
  // lead this index.
  await assertUsesIndex(
    "closed trips",
    "Trip_status_dischargeEnd_idx",
    `SELECT id FROM "Trip"
     WHERE status = 'CLOSED' AND "dischargeEnd" >= $1::timestamp AND "dischargeEnd" <= $2::timestamp
     ORDER BY "dischargeEnd" ASC`,
    [WINDOW_FROM, WINDOW_TO],
  );
});

test("the site-scoped closed-trip report never sequentially scans Trip", async () => {
  // The other shape tripPlantScopeWhere produces, when a site IS in
  // scope. This case asserts something weaker than the ones above, on
  // purpose, and the first version of it was simply wrong.
  //
  // It originally demanded Trip_status_dischargeEnd_idx here too, and the
  // planner refused — correctly. Given a site filter it drives from the
  // scoped side instead: narrow Plant to the site, join BatchTicket, then
  // reach each Trip through Trip_batchTicketId_key and apply status and
  // the date window as a filter. That is a better plan than the one the
  // assertion was asking for, so the assertion was the thing at fault.
  //
  // What is still worth defending is that Trip itself is never read
  // end to end. The composite index earns its place on the UNSCOPED
  // variant — reportQueries.ts:300 passes no scope at all, and
  // tripPlantScopeWhere returns {} for an ADMIN who has picked no site —
  // which the case above covers.
  const plan = await planFor(
    `SELECT t.id FROM "Trip" t
     JOIN "BatchTicket" bt ON bt.id = t."batchTicketId"
     JOIN "Plant" p ON p.id = bt."plantId"
     WHERE t.status = 'CLOSED' AND t."dischargeEnd" >= $1::timestamp AND t."dischargeEnd" <= $2::timestamp
       AND p."siteId" = $3`,
    [WINDOW_FROM, WINDOW_TO, siteIds[0]],
  );
  assert.ok(
    !/Seq Scan on "Trip"/.test(plan),
    `the site-scoped report reads the whole Trip table.

Plan:
${plan}`,
  );
});

test("the driver's own trip list uses Trip(driverId, status)", async () => {
  // src/app/driver/page.tsx:31 and :36.
  await assertUsesIndex(
    "driver trips",
    "Trip_driverId_status_idx",
    `SELECT id FROM "Trip" WHERE "driverId" = $1 AND status = 'CLOSED' ORDER BY "batchTime" DESC LIMIT 20`,
    [driverIds[0]],
  );
});

after(async () => {
  await prisma.trip.deleteMany({ where: { id: { startsWith: `${PREFIX}-TP-` } } });
  await prisma.batchTicket.deleteMany({ where: { id: { startsWith: `${PREFIX}-BT-` } } });
  await prisma.cashTransaction.deleteMany({ where: { id: { startsWith: `${PREFIX}-CT-` } } });
  await prisma.truck.deleteMany({ where: { code: { startsWith: PREFIX } } });
  await prisma.employee.deleteMany({ where: { name: { startsWith: PREFIX } } });
  await prisma.reservation.deleteMany({ where: { reservationNumber: { startsWith: PREFIX } } });
  await prisma.project.deleteMany({ where: { name: { startsWith: PREFIX } } });
  await prisma.customer.deleteMany({ where: { legalName: { startsWith: PREFIX } } });
  await prisma.mixDesign.deleteMany({ where: { code: { startsWith: PREFIX } } });
  await prisma.user.deleteMany({ where: { email: { startsWith: PREFIX } } });
  await prisma.plant.deleteMany({ where: { name: { startsWith: PREFIX } } });
  await prisma.site.deleteMany({ where: { code: { startsWith: PREFIX } } });

  // CI runs this whole suite twice against the same database to prove
  // teardown leaves nothing behind; 20k stray rows would make the second
  // run's planner tests measure the first run's fixtures.
  assert.equal(await prisma.trip.count({ where: { id: { startsWith: PREFIX } } }), 0);
  assert.equal(await prisma.batchTicket.count({ where: { id: { startsWith: PREFIX } } }), 0);
  assert.equal(await prisma.cashTransaction.count({ where: { id: { startsWith: PREFIX } } }), 0);
  assert.equal(await prisma.site.count({ where: { code: { startsWith: PREFIX } } }), 0);

  // Leave the statistics describing the table as it now is, not as it was
  // with this suite's 20k rows in it — a later suite's plans should not
  // inherit our fixture's row estimates.
  await prisma.$executeRawUnsafe(`ANALYZE "CashTransaction", "BatchTicket", "Trip"`);
  await prisma.$disconnect();
});
