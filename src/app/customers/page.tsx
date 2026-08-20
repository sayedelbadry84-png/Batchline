import { prisma } from "@/lib/prisma";
import { ui } from "@/lib/ui";
import { createCustomer } from "./actions";

export default async function CustomersPage() {
  const customers = await prisma.customer.findMany({
    orderBy: { createdAt: "asc" },
    include: { _count: { select: { projects: true } } },
  });

  return (
    <div className="flex flex-col gap-8">
      <header>
        <div className={ui.eyebrow}>Module 07 — Customers</div>
        <h1 className={ui.h1}>Customer accounts</h1>
        <p className={ui.intro}>
          Builders and contractors — credit terms, contacts, and the projects
          billed against each account.
        </p>
      </header>

      <div className="grid grid-cols-[1fr_320px] gap-6">
        <div className={ui.card}>
          <table className={ui.table}>
            <thead>
              <tr>
                <th className={ui.th}>Customer</th>
                <th className={ui.th}>Credit limit</th>
                <th className={ui.th}>Terms</th>
                <th className={ui.th}>Contact</th>
                <th className={ui.th}>Projects</th>
              </tr>
            </thead>
            <tbody>
              {customers.map((c) => (
                <tr key={c.id}>
                  <td className={`${ui.td} font-medium`}>{c.legalName}</td>
                  <td className={`${ui.td} font-mono tabular`}>{c.creditLimit.toLocaleString()}</td>
                  <td className={ui.td}>{c.paymentTerms}</td>
                  <td className={ui.td}>{c.contactEmail || c.contactPhone || "—"}</td>
                  <td className={`${ui.td} font-mono tabular`}>{c._count.projects}</td>
                </tr>
              ))}
              {customers.length === 0 && (
                <tr>
                  <td className={ui.td} colSpan={5}>
                    <span className="text-ink-muted">No customers yet.</span>
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>

        <form action={createCustomer} className={`${ui.card} flex flex-col gap-3`}>
          <h2 className="font-display text-lg font-semibold">New customer</h2>
          <div>
            <label className={ui.label}>Legal name</label>
            <input name="legalName" required className={ui.input} placeholder="Nile Towers Development" />
          </div>
          <div>
            <label className={ui.label}>Tax ID</label>
            <input name="taxId" className={ui.input} />
          </div>
          <div>
            <label className={ui.label}>Credit limit</label>
            <input name="creditLimit" type="number" step="1000" defaultValue={0} className={ui.input} />
          </div>
          <div>
            <label className={ui.label}>Payment terms</label>
            <input name="paymentTerms" defaultValue="Net 30" className={ui.input} />
          </div>
          <div>
            <label className={ui.label}>Contact email</label>
            <input name="contactEmail" type="email" className={ui.input} />
          </div>
          <div>
            <label className={ui.label}>Contact phone</label>
            <input name="contactPhone" className={ui.input} />
          </div>
          <button type="submit" className={`${ui.button} mt-2`}>
            Add customer
          </button>
        </form>
      </div>
    </div>
  );
}
