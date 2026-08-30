import Link from "next/link";
import { prisma } from "@/lib/prisma";
import { ui } from "@/lib/ui";
import { requirePageAccess } from "@/lib/session";
import { getDictionary } from "@/lib/i18n";
import { flagMaintenanceDue } from "@/lib/maintenance";
import { isAtYard } from "@/lib/geo";
import { FleetMap } from "@/components/FleetMapLoader";
import {
  createPump,
  updatePump,
  markPumpServiced,
  schedulePump,
  updateAssignmentStatus,
  createTruck,
  updateTruck,
  markTruckServiced,
  createSupportVehicle,
  updateSupportVehicle,
} from "./actions";
import { getActiveSiteId, plantScopeWhere, reservationSiteScopeWhere } from "@/lib/siteScope";

const TAB_KEYS = ["pumps", "mixers", "bulkers", "water", "loaders"] as const;
type TabKey = (typeof TAB_KEYS)[number];
type SitesForPicker = { id: string; code: string; name: string }[];

const SUPPORT_TYPE: Partial<Record<TabKey, string>> = {
  bulkers: "BULKER",
  water: "WATER_TANKER",
  loaders: "LOADER",
};
// The Employee.role a support vehicle's default-driver picker offers —
// same three roles Material Receiving and Employees already use.
const SUPPORT_DRIVER_ROLE: Partial<Record<TabKey, string>> = {
  bulkers: "BULKER_DRIVER",
  water: "WATER_TANKER_DRIVER",
  loaders: "LOADER_DRIVER",
};

const statusChip: Record<string, string> = {
  ACTIVE: "bg-good-soft text-good",
  IDLE: "bg-surface-alt text-ink-muted",
  MAINTENANCE: "bg-warn-soft text-warn",
  OUT_OF_SERVICE: "bg-critical-soft text-critical",
};
const bookingStatusChip: Record<string, string> = {
  SCHEDULED: "bg-info-soft text-ink",
  ON_SITE: "bg-accent-soft text-accent-strong",
  COMPLETE: "bg-good-soft text-good",
  CANCELLED: "bg-critical-soft text-critical",
};

// Pure and outside the component body on purpose — same shape as the
// Employees module's own expiryFlag (license expiry), applied here to the
// two real deadlines (periodic inspection, operating card) rather than
// licenseValidFrom, which is purely informational.
function expiryFlag(date: Date | null, nowMs: number, labels: { expired: string; daysLeft: (n: number) => string }) {
  if (!date) return null;
  const days = Math.ceil((date.getTime() - nowMs) / (1000 * 60 * 60 * 24));
  if (days < 0) return { label: labels.expired, cls: "bg-critical-soft text-critical" };
  if (days <= 30) return { label: labels.daysLeft(days), cls: "bg-warn-soft text-warn" };
  return null;
}

export default async function EquipmentPage({
  searchParams,
}: {
  searchParams: Promise<{ tab?: string; edit?: string }>;
}) {
  const user = await requirePageAccess("equipment");
  const { dict } = await getDictionary();
  const m = dict.modules.equipment;
  const { tab: tabRaw, edit: editId } = await searchParams;
  const tab: TabKey = (TAB_KEYS as readonly string[]).includes(tabRaw ?? "") ? (tabRaw as TabKey) : "pumps";
  const siteId = await getActiveSiteId(user);

  // Registered by Plant code only — no specific Station is chosen here (see
  // createTruck/createPump/createSupportVehicle in actions.ts); a truck or
  // pump moves between a plant's own lines as work demands.
  const sitesForPicker = await prisma.site.findMany({
    where: { ...(siteId ? { id: siteId } : {}), plants: { some: {} } },
    orderBy: { code: "asc" },
    select: { id: true, code: true, name: true },
  });

  const tabs: { key: TabKey; label: string }[] = [
    { key: "pumps", label: m.tabs.pumps },
    { key: "mixers", label: m.tabs.mixers },
    { key: "bulkers", label: m.tabs.bulkers },
    { key: "water", label: m.tabs.water },
    { key: "loaders", label: m.tabs.loaders },
  ];

  const statusOptions: readonly string[] = ["ACTIVE", "IDLE", "MAINTENANCE", "OUT_OF_SERVICE"];

  return (
    <div className="flex flex-col gap-8">
      <header>
        <div className={ui.eyebrow}>{m.eyebrow}</div>
        <h1 className={ui.h1}>{m.title}</h1>
        <p className={ui.intro}>{m.intro}</p>
      </header>

      <div className="flex flex-wrap gap-1 border-b border-border">
        {tabs.map((t) => (
          <Link
            key={t.key}
            href={`/equipment?tab=${t.key}`}
            className={`rounded-t-md px-3 py-2 text-sm ${
              tab === t.key ? "border-b-2 border-accent font-medium text-ink" : "text-ink-muted hover:text-ink"
            }`}
          >
            {t.label}
          </Link>
        ))}
      </div>

      {tab === "mixers" && (
        <MixersTab m={m} dict={dict} sitesForPicker={sitesForPicker} editId={editId} statusOptions={statusOptions} siteId={siteId} />
      )}
      {tab === "pumps" && (
        <PumpsTab m={m} dict={dict} sitesForPicker={sitesForPicker} editId={editId} statusOptions={statusOptions} siteId={siteId} />
      )}
      {(tab === "bulkers" || tab === "water" || tab === "loaders") && (
        <SupportVehicleTab m={m} dict={dict} sitesForPicker={sitesForPicker} editId={editId} statusOptions={statusOptions} tab={tab} siteId={siteId} />
      )}
    </div>
  );
}

