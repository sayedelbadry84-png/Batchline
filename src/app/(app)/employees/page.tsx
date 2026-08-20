import { prisma } from "@/lib/prisma";
import { ui } from "@/lib/ui";
import { requirePageAccess } from "@/lib/session";
import { createEmployee } from "./actions";

const ROLES = ["PLANT_OPERATOR", "QUALITY_SUPERVISOR", "ACCOUNTANT", "DRIVER", "DISPATCHER", "ADMIN"];

function expiryFlag(date: Date | null) {
  if (!date) return null;
  const days = Math.ceil((date.getTime() - Date.now()) / (1000 * 60 * 60 * 24));
  if (days < 0) return { label: "expired", cls: "bg-critical-soft text-critical" };
  if (days <= 30) return { label: `${days}d left`, cls: "bg-warn-soft text-warn" };
  return null;
}

export default async function EmployeesPage() {
  await requirePageAccess("employees");

  const [employees, plants] = await Promise.all([
    prisma.employee.findMany({ orderBy: { createdAt: "asc" }, include: { plant: true } }),
    prisma.plant.findMany({ orderBy: { name: "asc" } }),
  ]);

  return (
    <div className="flex flex-col gap-8">
      <header>
        <div className={ui.eyebrow}>Module 10 — Employees</div>
        <h1 className={ui.h1}>Employee directory</h1>
        <p className={ui.intro}>
          Plant staff and their certifications. Licenses expiring within 30
          days are flagged.
        </p>
      </header>

      <div className="grid grid-cols-[1fr_320px] gap-6">
        <div className={ui.card}>
          <table className={ui.table}>
            <thead>
              <tr>
                <th className={ui.th}>Name</th>
                <th className={ui.th}>Role</th>
                <th className={ui.th}>Plant</th>
                <th className={ui.th}>Shift</th>
                <th className={ui.th}>License</th>
              </tr>
            </thead>
            <tbody>
              {employees.map((e) => {
                const flag = expiryFlag(e.licenseExpiry);
                return (
                  <tr key={e.id}>
                    <td className={`${ui.td} font-medium`}>{e.name}</td>
                    <td className={`${ui.td} font-mono text-xs`}>{e.role}</td>
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
                    <span className="text-ink-muted">No employees yet.</span>
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>

        <form action={createEmployee} className={`${ui.card} flex flex-col gap-3`}>
          <h2 className="font-display text-lg font-semibold">New employee</h2>
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
            <label className={ui.label}>Name</label>
            <input name="name" required className={ui.input} />
          </div>
          <div>
            <label className={ui.label}>Role</label>
            <select name="role" required className={ui.select}>
              {ROLES.map((r) => (
                <option key={r} value={r}>
                  {r.replaceAll("_", " ")}
                </option>
              ))}
            </select>
          </div>
          <div>
            <label className={ui.label}>Shift pattern</label>
            <input name="shiftPattern" className={ui.input} placeholder="Day / 6am–6pm" />
          </div>
          <div>
            <label className={ui.label}>License / cert expiry</label>
            <input name="licenseExpiry" type="date" className={ui.input} />
          </div>
          <button type="submit" className={`${ui.button} mt-2`}>
            Add employee
          </button>
        </form>
      </div>
    </div>
  );
}
