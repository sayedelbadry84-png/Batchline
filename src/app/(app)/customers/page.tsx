import Link from "next/link";
import { prisma } from "@/lib/prisma";
import { ui } from "@/lib/ui";
import { requirePageAccess } from "@/lib/session";
import { getDictionary } from "@/lib/i18n";
import { createCustomer, updateCustomer, requestCreditLimitIncreaseAction, decideCreditLimitRequestAction } from "./actions";
import { canPerformAction } from "@/lib/permissions";
import { CREDIT_LIMIT_DECIDER_ROLE, listCreditLimitRequestsFor } from "@/lib/creditLimitRequests";
import { getDateFormatters } from "@/lib/displayTimeZone";
import { describeCustomerResult } from "@/lib/customerResultText";
import { createProject, updateProject } from "../projects/actions";

// Customers and their projects share one screen — a project is nothing
// more than "a job site under one of these customers" (it carries no
// plant/site of its own; see the Project model comment in schema.prisma),
// so managing them apart never made sense once that changed.
export default async function CustomersPage({
  searchParams,
}: {
  searchParams: Promise<{ edit?: string; editProject?: string; customerResult?: string }>;
}) {
  const user = await requirePageAccess("customers");
  const dt = await getDateFormatters();
  const { dict } = await getDictionary();
  const m = dict.modules.customers;
  const cl = m.creditLimitRequests;
  const mp = dict.modules.projects;
  const { edit: editId, editProject: editProjectId, customerResult } = await searchParams;
  const resultBanner = describeCustomerResult(cl.result, customerResult);
  // What this user may do with credit limit requests. Display only: each
  // action re-checks on the server, and a decision re-reads the decider's
  // role inside its transaction.
  const canRequestLimit = await canPerformAction(user.role, "customers", "requestCreditLimitIncrease");
  const canDecideLimit = user.role === CREDIT_LIMIT_DECIDER_ROLE;

  const [customers, projects] = await Promise.all([
    prisma.customer.findMany({
      orderBy: { createdAt: "asc" },
      include: { _count: { select: { projects: true } } },
    }),
    prisma.project.findMany({
      orderBy: { createdAt: "asc" },
      include: { customer: true, _count: { select: { reservations: true } } },
    }),
  ]);
  // Which requests this user may read is decided in the query (see
  // listCreditLimitRequestsFor): the queue for deciders, a requester's own
  // requests, and nothing for anyone else.
  const { visibility: requestVisibility, pending: pendingRequests, recent: recentDecisions } = await listCreditLimitRequestsFor({ id: user.id, role: user.role });
  const pendingByCustomer = new Map(pendingRequests.map((r) => [r.customerId, r]));
  const money = (minor: bigint) => (Number(minor) / 100).toLocaleString();

  return (
    <div className="flex flex-col gap-8">
      <header>
        <div className={ui.eyebrow}>{m.eyebrow}</div>
        <h1 className={ui.h1}>{m.title}</h1>
        <p className={ui.intro}>{m.intro}</p>
      </header>
      {resultBanner && (
        <p
          role={resultBanner.ok ? "status" : "alert"}
          className={`rounded-md border px-3 py-2 text-sm ${resultBanner.ok ? "border-good/40 bg-good-soft text-good" : "border-critical/40 bg-critical-soft text-critical"}`}
        >
          {resultBanner.text}
        </p>
      )}

      <div>
        <h2 className="mb-1 font-display text-lg font-semibold">{m.customersTitle}</h2>
        <p className="mb-3 text-sm text-ink-muted">{m.customersIntro}</p>
        <div className="grid grid-cols-[1fr_320px] gap-6">
          <div className={ui.card}>
            <table className={ui.table}>
              <thead>
                <tr>
                  <th className={ui.th}>{m.col.code}</th>
                  <th className={ui.th}>{m.col.customer}</th>
                  <th className={ui.th}>{m.col.creditLimit}</th>
                  <th className={ui.th}>{m.col.terms}</th>
                  <th className={ui.th}>{m.col.contact}</th>
                  <th className={ui.th}>{m.col.projects}</th>
                  <th className={ui.th}>{dict.field.actions}</th>
                </tr>
              </thead>
              <tbody>
                {customers.map((c) =>
                  editId === c.id ? (
                    <tr key={c.id}>
                      <td className={ui.td} colSpan={7}>
                        <form action={updateCustomer} className="flex flex-wrap items-end gap-2">
                          <input type="hidden" name="id" value={c.id} />
                          <div>
                            <label className={ui.label}>{m.f.code}</label>
                            <input name="code" defaultValue={c.code ?? ""} className={`${ui.input} w-28`} dir="ltr" />
                          </div>
                          <div>
                            <label className={ui.label}>{m.f.legalName}</label>
                            <input name="legalName" defaultValue={c.legalName} required className={`${ui.input} w-44`} />
                          </div>
                          <div>
                            <label className={ui.label}>{m.f.taxId}</label>
                            <input name="taxId" defaultValue={c.taxId ?? ""} className={`${ui.input} w-32`} dir="ltr" />
                          </div>
                          <div>
                            <label className={ui.label}>{m.f.paymentTerms}</label>
                            <input name="paymentTerms" defaultValue={c.paymentTerms} className={`${ui.input} w-28`} dir="ltr" />
                          </div>
                          <div>
                            <label className={ui.label}>{m.f.contactEmail}</label>
                            <input name="contactEmail" type="email" defaultValue={c.contactEmail ?? ""} className={`${ui.input} w-40`} dir="ltr" />
                          </div>
                          <div>
                            <label className={ui.label}>{m.f.contactPhone}</label>
                            <input name="contactPhone" defaultValue={c.contactPhone ?? ""} className={`${ui.input} w-32`} dir="ltr" />
                          </div>
                          <button className={ui.button}>{dict.field.save}</button>
                          <Link href="/customers" className="rounded-md border border-border px-3 py-2 text-sm hover:bg-surface-alt">
                            {dict.field.cancel}
                          </Link>
                        </form>
                      </td>
                    </tr>
                  ) : (
                    <tr key={c.id}>
                      <td className={`${ui.td} font-mono text-xs`} dir="ltr">{c.code ?? "—"}</td>
                      <td className={`${ui.td} font-medium`}>{c.legalName}</td>
                      <td className={`${ui.td} font-mono tabular`}>
                        {c.creditLimit.toLocaleString()}
                        {pendingByCustomer.has(c.id) && (
                          <span className="block text-xs text-warn">
                            → {money(pendingByCustomer.get(c.id)!.proposedLimitMinor)} ({cl.pendingSuffix})
                          </span>
                        )}
                      </td>
                      <td className={ui.td}>{c.paymentTerms}</td>
                      <td className={ui.td} dir="ltr">{c.contactEmail || c.contactPhone || "—"}</td>
                      <td className={`${ui.td} font-mono tabular`}>{c._count.projects}</td>
                      <td className={ui.td}>
                        <div className="flex flex-col gap-1">
                          <Link href={`/customers?edit=${c.id}`} className="text-xs font-medium text-accent-strong hover:underline">
                            {dict.field.edit}
                          </Link>
                          <Link href={`/finance/customers/${c.id}/statement`} className="text-xs font-medium text-accent-strong hover:underline">
                            {m.statement}
                          </Link>
                        </div>
                      </td>
                    </tr>
                  )
                )}
                {customers.length === 0 && (
                  <tr>
                    <td className={ui.td} colSpan={7}>
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
              <label className={ui.label}>{m.f.code}</label>
              <input name="code" className={ui.input} dir="ltr" placeholder="C-00335" />
              <p className="mt-1 text-xs text-ink-muted">{m.codeHint}</p>
            </div>
            <div>
              <label className={ui.label}>{m.f.legalName}</label>
              <input name="legalName" required className={ui.input} placeholder="Nile Towers Development" />
            </div>
            <div>
              <label className={ui.label}>{m.f.taxId}</label>
              <input name="taxId" className={ui.input} dir="ltr" />
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

      <section className={`${ui.card} flex flex-col gap-4`}>
        <div>
          <h2 className="mb-1 font-display text-lg font-semibold">{cl.title}</h2>
          <p className="max-w-3xl text-sm text-ink-muted">{cl.intro}</p>
        </div>

        {canRequestLimit && (
          <form action={requestCreditLimitIncreaseAction} className="flex flex-wrap items-end gap-3">
            <div>
              <label htmlFor="cl-customer" className={ui.label}>{cl.customer}</label>
              <select id="cl-customer" name="customerId" required className={`${ui.select} w-56`} defaultValue="">
                <option value="" disabled>—</option>
                {customers.map((c) => (
                  <option key={c.id} value={c.id}>
                    {c.legalName} ({cl.approvedLimit}: {c.creditLimit.toLocaleString()})
                  </option>
                ))}
              </select>
            </div>
            <div>
              <label htmlFor="cl-proposed" className={ui.label}>{cl.proposedLimit}</label>
              <input id="cl-proposed" name="proposedLimit" type="number" step="0.01" min="0" required className={`${ui.input} w-36`} dir="ltr" />
            </div>
            <div className="min-w-64 flex-1">
              <label htmlFor="cl-reason" className={ui.label}>{cl.reason}</label>
              <input id="cl-reason" name="reason" required minLength={10} className={ui.input} />
              <p className="mt-1 text-xs text-ink-muted">{cl.reasonHint}</p>
            </div>
            <button type="submit" className={ui.button}>{cl.requestButton}</button>
          </form>
        )}

        {requestVisibility === "NONE" ? (
          <p className="text-sm text-ink-muted">{cl.hiddenNote}</p>
        ) : (
        <div>
          <h3 className="mb-2 font-semibold">{cl.pendingTitle}</h3>
          {requestVisibility === "OWN" && <p className="mb-2 text-xs text-ink-muted">{cl.ownOnlyNote}</p>}
          {pendingRequests.length === 0 ? (
            <p className="text-sm text-ink-muted">{cl.noPending}</p>
          ) : (
            <table className={ui.table}>
              <thead>
                <tr>
                  <th className={ui.th}>{cl.col.customer}</th>
                  <th className={ui.th}>{cl.col.current}</th>
                  <th className={ui.th}>{cl.col.proposed}</th>
                  <th className={ui.th}>{cl.col.requestedBy}</th>
                  <th className={ui.th}>{cl.col.requestedAt}</th>
                  <th className={ui.th}>{cl.col.reason}</th>
                  <th className={ui.th}>{dict.field.actions}</th>
                </tr>
              </thead>
              <tbody>
                {pendingRequests.map((r) => (
                  <tr key={r.id}>
                    <td className={ui.td}>{r.customer.legalName}</td>
                    <td className={`${ui.td} font-mono tabular`} dir="ltr">{money(r.previousLimitMinor)}</td>
                    <td className={`${ui.td} font-mono tabular`} dir="ltr">{money(r.proposedLimitMinor)}</td>
                    <td className={ui.td}>{r.requestedBy.name}</td>
                    <td className={`${ui.td} font-mono text-xs`} dir="ltr">{dt.dateTime(r.requestedAt)}</td>
                    <td className={ui.td}>{r.reason}</td>
                    <td className={ui.td}>
                      {r.requestedById === user.id ? (
                        <span className="text-xs text-ink-muted">{cl.ownRequest}</span>
                      ) : canDecideLimit ? (
                        <form action={decideCreditLimitRequestAction} className="flex flex-col gap-1">
                          <input type="hidden" name="requestId" value={r.id} />
                          <input name="decisionNote" placeholder={cl.decisionNote} aria-label={cl.decisionNote} className={`${ui.input} w-48`} />
                          <div className="flex gap-2">
                            <button name="decision" value="APPROVE" className="text-xs font-medium text-good hover:underline">{cl.approve}</button>
                            <button name="decision" value="REJECT" className="text-xs font-medium text-critical hover:underline">{cl.reject}</button>
                          </div>
                        </form>
                      ) : null}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>
        )}

        {recentDecisions.length > 0 && (
          <div>
            <h3 className="mb-2 font-semibold">{cl.recentTitle}</h3>
            <table className={ui.table}>
              <thead>
                <tr>
                  <th className={ui.th}>{cl.col.customer}</th>
                  <th className={ui.th}>{cl.col.current}</th>
                  <th className={ui.th}>{cl.col.proposed}</th>
                  <th className={ui.th}>{cl.col.status}</th>
                  <th className={ui.th}>{cl.col.requestedBy}</th>
                  <th className={ui.th}>{cl.col.decidedBy}</th>
                  <th className={ui.th}>{cl.col.note}</th>
                </tr>
              </thead>
              <tbody>
                {recentDecisions.map((r) => (
                  <tr key={r.id}>
                    <td className={ui.td}>{r.customer.legalName}</td>
                    <td className={`${ui.td} font-mono tabular`} dir="ltr">{money(r.previousLimitMinor)}</td>
                    <td className={`${ui.td} font-mono tabular`} dir="ltr">{money(r.proposedLimitMinor)}</td>
                    <td className={ui.td}>{cl.status[r.status as keyof typeof cl.status] ?? r.status}</td>
                    <td className={ui.td}>{r.requestedBy.name}</td>
                    <td className={ui.td}>{r.decidedBy?.name ?? "—"}</td>
                    <td className={ui.td}>{r.decisionNote ?? "—"}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>

      <div>
        <h2 className="mb-1 font-display text-lg font-semibold">{mp.title}</h2>
        <p className="mb-3 text-sm text-ink-muted">{mp.intro}</p>
        <div className="grid grid-cols-[1fr_320px] gap-6">
          <div className={ui.card}>
            <table className={ui.table}>
              <thead>
                <tr>
                  <th className={ui.th}>{mp.col.project}</th>
                  <th className={ui.th}>{mp.col.customer}</th>
                  <th className={ui.th}>{mp.col.contracted}</th>
                  <th className={ui.th}>{mp.col.reservations}</th>
                  <th className={ui.th}>{mp.col.status}</th>
                  <th className={ui.th}>{dict.field.actions}</th>
                </tr>
              </thead>
              <tbody>
                {projects.map((p) =>
                  editProjectId === p.id ? (
                    <tr key={p.id}>
                      <td className={ui.td} colSpan={6}>
                        <form action={updateProject} className="flex flex-wrap items-end gap-2">
                          <input type="hidden" name="id" value={p.id} />
                          <div>
                            <label className={ui.label}>{mp.f.name}</label>
                            <input name="name" defaultValue={p.name} required className={`${ui.input} w-44`} />
                          </div>
                          <div>
                            <label className={ui.label}>{mp.f.customer}</label>
                            <select name="customerId" defaultValue={p.customerId} required className={`${ui.select} w-40`}>
                              {customers.map((c) => (
                                <option key={c.id} value={c.id}>{c.legalName}</option>
                              ))}
                            </select>
                          </div>
                          <div>
                            <label className={ui.label}>{mp.f.siteAddress}</label>
                            <input name="siteAddress" defaultValue={p.siteAddress} required className={`${ui.input} w-48`} />
                          </div>
                          <div>
                            <label className={ui.label}>{mp.f.contractedVolume}</label>
                            <input name="contractedVolumeM3" type="number" step="1" defaultValue={p.contractedVolumeM3 ?? undefined} className={`${ui.input} w-28`} />
                          </div>
                          <div>
                            <label className={ui.label}>{mp.col.status}</label>
                            <select name="status" defaultValue={p.status} className={`${ui.select} w-32`}>
                              <option value="ACTIVE">{dict.status.ACTIVE}</option>
                              <option value="ON_HOLD">{dict.status.ON_HOLD}</option>
                              <option value="COMPLETE">{dict.status.COMPLETE}</option>
                              <option value="CANCELLED">{dict.status.CANCELLED}</option>
                            </select>
                          </div>
                          <button className={ui.button}>{dict.field.save}</button>
                          <Link href="/customers" className="rounded-md border border-border px-3 py-2 text-sm hover:bg-surface-alt">
                            {dict.field.cancel}
                          </Link>
                        </form>
                      </td>
                    </tr>
                  ) : (
                    <tr key={p.id}>
                      <td className={`${ui.td} font-medium`}>
                        {p.name}
                        <div className="text-xs font-normal text-ink-muted">{p.siteAddress}</div>
                      </td>
                      <td className={ui.td}>{p.customer.legalName}</td>
                      <td className={`${ui.td} font-mono tabular`}>{p.contractedVolumeM3 ?? "—"}</td>
                      <td className={`${ui.td} font-mono tabular`}>{p._count.reservations}</td>
                      <td className={ui.td}>
                        <span className={`${ui.chip} bg-surface-alt text-ink-muted`}>{dict.status[p.status as keyof typeof dict.status] ?? p.status}</span>
                      </td>
                      <td className={ui.td}>
                        <Link href={`/customers?editProject=${p.id}`} className="text-xs font-medium text-accent-strong hover:underline">
                          {dict.field.edit}
                        </Link>
                      </td>
                    </tr>
                  )
                )}
                {projects.length === 0 && (
                  <tr>
                    <td className={ui.td} colSpan={6}>
                      <span className="text-ink-muted">{mp.empty}</span>
                    </td>
                  </tr>
                )}
              </tbody>
            </table>
          </div>

          <form action={createProject} className={`${ui.card} flex flex-col gap-3`}>
            <h2 className="font-display text-lg font-semibold">{mp.newTitle}</h2>
            <div>
              <label className={ui.label}>{mp.f.name}</label>
              <input name="name" required className={ui.input} placeholder="Nile Towers — Phase 2" />
            </div>
            <div>
              <label className={ui.label}>{mp.f.customer}</label>
              <select name="customerId" required className={ui.select}>
                <option value="">{dict.field.selectCustomer}</option>
                {customers.map((c) => (
                  <option key={c.id} value={c.id}>
                    {c.legalName}
                  </option>
                ))}
              </select>
            </div>
            <div>
              <label className={ui.label}>{mp.f.siteAddress}</label>
              <input name="siteAddress" required className={ui.input} />
            </div>
            <div>
              <label className={ui.label}>{mp.f.contractedVolume}</label>
              <input name="contractedVolumeM3" type="number" step="1" className={ui.input} />
            </div>
            <button type="submit" className={`${ui.button} mt-2`}>
              {mp.add}
            </button>
          </form>
        </div>
      </div>
    </div>
  );
}