async function MixersTab({
  m,
  dict,
  sitesForPicker,
  editId,
  statusOptions,
  siteId,
}: {
  m: Awaited<ReturnType<typeof getDictionary>>["dict"]["modules"]["equipment"];
  dict: Awaited<ReturnType<typeof getDictionary>>["dict"];
  sitesForPicker: SitesForPicker;
  editId?: string;
  statusOptions: readonly string[];
  siteId: string | null;
}) {
  const [trucksRaw, drivers] = await Promise.all([
    prisma.truck.findMany({
      where: { ...plantScopeWhere(siteId) },
      orderBy: { createdAt: "asc" },
      include: { plant: { include: { site: true } }, defaultDriver: true, trips: { select: { status: true, batchTime: true } } },
    }),
    prisma.employee.findMany({ where: { role: "DRIVER", status: "ACTIVE", ...plantScopeWhere(siteId) }, orderBy: { name: "asc" }, include: { plant: { include: { site: true } } } }),
  ]);

  const trucks = trucksRaw.map((t) => {
    const [maintenance] = flagMaintenanceDue(
      [{ id: t.id, lastMaintenanceAt: t.lastMaintenanceAt, tripBatchTimes: t.trips.map((trip) => trip.batchTime) }],
      t.plant.maintenanceIntervalTrips,
    );
    const atYard = t.lastLat != null && t.lastLng != null && isAtYard(t.plant, t.lastLat, t.lastLng);
    return { ...t, openTripsCount: t.trips.filter((trip) => trip.status !== "CLOSED").length, maintenance, atYard };
  });

  // eslint-disable-next-line react-hooks/purity
  const nowMs = Date.now();

  const mapTrucks = trucks
    .filter((t) => t.lastLat != null && t.lastLng != null)
    .map((t) => ({
      id: t.id,
      code: t.code,
      lastLat: t.lastLat!,
      lastLng: t.lastLng!,
      lastPingAt: t.lastPingAt ? t.lastPingAt.toISOString() : null,
      driverName: t.defaultDriver?.name ?? null,
      status: t.status,
    }));

  return (
    <div className="flex flex-col gap-6">
      {mapTrucks.length > 0 && (
        <FleetMap trucks={mapTrucks} neverPingedLabel={m.mixers.noPing} lastPingLabel={(when) => `${m.mixers.lastPing} ${when}`} />
      )}
      <div className="grid grid-cols-[1fr_320px] gap-6">
      <div className={ui.card}>
        <table className={ui.table}>
          <thead>
            <tr>
              <th className={ui.th}>{m.mixers.col.truck}</th>
              <th className={ui.th}>{m.shared.plant}</th>
              <th className={ui.th}>{m.mixers.col.drumCapacity}</th>
              <th className={ui.th}>{m.mixers.col.defaultDriver}</th>
              <th className={ui.th}>{m.shared.plateNumber}</th>
              <th className={ui.th}>{m.mixers.col.maintenance}</th>
              <th className={ui.th}>{m.shared.periodicInspectionDueAt}</th>
              <th className={ui.th}>{m.shared.operatingCardExpiry}</th>
              <th className={ui.th}>{m.shared.insurancePolicyExpiry}</th>
              <th className={ui.th}>{m.shared.status}</th>
              <th className={ui.th}>{m.shared.actions}</th>
            </tr>
          </thead>
          <tbody>
            {trucks.map((t) =>
              editId === t.id ? (
                <tr key={t.id}>
                  <td className={ui.td} colSpan={11}>
                    <form action={updateTruck} className="flex flex-wrap items-end gap-2">
                      <input type="hidden" name="id" value={t.id} />
                      <div>
                        <label className={ui.label}>{dict.field.siteCode}</label>
                        <select name="siteId" defaultValue={t.plant.siteId} required className={`${ui.select} w-36`}>
                          {sitesForPicker.map((s) => (
                            <option key={s.id} value={s.id}>{s.code} — {s.name}</option>
                          ))}
                        </select>
                      </div>
                      <div>
                        <label className={ui.label}>{m.shared.code}</label>
                        <input name="code" defaultValue={t.code} required className={`${ui.input} w-24`} dir="ltr" />
                      </div>
                      <div>
                        <label className={ui.label}>{m.mixers.f.drumCapacity}</label>
                        <input name="drumCapacityM3" type="number" step="0.5" defaultValue={t.drumCapacityM3} required className={`${ui.input} w-24`} />
                      </div>
                      <div>
                        <label className={ui.label}>{m.mixers.f.maxRpm}</label>
                        <input name="maxAgitationRpm" type="number" step="0.5" defaultValue={t.maxAgitationRpm ?? undefined} className={`${ui.input} w-24`} />
                      </div>
                      <div>
                        <label className={ui.label}>{m.mixers.f.gpsDevice}</label>
                        <input name="gpsDeviceId" defaultValue={t.gpsDeviceId ?? ""} className={`${ui.input} w-28`} dir="ltr" />
                      </div>
                      <div>
                        <label className={ui.label}>{m.shared.year}</label>
                        <input name="year" type="number" defaultValue={t.year ?? undefined} className={`${ui.input} w-20`} />
                      </div>
                      <div>
                        <label className={ui.label}>{m.shared.chassisNumber}</label>
                        <input name="chassisNumber" defaultValue={t.chassisNumber ?? ""} className={`${ui.input} w-32`} dir="ltr" />
                      </div>
                      <div>
                        <label className={ui.label}>{m.shared.plateNumber}</label>
                        <input name="plateNumber" defaultValue={t.plateNumber ?? ""} className={`${ui.input} w-28`} dir="ltr" />
                      </div>
                      <div>
                        <label className={ui.label}>{m.shared.licenseValidFrom}</label>
                        <input
                          name="licenseValidFrom"
                          type="date"
                          defaultValue={t.licenseValidFrom ? new Date(t.licenseValidFrom).toISOString().slice(0, 10) : ""}
                          className={`${ui.input} w-40`}
                        />
                      </div>
                      <div>
                        <label className={ui.label}>{m.shared.periodicInspectionDueAt}</label>
                        <input
                          name="periodicInspectionDueAt"
                          type="date"
                          defaultValue={t.periodicInspectionDueAt ? new Date(t.periodicInspectionDueAt).toISOString().slice(0, 10) : ""}
                          className={`${ui.input} w-40`}
                        />
                      </div>
                      <div>
                        <label className={ui.label}>{m.shared.operatingCardExpiry}</label>
                        <input
                          name="operatingCardExpiry"
                          type="date"
                          defaultValue={t.operatingCardExpiry ? new Date(t.operatingCardExpiry).toISOString().slice(0, 10) : ""}
                          className={`${ui.input} w-40`}
                        />
                      </div>
                      <div>
                        <label className={ui.label}>{m.shared.insurancePolicyExpiry}</label>
                        <input
                          name="insurancePolicyExpiry"
                          type="date"
                          defaultValue={t.insurancePolicyExpiry ? new Date(t.insurancePolicyExpiry).toISOString().slice(0, 10) : ""}
                          className={`${ui.input} w-40`}
                        />
                      </div>
                      <div>
                        <label className={ui.label}>{m.mixers.f.defaultDriver}</label>
                        <select name="defaultDriverId" defaultValue={t.defaultDriverId ?? ""} className={`${ui.select} w-40`}>
                          <option value="">{dict.field.none}</option>
                          {drivers.map((d) => <option key={d.id} value={d.id}>{d.name} — {d.plant.site.code} — {d.plant.site.name}</option>)}
                        </select>
                      </div>
                      <div>
                        <label className={ui.label}>{m.shared.status}</label>
                        <select name="status" defaultValue={t.status} className={`${ui.select} w-36`}>
                          {statusOptions.map((s) => <option key={s} value={s}>{dict.status[s as keyof typeof dict.status]}</option>)}
                        </select>
                      </div>
                      <button className={ui.button}>{dict.field.save}</button>
                      <Link href="/equipment?tab=mixers" className="rounded-md border border-border px-3 py-2 text-sm hover:bg-surface-alt">
                        {dict.field.cancel}
                      </Link>
                    </form>
                  </td>
                </tr>
              ) : (
                <tr key={t.id}>
                  <td className={`${ui.td} font-medium`}>
                    <span dir="ltr">{t.code}</span>
                    {t.openTripsCount > 0 && <span className={`${ui.chip} bg-accent-soft text-accent-strong ms-2`}>{m.mixers.onTrip}</span>}
                    {t.atYard && <span className={`${ui.chip} bg-good-soft text-good ms-2`}>{m.mixers.atYard}</span>}
                    <div className="text-xs text-ink-faint">{t.plant.site.code} — {t.plant.site.name}</div>
                  </td>
                  <td className={ui.td}>
                    <span className="font-mono text-xs" dir="ltr">{t.plant.site.code}</span>
                    <div className="text-xs text-ink-muted">{t.plant.site.name}</div>
                  </td>
                  <td className={`${ui.td} font-mono tabular`}>{t.drumCapacityM3} m³</td>
                  <td className={ui.td}>{t.defaultDriver?.name || "—"}</td>
                  <td className={`${ui.td} font-mono text-xs`} dir="ltr">{t.plateNumber || "—"}</td>
                  <td className={ui.td}>
                    <div className="font-mono text-xs text-ink-muted" dir="ltr">
                      {t.lastMaintenanceAt ? new Date(t.lastMaintenanceAt).toLocaleDateString() : m.neverServiced}
                    </div>
                    <div className="text-xs text-ink-faint">{m.tripsSince(t.maintenance.tripsSinceLastMaintenance)}</div>
                    {t.maintenance.dueForInspection && (
                      <span className={`${ui.chip} bg-warn-soft text-warn mt-1 inline-block`}>{m.dueForInspection}</span>
                    )}
                    <form action={markTruckServiced} className="mt-1">
                      <input type="hidden" name="id" value={t.id} />
                      <button className="text-xs font-medium text-accent-strong hover:underline">{m.markServiced}</button>
                    </form>
                  </td>
                  <td className={ui.td}>
                    {t.periodicInspectionDueAt ? new Date(t.periodicInspectionDueAt).toLocaleDateString() : "—"}
                    {(() => {
                      const flag = expiryFlag(t.periodicInspectionDueAt, nowMs, m.shared);
                      return flag && <span className={`${ui.chip} ${flag.cls} ms-2`}>{flag.label}</span>;
                    })()}
                  </td>
                  <td className={ui.td}>
                    {t.operatingCardExpiry ? new Date(t.operatingCardExpiry).toLocaleDateString() : "—"}
                    {(() => {
                      const flag = expiryFlag(t.operatingCardExpiry, nowMs, m.shared);
                      return flag && <span className={`${ui.chip} ${flag.cls} ms-2`}>{flag.label}</span>;
                    })()}
                  </td>
                  <td className={ui.td}>
                    {t.insurancePolicyExpiry ? new Date(t.insurancePolicyExpiry).toLocaleDateString() : "—"}
                    {(() => {
                      const flag = expiryFlag(t.insurancePolicyExpiry, nowMs, m.shared);
                      return flag && <span className={`${ui.chip} ${flag.cls} ms-2`}>{flag.label}</span>;
                    })()}
                  </td>
                  <td className={ui.td}>
                    <span className={`${ui.chip} ${statusChip[t.status] ?? ""}`}>{dict.status[t.status as keyof typeof dict.status] ?? t.status}</span>
                  </td>
                  <td className={ui.td}>
                    <Link href={`/equipment?tab=mixers&edit=${t.id}`} className="text-xs font-medium text-accent-strong hover:underline">
                      {dict.field.edit}
                    </Link>
                  </td>
                </tr>
              )
            )}
            {trucks.length === 0 && (
              <tr>
                <td className={ui.td} colSpan={11}><span className="text-ink-muted">{m.mixers.empty}</span></td>
              </tr>
            )}
          </tbody>
        </table>
      </div>

      <form action={createTruck} className={`${ui.card} flex flex-col gap-3`}>
        <h2 className="font-display text-lg font-semibold">{m.mixers.newTitle}</h2>
        <div>
          <label className={ui.label}>{dict.field.siteCode}</label>
          <select name="siteId" required className={ui.select}>
            <option value="">{dict.field.selectSite}</option>
            {sitesForPicker.map((s) => (
              <option key={s.id} value={s.id}>{s.code} — {s.name}</option>
            ))}
          </select>
        </div>
        <div>
          <label className={ui.label}>{m.shared.code}</label>
          <input name="code" required className={ui.input} placeholder="MX-14" dir="ltr" />
        </div>
        <div>
          <label className={ui.label}>{m.mixers.f.drumCapacity}</label>
          <input name="drumCapacityM3" type="number" step="0.5" required className={ui.input} />
        </div>
        <div>
          <label className={ui.label}>{m.mixers.f.maxRpm}</label>
          <input name="maxAgitationRpm" type="number" step="0.5" className={ui.input} />
        </div>
        <div>
          <label className={ui.label}>{m.mixers.f.gpsDevice}</label>
          <input name="gpsDeviceId" className={ui.input} placeholder="GPS-114" dir="ltr" />
        </div>
        <div>
          <label className={ui.label}>{m.shared.year}</label>
          <input name="year" type="number" className={ui.input} placeholder="2022" />
        </div>
        <div>
          <label className={ui.label}>{m.shared.chassisNumber}</label>
          <input name="chassisNumber" className={ui.input} dir="ltr" />
        </div>
        <div>
          <label className={ui.label}>{m.shared.plateNumber}</label>
          <input name="plateNumber" className={ui.input} dir="ltr" />
        </div>
        <div>
          <label className={ui.label}>{m.shared.licenseValidFrom}</label>
          <input name="licenseValidFrom" type="date" className={ui.input} />
        </div>
        <div>
          <label className={ui.label}>{m.shared.periodicInspectionDueAt}</label>
          <input name="periodicInspectionDueAt" type="date" className={ui.input} />
        </div>
        <div>
          <label className={ui.label}>{m.shared.operatingCardExpiry}</label>
          <input name="operatingCardExpiry" type="date" className={ui.input} />
        </div>
        <div>
          <label className={ui.label}>{m.shared.insurancePolicyExpiry}</label>
          <input name="insurancePolicyExpiry" type="date" className={ui.input} />
        </div>
        <div>
          <label className={ui.label}>{m.mixers.f.defaultDriver}</label>
          <select name="defaultDriverId" className={ui.select}>
            <option value="">{dict.field.none}</option>
            {drivers.map((d) => <option key={d.id} value={d.id}>{d.name} — {d.plant.site.code} — {d.plant.site.name}</option>)}
          </select>
        </div>
        <button type="submit" className={`${ui.button} mt-2`}>{m.mixers.add}</button>
      </form>
      </div>
    </div>
  );
}

