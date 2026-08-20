import { prisma } from "@/lib/prisma";
import { ui } from "@/lib/ui";
import { requirePageAccess } from "@/lib/session";
import { getDictionary } from "@/lib/i18n";
import { createCustomer } from "./actions";

export default async function CustomersPage() {
  await requirePageAccess("customers");
  const { dict } = await getDictionary();
  const m = dict.modules.customers;

  const customers = await prisma.customer.findMany({
    orderBy: { createdAt: "asc" },
    include: { _count: { select: { projects: true } } },
  });

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
                <th className={ui.th}>{m.col.customer}</th>
                <th className={ui.th}>{m.col.creditLimit}</th>
                <th className={ui.th}>{m.col.terms}</th>
                <th className={ui.th}>{m.col.contact}</th>
                <th className={ui.th}>{m.col.projects}</th>
              </tr>
            </thead>
            <tbody>
              {customers.map((c) => (
                <tr key={c.id}>
                  <td className={`${ui.td} font-medium`}>{c.legalName}</td>
                  <td className={`${ui.td} font-mono tabular`}>{c.creditLimit.toLocaleString()}</td>
                  <td className={ui.td}>{c.paymentTerms}</td>
                  <td className={ui.td} dir="ltr">{c.contactEmail || c.contactPhone || "—"}</td>
                  <td className={`${ui.td} font-mono tabular`}>{c._count.projects}</td>
                </tr>
              ))}
              {customers.length === 0 && (
                <tr>
                  <td className={ui.td} colSpan={5}>
                    <span className="text-ink-muted">{m.empty}</span>
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>

        <form action={createCustomer} className={`${ui.card} flex flex-col gap-3`}>
          <h2 className="font-display text-lg font-semibold">{m.newTitle}</h2>
          <div>
            <label className={ui.label}>{m.f.legalName}</label>
            <input name="legalName" required className={ui.input} placeholder="Nile Towers Development" />
          </div>
          <div>
            <label className={ui.label}>{m.f.taxId}</label>
            <input name="taxId" className={ui.input} dir="ltr" />
          </div>
          <div>
            <label className={ui.label}>{m.f.creditLimit}</label>
            <input name="creditLimit" type="number" step="1000" defaultValue={0} className={ui.input} />
          </div>
          <div>
            <label className={ui.label}>{m.f.paymentTerms}</label>
            <input name="paymentTerms" defaultValue="Net 30" className={ui.input} dir="ltr" />
          </div>
          <div>
            <label className={ui.label}>{m.f.contactEmail}</label>
            <input name="contactEmail" type="email" className={ui.input} dir="ltr" />
          </div>
          <div>
            <label className={ui.label}>{m.f.contactPhone}</label>
            <input name="contactPhone" className={ui.input} dir="ltr" />
          </div>
          <button type="submit" className={`${ui.button} mt-2`}>
            {m.add}
          </button>
        </form>
      </div>
    </div>
  );
}
