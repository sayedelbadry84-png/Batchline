import Link from "next/link";
import { prisma } from "@/lib/prisma";
import { ui } from "@/lib/ui";
import { requirePageAccess } from "@/lib/session";
import { getDictionary } from "@/lib/i18n";
import { createTruck, setTruckStatus, updateTruck } from "./actions";

const statusChip: Record<string, string> = {
  ACTIVE: "bg-good-soft text-good",
  MAINTENANCE: "bg-warn-soft text-warn",
  OUT_OF_SERVICE: "bg-critical-soft text-critical",
};

export default async function FleetPage({
  searchParams,
}: {
  searchParams: Promise<{ edit?: string }>;
}) {
  await requirePageAccess("fleet");
  const { dict } = await getDictionary();
  const m = dict.modules.fleet;
  const { edit: editId } = await searchParams;

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
        <div className={ui.eyebrow}>{m.eyebrow}</div>
        <h1 className={ui.h1}>{m.title}</h1>
        <p className={ui.intro}>{m.intro}</p>
      </header>

      <div className="grid grid-cols-[1fr_320px] gap-6">
        <div className={ui.card}>
          <table className={ui.table}>
            <thead>
              <tr>
                <th className={ui.th}>{m.col.truck}</th>
                <th className={ui.th}>{m.col.plant}</th>
                <th className={ui.th}>{m.col.drumCapacity}</th>
                <th className={ui.th}>{m.col.maxRpm}</th>
                <th className={ui.th}>{m.col.gpsDevice}</th>
                <th className={ui.th}>{m.col.lastPosition}</th>
                <th className={ui.th}>{m.col.status}</th>
                <th className={ui.th}>{dict.field.actions}</th>
              </tr>
            </thead>
            <tbody>
              {trucks.map((t) =>
                editId === t.id ? (
                  <tr key={t.id}>
                    <td className={ui.td} colSpan={8}>
                      <form action={updateTruck} className="flex flex-wrap items-end gap-2">
                        <input type="hidden" name="id" value={t.id} />
                        <div>
                          <label className={ui.label}>{dict.field.plant}</label>
                          <select name="plantId" defaultValue={t.plantId} required className={`${ui.select} w-36`}>
                            {plants.map((p) => (
                              <option key={p.id} value={p.id}>{p.name}</option>
                            ))}
                          </select>
                        </div>
                        <div>
                          <label className={ui.label}>{m.f.code}</label>
                          <input name="code" defaultValue={t.code} required className={`${ui.input} w-28`} dir="ltr" />
                        </div>
                        <div>
                          <label className={ui.label}>{m.f.drumCapacity}</label>
                          <input name="drumCapacityM3" type="number" step="0.5" defaultValue={t.drumCapacityM3} required className={`${ui.input} w-24`} />
                        </div>
                        <div>
                          <label className={ui.label}>{m.f.maxRpm}</label>
                          <input name="maxAgitationRpm" type="number" step="0.5" defaultValue={t.maxAgitationRpm ?? undefined} className={`${ui.input} w-24`} />
                        </div>
                        <div>
                          <label className={ui.label}>{m.f.gpsDevice}</label>
                          <input name="gpsDeviceId" defaultValue={t.gpsDeviceId ?? ""} className={`${ui.input} w-28`} dir="ltr" />
                        </div>
                        <div>
                          <label className={ui.label}>{m.col.status}</label>
                          <select name="status" defaultValue={t.status} className={`${ui.select} w-36`}>
                            <option value="ACTIVE">{dict.status.ACTIVE}</option>
                            <option value="MAINTENANCE">{dict.status.MAINTENANCE}</option>
                            <option value="OUT_OF_SERVICE">{dict.status.OUT_OF_SERVICE}</option>
                          </select>
                        </div>
                        <button className={ui.button}>{dict.field.save}</button>
                        <Link href="/fleet" className="rounded-md border border-border px-3 py-2 text-sm hover:bg-surface-alt">
                          {dict.field.cancel}
                        </Link>
                      </form>
                    </td>
                  </tr>
                ) : (
                  <tr key={t.id}>
                    <td className={`${ui.td} font-medium`}>
                      <span dir="ltr">{t.code}</span>
                      {t.trips.length > 0 && (
                        <span className={`${ui.chip} bg-accent-soft text-accent-strong ms-2`}>{m.onTrip}</span>
                      )}
                    </td>
                    <td className={ui.td}>{t.plant.name}</td>
                    <td className={`${ui.td} font-mono tabular`}>{t.drumCapacityM3} m³</td>
                    <td className={`${ui.td} font-mono tabular`}>{t.maxAgitationRpm ?? "—"}</td>
                    <td className={`${ui.td} font-mono text-xs`} dir="ltr">{t.gpsDeviceId || "—"}</td>
                    <td className={`${ui.td} font-mono text-xs`} dir="ltr">
                      {t.lastLat != null && t.lastLng != null ? (
                        <>
                          {t.lastLat.toFixed(4)}, {t.lastLng.toFixed(4)}
                          <div className="text-ink-faint">{t.lastPingAt ? new Date(t.lastPingAt).toLocaleTimeString() : ""}</div>
                        </>
                      ) : (
                        <span className="text-ink-faint">{m.noPing}</span>
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
                          <option value="ACTIVE">{dict.status.ACTIVE}</option>
                          <option value="MAINTENANCE">{dict.status.MAINTENANCE}</option>
                          <option value="OUT_OF_SERVICE">{dict.status.OUT_OF_SERVICE}</option>
                        </select>
                        <button className="rounded-md border border-border px-2 py-0.5 text-xs hover:bg-surface-alt">
                          {m.save}
                        </button>
                      </form>
                    </td>
                    <td className={ui.td}>
                      <Link href={`/fleet?edit=${t.id}`} className="text-xs font-medium text-accent-strong hover:underline">
                        {dict.field.edit}
                      </Link>
                    </td>
                  </tr>
                )
              )}
              {trucks.length === 0 && (
                <tr>
                  <td className={ui.td} colSpan={8}>
                    <span className="text-ink-muted">{m.empty}</span>
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>

        <form action={createTruck} className={`${ui.card} flex flex-col gap-3`}>
          <h2 className="font-display text-lg font-semibold">{m.newTitle}</h2>
          <div>
            <label className={ui.label}>{dict.field.plant}</label>
            <select name="plantId" required className={ui.select}>
              <option value="">{dict.field.selectPlant}</option>
              {plants.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.name}
                </option>
              ))}
            </select>
          </div>
          <div>
            <label className={ui.label}>{m.f.code}</label>
            <input name="code" required className={ui.input} placeholder="MX-14" dir="ltr" />
          </div>
          <div>
            <label className={ui.label}>{m.f.drumCapacity}</label>
            <input name="drumCapacityM3" type="number" step="0.5" required className={ui.input} />
          </div>
          <div>
            <label className={ui.label}>{m.f.maxRpm}</label>
            <input name="maxAgitationRpm" type="number" step="0.5" className={ui.input} />
          </div>
          <div>
            <label className={ui.label}>{m.f.gpsDevice}</label>
            <input name="gpsDeviceId" className={ui.input} placeholder="GPS-114" dir="ltr" />
          </div>
          <button type="submit" className={`${ui.button} mt-2`}>
            {m.addTruck}
          </button>
        </form>
      </div>

      <div className={ui.card}>
        <h2 className="mb-3 font-display text-lg font-semibold">{m.driversTitle}</h2>
        <table className={ui.table}>
          <thead>
            <tr>
              <th className={ui.th}>{m.colDrivers.name}</th>
              <th className={ui.th}>{m.colDrivers.plant}</th>
              <th className={ui.th}>{m.colDrivers.license}</th>
              <th className={ui.th}>{m.colDrivers.expiry}</th>
            </tr>
          </thead>
          <tbody>
            {drivers.map((d) => (
              <tr key={d.id}>
                <td className={`${ui.td} font-medium`}>{d.name}</td>
                <td className={ui.td}>{d.plant.name}</td>
                <td className={`${ui.td} font-mono text-xs`} dir="ltr">{d.licenseNumber || "—"}</td>
                <td className={ui.td}>{d.licenseExpiry ? new Date(d.licenseExpiry).toLocaleDateString() : "—"}</td>
              </tr>
            ))}
            {drivers.length === 0 && (
              <tr>
                <td className={ui.td} colSpan={4}>
                  <span className="text-ink-muted">{m.noDrivers}</span>
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
}