async function PumpsTab({
  m,
  dict,
  sitesForPicker,
  editId,
  statusOptions,
  siteId,
}: {
  m: Awaited<ReturnType<typeof getDictionary>>["dict"]["modules"]["equipment"];
  dict: Awaited<ReturnType<typeof getDictionary>>["dict"];
  sitesForPicker: SitesForPicker;
  editId?: string;
  statusOptions: readonly string[];
  siteId: string | null;
}) {
  const [pumpsRaw, assignments, unassignedReservations, pumpCrew] = await Promise.all([
    prisma.pump.findMany({
      where: { ...plantScopeWhere(siteId) },
      orderBy: { createdAt: "asc" },
      include: { plant: { include: { site: true } }, defaultOperator: true, defaultAssistant: true, trips: { select: { batchTime: true } } },
    }),
    prisma.pumpAssignment.findMany({
      where: { ...(siteId ? { pump: { plant: { siteId } } } : {}) },
      orderBy: { scheduledStart: "asc" },
      include: { pump: true, reservation: { include: { project: { include: { customer: true } } } } },
    }),
    // Not filtered to zero-assignment reservations — a large pour can need
    // more than one pump (see the PumpAssignment schema note), so a
    // reservation that already has one scheduled can still take another.
    prisma.reservation.findMany({
      where: { deliveryMethod: "PUMP", status: { in: ["CONFIRMED", "REQUESTED"] }, ...reservationSiteScopeWhere(siteId) },
      include: { project: true },
      orderBy: { pourWindowStart: "asc" },
    }),
    prisma.pumpCrewMember.findMany({ where: { status: "ACTIVE", ...plantScopeWhere(siteId) }, orderBy: { name: "asc" }, include: { plant: { include: { site: true } } } }),
  ]);

  const pumps = pumpsRaw.map((p) => {
    const [maintenance] = flagMaintenanceDue(
      [{ id: p.id, lastMaintenanceAt: p.lastMaintenanceAt, tripBatchTimes: p.trips.map((trip) => trip.batchTime) }],
      p.plant.maintenanceIntervalTrips,
    );
    return { ...p, maintenance };
  });

  const operators = pumpCrew.filter((c) => c.role === "OPERATOR");
  const assistants = pumpCrew.filter((c) => c.role === "HELPER");
  // eslint-disable-next-line react-hooks/purity
  const nowMs = Date.now();

  return (
    <div className="flex flex-col gap-6">
      <div className="grid grid-cols-[1fr_320px] gap-6">
        <div className={ui.card}>
          <table className={ui.table}>
            <thead>
              <tr>
                <th className={ui.th}>{m.pumps.col.pump}</th>
                <th className={ui.th}>{m.shared.plant}</th>
                <th className={ui.th}>{m.pumps.col.type}</th>
                <th className={ui.th}>{m.pumps.col.defaultOperator}</th>
                <th className={ui.th}>{m.pumps.col.defaultAssistant}</th>
                <th className={ui.th}>{m.pumps.col.rate}</th>
                <th className={ui.th}>{m.pumps.col.maintenance}</th>
                <th className={ui.th}>{m.shared.periodicInspectionDueAt}</th>
                <th className={ui.th}>{m.shared.operatingCardExpiry}</th>
                <th className={ui.th}>{m.shared.insurancePolicyExpiry}</th>
                <th className={ui.th}>{m.shared.status}</th>
                <th className={ui.th}>{m.shared.actions}</th>
              </tr>
            </thead>
            <tbody>
              {pumps.map((p) =>
                editId === p.id ? (
                  <tr key={p.id}>
                    <td className={ui.td} colSpan={12}>
                      <form action={updatePump} className="flex flex-wrap items-end gap-2">
                        <input type="hidden" name="id" value={p.id} />
                        <div>
                          <label className={ui.label}>{dict.field.siteCode}</label>
                          <select name="siteId" defaultValue={p.plant.siteId} required className={`${ui.select} w-36`}>
                            {sitesForPicker.map((s) => (
                              <option key={s.id} value={s.id}>{s.code} — {s.name}</option>
                            ))}
                          </select>
                        </div>
                        <div>
                          <label className={ui.label}>{m.shared.code}</label>
                          <input name="code" defaultValue={p.code} required className={`${ui.input} w-24`} dir="ltr" />
                        </div>
                        <div>
                          <label className={ui.label}>{m.pumps.f.type}</label>
                          <select name="pumpType" defaultValue={p.pumpType} className={`${ui.select} w-32`}>
                            <option value="BOOM">{dict.pumpTypes.BOOM}</option>
                            <option value="LINE">{dict.pumpTypes.LINE}</option>
                            <option value="STATIONARY">{dict.pumpTypes.STATIONARY}</option>
                          </select>
                        </div>
                        <div>
                          <label className={ui.label}>{m.pumps.f.reach}</label>
                          <input name="reachM" type="number" step="0.5" defaultValue={p.reachM ?? undefined} className={`${ui.input} w-20`} />
                        </div>
                        <div>
                          <label className={ui.label}>{m.pumps.f.hourlyRate}</label>
                          <input name="hourlyRate" type="number" step="1" defaultValue={p.hourlyRate} required className={`${ui.input} w-24`} />
                        </div>
                        <div>
                          <label className={ui.label}>{m.pumps.f.standbyRate}</label>
                          <input name="standbyRate" type="number" step="1" defaultValue={p.standbyRate ?? undefined} className={`${ui.input} w-24`} />
                        </div>
                        <div>
                          <label className={ui.label}>{m.shared.year}</label>
                          <input name="year" type="number" defaultValue={p.year ?? undefined} className={`${ui.input} w-20`} />
                        </div>
                        <div>
                          <label className={ui.label}>{m.shared.chassisNumber}</label>
                          <input name="chassisNumber" defaultValue={p.chassisNumber ?? ""} className={`${ui.input} w-32`} dir="ltr" />
                        </div>
                        <div>
                          <label className={ui.label}>{m.shared.plateNumber}</label>
                          <input name="plateNumber" defaultValue={p.plateNumber ?? ""} className={`${ui.input} w-28`} dir="ltr" />
                        </div>
                        <div>
                          <label className={ui.label}>{m.shared.licenseValidFrom}</label>
                          <input
                            name="licenseValidFrom"
                            type="date"
                            defaultValue={p.licenseValidFrom ? new Date(p.licenseValidFrom).toISOString().slice(0, 10) : ""}
                            className={`${ui.input} w-40`}
                          />
                        </div>
                        <div>
                          <label className={ui.label}>{m.shared.periodicInspectionDueAt}</label>
                          <input
                            name="periodicInspectionDueAt"
                            type="date"
                            defaultValue={p.periodicInspectionDueAt ? new Date(p.periodicInspectionDueAt).toISOString().slice(0, 10) : ""}
                            className={`${ui.input} w-40`}
                          />
                        </div>
                        <div>
                          <label className={ui.label}>{m.shared.operatingCardExpiry}</label>
                          <input
                            name="operatingCardExpiry"
                            type="date"
                            defaultValue={p.operatingCardExpiry ? new Date(p.operatingCardExpiry).toISOString().slice(0, 10) : ""}
                            className={`${ui.input} w-40`}
                          />
                        </div>
                        <div>
                          <label className={ui.label}>{m.shared.insurancePolicyExpiry}</label>
                          <input
                            name="insurancePolicyExpiry"
                            type="date"
                            defaultValue={p.insurancePolicyExpiry ? new Date(p.insurancePolicyExpiry).toISOString().slice(0, 10) : ""}
                            className={`${ui.input} w-40`}
                          />
                        </div>
                        <div>
                          <label className={ui.label}>{m.pumps.f.defaultOperator}</label>
                          <select name="defaultOperatorId" defaultValue={p.defaultOperatorId ?? ""} className={`${ui.select} w-40`}>
                            <option value="">{dict.field.none}</option>
                            {operators.map((c) => <option key={c.id} value={c.id}>{c.name} — {c.plant.site.code} — {c.plant.site.name}</option>)}
                          </select>
                        </div>
                        <div>
                          <label className={ui.label}>{m.pumps.f.defaultAssistant}</label>
                          <select name="defaultAssistantId" defaultValue={p.defaultAssistantId ?? ""} className={`${ui.select} w-40`}>
                            <option value="">{dict.field.none}</option>
                            {assistants.map((c) => <option key={c.id} value={c.id}>{c.name} — {c.plant.site.code} — {c.plant.site.name}</option>)}
                          </select>
                        </div>
                        <div>
                          <label className={ui.label}>{m.shared.status}</label>
                          <select name="status" defaultValue={p.status} className={`${ui.select} w-36`}>
                            {statusOptions.map((s) => <option key={s} value={s}>{dict.status[s as keyof typeof dict.status]}</option>)}
                          </select>
                        </div>
                        <button className={ui.button}>{dict.field.save}</button>
                        <Link href="/equipment?tab=pumps" className="rounded-md border border-border px-3 py-2 text-sm hover:bg-surface-alt">
                          {dict.field.cancel}
                        </Link>
                      </form>
                    </td>
                  </tr>
                ) : (
                  <tr key={p.id}>
                    <td className={`${ui.td} font-medium`} dir="ltr">{p.code}</td>
                    <td className={ui.td}>
                      <span className="font-mono text-xs" dir="ltr">{p.plant.site.code}</span>
                      <div className="text-xs text-ink-muted">{p.plant.site.name}</div>
                    </td>
                    <td className={`${ui.td} font-mono text-xs`}>{dict.pumpTypes[p.pumpType as keyof typeof dict.pumpTypes] ?? p.pumpType}</td>
                    <td className={ui.td}>{p.defaultOperator?.name || "—"}</td>
                    <td className={ui.td}>{p.defaultAssistant?.name || "—"}</td>
                    <td className={`${ui.td} font-mono tabular`} dir="ltr">
                      {p.hourlyRate}{m.pumps.perHour}{p.standbyRate ? m.pumps.standbySuffix(p.standbyRate) : ""}
                    </td>
                    <td className={ui.td}>
                      <div className="font-mono text-xs text-ink-muted" dir="ltr">
                        {p.lastMaintenanceAt ? new Date(p.lastMaintenanceAt).toLocaleDateString() : m.neverServiced}
                      </div>
                      <div className="text-xs text-ink-faint">{m.tripsSince(p.maintenance.tripsSinceLastMaintenance)}</div>
                      {p.maintenance.dueForInspection && (
                        <span className={`${ui.chip} bg-warn-soft text-warn mt-1 inline-block`}>{m.dueForInspection}</span>
                      )}
                      <form action={markPumpServiced} className="mt-1">
                        <input type="hidden" name="id" value={p.id} />
                        <button className="text-xs font-medium text-accent-strong hover:underline">{m.markServiced}</button>
                      </form>
                    </td>
                    <td className={ui.td}>
                      {p.periodicInspectionDueAt ? new Date(p.periodicInspectionDueAt).toLocaleDateString() : "—"}
                      {(() => {
                        const flag = expiryFlag(p.periodicInspectionDueAt, nowMs, m.shared);
                        return flag && <span className={`${ui.chip} ${flag.cls} ms-2`}>{flag.label}</span>;
                      })()}
                    </td>
                    <td className={ui.td}>
                      {p.operatingCardExpiry ? new Date(p.operatingCardExpiry).toLocaleDateString() : "—"}
                      {(() => {
                        const flag = expiryFlag(p.operatingCardExpiry, nowMs, m.shared);
                        return flag && <span className={`${ui.chip} ${flag.cls} ms-2`}>{flag.label}</span>;
                      })()}
                    </td>
                    <td className={ui.td}>
                      {p.insurancePolicyExpiry ? new Date(p.insurancePolicyExpiry).toLocaleDateString() : "—"}
                      {(() => {
                        const flag = expiryFlag(p.insurancePolicyExpiry, nowMs, m.shared);
                        return flag && <span className={`${ui.chip} ${flag.cls} ms-2`}>{flag.label}</span>;
                      })()}
                    </td>
                    <td className={ui.td}>
                      <span className={`${ui.chip} ${statusChip[p.status] ?? ""}`}>{dict.status[p.status as keyof typeof dict.status] ?? p.status}</span>
                    </td>
                    <td className={ui.td}>
                      <Link href={`/equipment?tab=pumps&edit=${p.id}`} className="text-xs font-medium text-accent-strong hover:underline">
                        {dict.field.edit}
                      </Link>
                    </td>
                  </tr>
                )
              )}
              {pumps.length === 0 && (
                <tr><td className={ui.td} colSpan={12}><span className="text-ink-muted">{m.pumps.empty}</span></td></tr>
              )}
            </tbody>
          </table>
        </div>

        <form action={createPump} className={`${ui.card} flex flex-col gap-3`}>
          <h2 className="font-display text-lg font-semibold">{m.pumps.newTitle}</h2>
          <div>
            <label className={ui.label}>{dict.field.siteCode}</label>
            <select name="siteId" required className={ui.select}>
              <option value="">{dict.field.selectSite}</option>
              {sitesForPicker.map((s) => (
                <option key={s.id} value={s.id}>{s.code} — {s.name}</option>
              ))}
            </select>
          </div>
          <div>
            <label className={ui.label}>{m.shared.code}</label>
            <input name="code" required className={ui.input} placeholder="PMP-3" dir="ltr" />
          </div>
          <div>
            <label className={ui.label}>{m.pumps.f.type}</label>
            <select name="pumpType" className={ui.select}>
              <option value="BOOM">{dict.pumpTypes.BOOM}</option>
              <option value="LINE">{dict.pumpTypes.LINE}</option>
              <option value="STATIONARY">{dict.pumpTypes.STATIONARY}</option>
            </select>
          </div>
          <div>
            <label className={ui.label}>{m.pumps.f.reach}</label>
            <input name="reachM" type="number" step="0.5" className={ui.input} />
          </div>
          <div>
            <label className={ui.label}>{m.pumps.f.hourlyRate}</label>
            <input name="hourlyRate" type="number" step="1" required className={ui.input} />
          </div>
          <div>
            <label className={ui.label}>{m.pumps.f.standbyRate}</label>
            <input name="standbyRate" type="number" step="1" className={ui.input} />
          </div>
          <div>
            <label className={ui.label}>{m.shared.year}</label>
            <input name="year" type="number" className={ui.input} />
          </div>
          <div>
            <label className={ui.label}>{m.shared.chassisNumber}</label>
            <input name="chassisNumber" className={ui.input} dir="ltr" />
          </div>
          <div>
            <label className={ui.label}>{m.shared.plateNumber}</label>
            <input name="plateNumber" className={ui.input} dir="ltr" />
          </div>
          <div>
            <label className={ui.label}>{m.shared.licenseValidFrom}</label>
            <input name="licenseValidFrom" type="date" className={ui.input} />
          </div>
          <div>
            <label className={ui.label}>{m.shared.periodicInspectionDueAt}</label>
            <input name="periodicInspectionDueAt" type="date" className={ui.input} />
          </div>
          <div>
            <label className={ui.label}>{m.shared.operatingCardExpiry}</label>
            <input name="operatingCardExpiry" type="date" className={ui.input} />
          </div>
          <div>
            <label className={ui.label}>{m.shared.insurancePolicyExpiry}</label>
            <input name="insurancePolicyExpiry" type="date" className={ui.input} />
          </div>
          <div>
            <label className={ui.label}>{m.pumps.f.defaultOperator}</label>
            <select name="defaultOperatorId" className={ui.select}>
              <option value="">{dict.field.none}</option>
              {operators.map((c) => <option key={c.id} value={c.id}>{c.name} — {c.plant.site.code} — {c.plant.site.name}</option>)}
            </select>
          </div>
          <div>
            <label className={ui.label}>{m.pumps.f.defaultAssistant}</label>
            <select name="defaultAssistantId" className={ui.select}>
              <option value="">{dict.field.none}</option>
              {assistants.map((c) => <option key={c.id} value={c.id}>{c.name} — {c.plant.site.code} — {c.plant.site.name}</option>)}
            </select>
          </div>
          <button type="submit" className={`${ui.button} mt-2`}>{m.pumps.add}</button>
        </form>
      </div>

      <div className="grid grid-cols-[1fr_320px] gap-6">
        <div className={ui.card}>
          <h2 className="mb-3 font-display text-lg font-semibold">{m.pumps.calendarTitle}</h2>
          <table className={ui.table}>
            <thead>
              <tr>
                <th className={ui.th}>{m.pumps.colBooking.scheduled}</th>
                <th className={ui.th}>{m.pumps.colBooking.pump}</th>
                <th className={ui.th}>{m.pumps.colBooking.project}</th>
                <th className={ui.th}>{m.pumps.colBooking.status}</th>
                <th className={ui.th}></th>
              </tr>
            </thead>
            <tbody>
              {assignments.map((a) => (
                <tr key={a.id}>
                  <td className={`${ui.td} font-mono text-xs tabular`}>{new Date(a.scheduledStart).toLocaleString()}</td>
                  <td className={`${ui.td} font-medium`} dir="ltr">{a.pump.code}</td>
                  <td className={ui.td}>
                    {a.reservation.project.name}
                    <div className="text-xs text-ink-muted">{a.reservation.project.customer.legalName}</div>
                  </td>
                  <td className={ui.td}>
                    <span className={`${ui.chip} ${bookingStatusChip[a.status] ?? ""}`}>{dict.status[a.status as keyof typeof dict.status] ?? a.status}</span>
                  </td>
                  <td className={ui.td}>
                    {a.status !== "COMPLETE" && a.status !== "CANCELLED" && (
                      <form action={updateAssignmentStatus} className="flex items-center gap-1">
                        <input type="hidden" name="id" value={a.id} />
                        <select name="status" defaultValue={a.status} className="rounded-md border border-border bg-surface px-2 py-1 text-xs">
                          <option value="SCHEDULED">{dict.status.SCHEDULED}</option>
                          <option value="ON_SITE">{dict.status.ON_SITE}</option>
                          <option value="COMPLETE">{dict.status.COMPLETE}</option>
                          <option value="CANCELLED">{dict.status.CANCELLED}</option>
                        </select>
                        <input
                          name="billedHours"
                          type="number"
                          step="0.5"
                          placeholder="hrs"
                          defaultValue={a.billedHours ?? undefined}
                          className="w-16 rounded-md border border-border bg-surface px-2 py-1 text-xs"
                        />
                        <button className="rounded-md border border-border px-2 py-1 text-xs hover:bg-surface-alt">{dict.field.save}</button>
                      </form>
                    )}
                    {a.status === "COMPLETE" && a.billedHours && (
                      <span className="font-mono text-xs text-ink-muted">{m.pumps.billed(a.billedHours)}</span>
                    )}
                  </td>
                </tr>
              ))}
              {assignments.length === 0 && (
                <tr><td className={ui.td} colSpan={5}><span className="text-ink-muted">{m.pumps.emptyBookings}</span></td></tr>
              )}
            </tbody>
          </table>
        </div>

        <form action={schedulePump} className={`${ui.card} flex flex-col gap-3`}>
          <h2 className="font-display text-lg font-semibold">{m.pumps.scheduleTitle}</h2>
          <div>
            <label className={ui.label}>{m.pumps.fSchedule.pump}</label>
            <select name="pumpId" required className={ui.select}>
              <option value="">{dict.field.selectPump}</option>
              {pumps.filter((p) => p.status === "ACTIVE").map((p) => (
                <option key={p.id} value={p.id}>{p.code} ({dict.pumpTypes[p.pumpType as keyof typeof dict.pumpTypes] ?? p.pumpType})</option>
              ))}
            </select>
          </div>
          <div>
            <label className={ui.label}>{m.pumps.fSchedule.reservation}</label>
            <select name="reservationId" required className={ui.select}>
              <option value="">{dict.field.selectReservation}</option>
              {unassignedReservations.map((r) => (
                <option key={r.id} value={r.id}>{r.project.name} — {r.requestedVolumeM3} m³</option>
              ))}
            </select>
            {unassignedReservations.length === 0 && <p className="mt-1 text-xs text-ink-muted">{m.pumps.noReservationsNeedPump}</p>}
          </div>
          <div>
            <label className={ui.label}>{m.pumps.fSchedule.scheduledStart}</label>
            <input name="scheduledStart" type="datetime-local" required className={ui.input} />
          </div>
          <button type="submit" className={`${ui.button} mt-2`}>{m.pumps.book}</button>
        </form>
      </div>
    </div>
  );
}

