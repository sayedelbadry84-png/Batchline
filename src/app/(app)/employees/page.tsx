import { prisma } from "@/lib/prisma";
import { ui } from "@/lib/ui";
import { requirePageAccess } from "@/lib/session";
import { getDictionary } from "@/lib/i18n";
import { createEmployee } from "./actions";

const ROLES = ["PLANT_OPERATOR", "QUALITY_SUPERVISOR", "ACCOUNTANT", "DRIVER", "DISPATCHER", "ADMIN"] as const;

// Pure and outside the component body on purpose — takes "now" and the
// translated labels as arguments instead of closing over Date.now()/dict,
// so it stays a plain, side-effect-free helper.
function expiryFlag(date: Date | null, nowMs: number, labels: { expired: string; daysLeft: (n: number) => string }) {
  if (!date) return null;
  const days = Math.ceil((date.getTime() - nowMs) / (1000 * 60 * 60 * 24));
  if (days < 0) return { label: labels.expired, cls: "bg-critical-soft text-critical" };
  if (days <= 30) return { label: labels.daysLeft(days), cls: "bg-warn-soft text-warn" };
  return null;
}

export default async function EmployeesPage() {
  await requirePageAccess("employees");
  const { dict } = await getDictionary();
  const m = dict.modules.employees;
  // eslint-disable-next-line react-hooks/purity
  const nowMs = Date.now();

  const [employees, plants] = await Promise.all([
    prisma.employee.findMany({ orderBy: { createdAt: "asc" }, include: { plant: true } }),
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
                <th className={ui.th}>{m.col.name}</th>
                <th className={ui.th}>{m.col.role}</th>
                <th className={ui.th}>{m.col.plant}</th>
                <th className={ui.th}>{m.col.shift}</th>
                <th className={ui.th}>{m.col.license}</th>
              </tr>
            </thead>
            <tbody>
              {employees.map((e) => {
                const flag = expiryFlag(e.licenseExpiry, nowMs, m);
                return (
                  <tr key={e.id}>
                    <td className={`${ui.td} font-medium`}>{e.name}</td>
                    <td className={`${ui.td} font-mono text-xs`}>{dict.roles[e.role as keyof typeof dict.roles] ?? e.role}</td>
                    <td className={ui.td}>{e.plant.name}</td>
                    <td className={ui.td}>{e.shiftPattern || "—"}</td>
                    <td className={ui.td}>
                      {e.licenseExpiry ? new Date(e.licenseExpiry).toLocaleDateString() : "—"}
                      {flag && <span className={`${ui.chip} ${flag.cls} ms-2`}>{flag.label}</span>}
                    </td>
                  </tr>
                );
              })}
              {employees.length === 0 && (
                <tr>
                  <td className={ui.td} colSpan={5}>
                    <span className="text-ink-muted">{m.empty}</span>
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>

        <form action={createEmployee} className={`${ui.card} flex flex-col gap-3`}>
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
            <label className={ui.label}>{m.f.name}</label>
            <input name="name" required className={ui.input} />
          </div>
          <div>
            <label className={ui.label}>{m.f.role}</label>
            <select name="role" required className={ui.select}>
              {ROLES.map((r) => (
                <option key={r} value={r}>
                  {dict.roles[r]}
                </option>
              ))}
            </select>
          </div>
          <div>
            <label className={ui.label}>{m.f.shiftPattern}</label>
            <input name="shiftPattern" className={ui.input} placeholder="Day / 6am–6pm" dir="ltr" />
          </div>
          <div>
            <label className={ui.label}>{m.f.licenseExpiry}</label>
            <input name="licenseExpiry" type="date" className={ui.input} />
          </div>
          <button type="submit" className={`${ui.button} mt-2`}>
            {m.add}
          </button>
        </form>
      </div>
    </div>
  );
}
