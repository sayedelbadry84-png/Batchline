import { prisma } from "@/lib/prisma";
import { ui } from "@/lib/ui";
import { requirePageAccess } from "@/lib/session";
import { createTruck, setTruckStatus } from "./actions";

const statusChip: Record<string, string> = {
  ACTIVE: "bg-good-soft text-good",
  MAINTENANCE: "bg-warn-soft text-warn",
  OUT_OF_SERVICE: "bg-critical-soft text-critical",
};

export default async function FleetPage() {
  await requirePageAccess("fleet");

  const [trucks, drivers, plants] = await Promise.all([
    prisma.truck.findMany({
      orderBy: { createdAt: "asc" },
      include: { plant: true, trips: { where: { status: { not: "CLOSED" } } } },
    }),
    prisma.employee.findMany({ where: { role: "DRIVER" }, orderBy: { name: "asc" }, include: { plant: true } }),
    prisma.plant.findMany({ orderBy: { name: "asc" } }),
  ]);

  return (
    <div className="flex flex-col gap-8">
      <header>
        <div className={ui.eyebrow}>Module 05 — Fleet</div>
        <h1 className={ui.h1}>Mixer trucks &amp; drivers</h1>
        <p className={ui.intro}>
          Vehicle registry with drum capacity and agitation spec. Trucks
          currently on an open trip can&apos;t be double-booked from
          Production.
        </p>
      </header>

      <div className="grid grid-cols-[1fr_320px] gap-6">
        <div className={ui.card}>
          <table className={ui.table}>
            <thead>
              <tr>
                <th className={ui.th}>Truck</th>
                <th className={ui.th}>Plant</th>
                <th className={ui.th}>Drum capacity</th>
                <th className={ui.th}>Max RPM</th>
                <th className={ui.th}>GPS device</th>
                <th className={ui.th}>Last position</th>
                <th className={ui.th}>Status</th>
              </tr>
            </thead>
            <tbody>
              {trucks.map((t) => (
                <tr key={t.id}>
                  <td className={`${ui.td} font-medium`}>
                    {t.code}
                    {t.trips.length > 0 && (
                      <span className={`${ui.chip} bg-accent-soft text-accent-strong ms-2`}>on trip</span>
                    )}
                  </td>
                  <td className={ui.td}>{t.plant.name}</td>
                  <td className={`${ui.td} font-mono tabular`}>{t.drumCapacityM3} m³</td>
                  <td className={`${ui.td} font-mono tabular`}>{t.maxAgitationRpm ?? "—"}</td>
                  <td className={`${ui.td} font-mono text-xs`}>{t.gpsDeviceId || "—"}</td>
                  <td className={`${ui.td} font-mono text-xs`}>
                    {t.lastLat != null && t.lastLng != null ? (
                      <>
                        {t.lastLat.toFixed(4)}, {t.lastLng.toFixed(4)}
                        <div className="text-ink-faint">{t.lastPingAt ? new Date(t.lastPingAt).toLocaleTimeString() : ""}</div>
                      </>
                    ) : (
                      <span className="text-ink-faint">no ping yet</span>
                    )}
                  </td>
                  <td className={ui.td}>
                    <form action={setTruckStatus} className="flex items-center gap-2">
                      <input type="hidden" name="id" value={t.id} />
                      <select
                        name="status"
                        defaultValue={t.status}
                        className={`${ui.chip} ${statusChip[t.status] ?? ""} border-0`}
                      >
                        <option value="ACTIVE">ACTIVE</option>
                        <option value="MAINTENANCE">MAINTENANCE</option>
                        <option value="OUT_OF_SERVICE">OUT_OF_SERVICE</option>
                      </select>
                      <button className="rounded-md border border-border px-2 py-0.5 text-xs hover:bg-surface-alt">
                        Save
                      </button>
                    </form>
                  </td>
                </tr>
              ))}
              {trucks.length === 0 && (
                <tr>
                  <td className={ui.td} colSpan={7}>
                    <span className="text-ink-muted">No trucks yet.</span>
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>

        <form action={createTruck} className={`${ui.card} flex flex-col gap-3`}>
          <h2 className="font-display text-lg font-semibold">New truck</h2>
          <div>
            <label className={ui.label}>Plant</label>
            <select name="plantId" required className={ui.select}>
              <option value="">Select plant…</option>
              {plants.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.name}
                </option>
              ))}
            </select>
          </div>
          <div>
            <label className={ui.label}>Code</label>
            <input name="code" required className={ui.input} placeholder="MX-14" />
          </div>
          <div>
            <label className={ui.label}>Drum capacity (m³)</label>
            <input name="drumCapacityM3" type="number" step="0.5" required className={ui.input} />
          </div>
          <div>
            <label className={ui.label}>Max agitation speed (rpm)</label>
            <input name="maxAgitationRpm" type="number" step="0.5" className={ui.input} />
          </div>
          <div>
            <label className={ui.label}>GPS device ID</label>
            <input name="gpsDeviceId" className={ui.input} placeholder="GPS-114" />
          </div>
          <button type="submit" className={`${ui.button} mt-2`}>
            Add truck
          </button>
        </form>
      </div>

      <div className={ui.card}>
        <h2 className="mb-3 font-display text-lg font-semibold">Drivers</h2>
        <table className={ui.table}>
          <thead>
            <tr>
              <th className={ui.th}>Name</th>
              <th className={ui.th}>Plant</th>
              <th className={ui.th}>License</th>
              <th className={ui.th}>Expiry</th>
            </tr>
          </thead>
          <tbody>
            {drivers.map((d) => (
              <tr key={d.id}>
                <td className={`${ui.td} font-medium`}>{d.name}</td>
                <td className={ui.td}>{d.plant.name}</td>
                <td className={`${ui.td} font-mono text-xs`}>{d.licenseNumber || "—"}</td>
                <td className={ui.td}>{d.licenseExpiry ? new Date(d.licenseExpiry).toLocaleDateString() : "—"}</td>
              </tr>
            ))}
            {drivers.length === 0 && (
              <tr>
                <td className={ui.td} colSpan={4}>
                  <span className="text-ink-muted">
                    No drivers yet — add one from Employees with role Driver.
                  </span>
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
}