async function SupportVehicleTab({
  m,
  dict,
  sitesForPicker,
  editId,
  statusOptions,
  tab,
  siteId,
}: {
  m: Awaited<ReturnType<typeof getDictionary>>["dict"]["modules"]["equipment"];
  dict: Awaited<ReturnType<typeof getDictionary>>["dict"];
  sitesForPicker: SitesForPicker;
  editId?: string;
  statusOptions: readonly string[];
  tab: TabKey;
  siteId: string | null;
}) {
  const type = SUPPORT_TYPE[tab]!;
  const driverRole = SUPPORT_DRIVER_ROLE[tab]!;

  const [vehicles, drivers] = await Promise.all([
    prisma.supportVehicle.findMany({
      where: { type, ...plantScopeWhere(siteId) },
      orderBy: { createdAt: "asc" },
      include: { plant: { include: { site: true } }, defaultDriver: true },
    }),
    prisma.employee.findMany({ where: { role: driverRole, status: "ACTIVE", ...plantScopeWhere(siteId) }, orderBy: { name: "asc" }, include: { plant: { include: { site: true } } } }),
  ]);
  // eslint-disable-next-line react-hooks/purity
  const nowMs = Date.now();

  return (
    <div className="grid grid-cols-[1fr_320px] gap-6">
      <div className={ui.card}>
        <table className={ui.table}>
          <thead>
            <tr>
              <th className={ui.th}>{m.supportVehicle.col.code}</th>
              <th className={ui.th}>{m.shared.plant}</th>
              <th className={ui.th}>{m.shared.year}</th>
              <th className={ui.th}>{m.shared.chassisNumber}</th>
              <th className={ui.th}>{m.shared.plateNumber}</th>
              <th className={ui.th}>{m.shared.periodicInspectionDueAt}</th>
              <th className={ui.th}>{m.shared.operatingCardExpiry}</th>
              <th className={ui.th}>{m.shared.insurancePolicyExpiry}</th>
              <th className={ui.th}>{m.supportVehicle.col.defaultDriver}</th>
              <th className={ui.th}>{m.shared.status}</th>
              <th className={ui.th}>{m.shared.actions}</th>
            </tr>
          </thead>
          <tbody>
            {vehicles.map((v) =>
              editId === v.id ? (
                <tr key={v.id}>
                  <td className={ui.td} colSpan={11}>
                    <form action={updateSupportVehicle} className="flex flex-wrap items-end gap-2">
                      <input type="hidden" name="id" value={v.id} />
                      <div>
                        <label className={ui.label}>{dict.field.siteCode}</label>
                        <select name="siteId" defaultValue={v.plant.siteId} required className={`${ui.select} w-36`}>
                          {sitesForPicker.map((s) => (
                            <option key={s.id} value={s.id}>{s.code} — {s.name}</option>
                          ))}
                        </select>
                      </div>
                      <div>
                        <label className={ui.label}>{m.shared.code}</label>
                        <input name="code" defaultValue={v.code} required className={`${ui.input} w-28`} dir="ltr" />
                      </div>
                      <div>
                        <label className={ui.label}>{m.shared.year}</label>
                        <input name="year" type="number" defaultValue={v.year ?? undefined} className={`${ui.input} w-20`} />
                      </div>
                      <div>
                        <label className={ui.label}>{m.shared.chassisNumber}</label>
                        <input name="chassisNumber" defaultValue={v.chassisNumber ?? ""} className={`${ui.input} w-32`} dir="ltr" />
                      </div>
                      <div>
                        <label className={ui.label}>{m.shared.plateNumber}</label>
                        <input name="plateNumber" defaultValue={v.plateNumber ?? ""} className={`${ui.input} w-28`} dir="ltr" />
                      </div>
                      <div>
                        <label className={ui.label}>{m.shared.licenseValidFrom}</label>
                        <input
                          name="licenseValidFrom"
                          type="date"
                          defaultValue={v.licenseValidFrom ? new Date(v.licenseValidFrom).toISOString().slice(0, 10) : ""}
                          className={`${ui.input} w-40`}
                        />
                      </div>
                      <div>
                        <label className={ui.label}>{m.shared.periodicInspectionDueAt}</label>
                        <input
                          name="periodicInspectionDueAt"
                          type="date"
                          defaultValue={v.periodicInspectionDueAt ? new Date(v.periodicInspectionDueAt).toISOString().slice(0, 10) : ""}
                          className={`${ui.input} w-40`}
                        />
                      </div>
                      <div>
                        <label className={ui.label}>{m.shared.operatingCardExpiry}</label>
                        <input
                          name="operatingCardExpiry"
                          type="date"
                          defaultValue={v.operatingCardExpiry ? new Date(v.operatingCardExpiry).toISOString().slice(0, 10) : ""}
                          className={`${ui.input} w-40`}
                        />
                      </div>
                      <div>
                        <label className={ui.label}>{m.shared.insurancePolicyExpiry}</label>
                        <input
                          name="insurancePolicyExpiry"
                          type="date"
                          defaultValue={v.insurancePolicyExpiry ? new Date(v.insurancePolicyExpiry).toISOString().slice(0, 10) : ""}
                          className={`${ui.input} w-40`}
                        />
                      </div>
                      <div>
                        <label className={ui.label}>{m.supportVehicle.f.defaultDriver}</label>
                        <select name="defaultDriverId" defaultValue={v.defaultDriverId ?? ""} className={`${ui.select} w-40`}>
                          <option value="">{dict.field.none}</option>
                          {drivers.map((d) => <option key={d.id} value={d.id}>{d.name} — {d.plant.site.code} — {d.plant.site.name}</option>)}
                        </select>
                      </div>
                      <div>
                        <label className={ui.label}>{m.shared.status}</label>
                        <select name="status" defaultValue={v.status} className={`${ui.select} w-36`}>
                          {statusOptions.map((s) => <option key={s} value={s}>{dict.status[s as keyof typeof dict.status]}</option>)}
                        </select>
                      </div>
                      <button className={ui.button}>{dict.field.save}</button>
                      <Link href={`/equipment?tab=${tab}`} className="rounded-md border border-border px-3 py-2 text-sm hover:bg-surface-alt">
                        {dict.field.cancel}
                      </Link>
                    </form>
                  </td>
                </tr>
              ) : (
                <tr key={v.id}>
                  <td className={`${ui.td} font-medium`} dir="ltr">{v.code}</td>
                  <td className={ui.td}>
                    <span className="font-mono text-xs" dir="ltr">{v.plant.site.code}</span>
                    <div className="text-xs text-ink-muted">{v.plant.site.name}</div>
                  </td>
                  <td className={`${ui.td} font-mono tabular`}>{v.year ?? "—"}</td>
                  <td className={`${ui.td} font-mono text-xs`} dir="ltr">{v.chassisNumber || "—"}</td>
                  <td className={`${ui.td} font-mono text-xs`} dir="ltr">{v.plateNumber || "—"}</td>
                  <td className={ui.td}>
                    {v.periodicInspectionDueAt ? new Date(v.periodicInspectionDueAt).toLocaleDateString() : "—"}
                    {(() => {
                      const flag = expiryFlag(v.periodicInspectionDueAt, nowMs, m.shared);
                      return flag && <span className={`${ui.chip} ${flag.cls} ms-2`}>{flag.label}</span>;
                    })()}
                  </td>
                  <td className={ui.td}>
                    {v.operatingCardExpiry ? new Date(v.operatingCardExpiry).toLocaleDateString() : "—"}
                    {(() => {
                      const flag = expiryFlag(v.operatingCardExpiry, nowMs, m.shared);
                      return flag && <span className={`${ui.chip} ${flag.cls} ms-2`}>{flag.label}</span>;
                    })()}
                  </td>
                  <td className={ui.td}>
                    {v.insurancePolicyExpiry ? new Date(v.insurancePolicyExpiry).toLocaleDateString() : "—"}
                    {(() => {
                      const flag = expiryFlag(v.insurancePolicyExpiry, nowMs, m.shared);
                      return flag && <span className={`${ui.chip} ${flag.cls} ms-2`}>{flag.label}</span>;
                    })()}
                  </td>
                  <td className={ui.td}>{v.defaultDriver?.name || "—"}</td>
                  <td className={ui.td}>
                    <span className={`${ui.chip} ${statusChip[v.status] ?? ""}`}>{dict.status[v.status as keyof typeof dict.status] ?? v.status}</span>
                  </td>
                  <td className={ui.td}>
                    <Link href={`/equipment?tab=${tab}&edit=${v.id}`} className="text-xs font-medium text-accent-strong hover:underline">
                      {dict.field.edit}
                    </Link>
                  </td>
                </tr>
              )
            )}
            {vehicles.length === 0 && (
              <tr><td className={ui.td} colSpan={11}><span className="text-ink-muted">{m.supportVehicle.empty}</span></td></tr>
            )}
          </tbody>
        </table>
      </div>

      <form action={createSupportVehicle} className={`${ui.card} flex flex-col gap-3`}>
        <h2 className="font-display text-lg font-semibold">{m.supportVehicle.newTitle}</h2>
        <input type="hidden" name="type" value={type} />
        <div>
          <label className={ui.label}>{dict.field.siteCode}</label>
          <select name="siteId" required className={ui.select}>
            <option value="">{dict.field.selectSite}</option>
            {sitesForPicker.map((s) => (
              <option key={s.id} value={s.id}>{s.code} — {s.name}</option>
            ))}
          </select>
        </div>
        <div>
          <label className={ui.label}>{m.shared.code}</label>
          <input name="code" required className={ui.input} dir="ltr" />
        </div>
        <div>
          <label className={ui.label}>{m.shared.year}</label>
          <input name="year" type="number" className={ui.input} />
        </div>
        <div>
          <label className={ui.label}>{m.shared.chassisNumber}</label>
          <input name="chassisNumber" className={ui.input} dir="ltr" />
        </div>
        <div>
          <label className={ui.label}>{m.shared.plateNumber}</label>
          <input name="plateNumber" className={ui.input} dir="ltr" />
        </div>
        <div>
          <label className={ui.label}>{m.shared.licenseValidFrom}</label>
          <input name="licenseValidFrom" type="date" className={ui.input} />
        </div>
        <div>
          <label className={ui.label}>{m.shared.periodicInspectionDueAt}</label>
          <input name="periodicInspectionDueAt" type="date" className={ui.input} />
        </div>
        <div>
          <label className={ui.label}>{m.shared.operatingCardExpiry}</label>
          <input name="operatingCardExpiry" type="date" className={ui.input} />
        </div>
        <div>
          <label className={ui.label}>{m.shared.insurancePolicyExpiry}</label>
          <input name="insurancePolicyExpiry" type="date" className={ui.input} />
        </div>
        <div>
          <label className={ui.label}>{m.supportVehicle.f.defaultDriver}</label>
          <select name="defaultDriverId" className={ui.select}>
            <option value="">{dict.field.none}</option>
            {drivers.map((d) => <option key={d.id} value={d.id}>{d.name} — {d.plant.site.code} — {d.plant.site.name}</option>)}
          </select>
        </div>
        <button type="submit" className={`${ui.button} mt-2`}>{m.supportVehicle.add}</button>
      </form>
    </div>
  );
}
