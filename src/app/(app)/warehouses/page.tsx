import Link from "next/link";
import { ui } from "@/lib/ui";
import { requirePageAccess } from "@/lib/session";
import { getDictionary } from "@/lib/i18n";
import { getActiveSiteId } from "@/lib/siteScope";
import { RawMaterialsSilosTab } from "./rawMaterialsSilos";
import { RawMaterialsReceivingTab } from "./rawMaterialsReceiving";
import { RawMaterialsLedgerTab } from "./rawMaterialsLedger";
import { SparePartsTab } from "./spareParts";
import { FinishedGoodsTab } from "./finishedGoods";

const WAREHOUSE_TABS = ["rawMaterials", "spareParts", "finishedGoods"] as const;
type WarehouseTab = (typeof WAREHOUSE_TABS)[number];
const RAW_MATERIAL_SUB_TABS = ["silos", "receiving", "ledger"] as const;
type RawMaterialSubTab = (typeof RAW_MATERIAL_SUB_TABS)[number];

export default async function WarehousesPage({
  searchParams,
}: {
  searchParams: Promise<{ tab?: string; sub?: string; edit?: string; newSupplier?: string; site?: string }>;
}) {
  const user = await requirePageAccess("warehouses");
  const { dict } = await getDictionary();
  const m = dict.modules.warehouses;
  const { tab: tabRaw, sub: subRaw, edit: editId, newSupplier, site: siteParam } = await searchParams;
  const tab: WarehouseTab = WAREHOUSE_TABS.includes(tabRaw as WarehouseTab) ? (tabRaw as WarehouseTab) : "rawMaterials";
  const sub: RawMaterialSubTab = RAW_MATERIAL_SUB_TABS.includes(subRaw as RawMaterialSubTab) ? (subRaw as RawMaterialSubTab) : "silos";
  const siteId = await getActiveSiteId(user);

  const baseUrl = `/warehouses?tab=${tab}${tab === "rawMaterials" ? `&sub=${sub}` : ""}`;

  return (
    <div className="flex flex-col gap-8">
      <header>
        <div className={ui.eyebrow}>{m.eyebrow}</div>
        <h1 className={ui.h1}>{m.title}</h1>
        <p className={ui.intro}>{m.intro}</p>
      </header>

      <div className="no-print flex flex-wrap gap-1 border-b border-border">
        {WAREHOUSE_TABS.map((t) => (
          <Link
            key={t}
            href={t === "rawMaterials" ? "/warehouses?tab=rawMaterials&sub=silos" : `/warehouses?tab=${t}`}
            className={`rounded-t-md px-3 py-2 text-sm ${tab === t ? "border-b-2 border-accent font-medium text-ink" : "text-ink-muted hover:text-ink"}`}
          >
            {m.tabs[t]}
          </Link>
        ))}
      </div>

      {tab === "rawMaterials" && (
        <>
          <div className="no-print flex flex-wrap gap-1">
            {RAW_MATERIAL_SUB_TABS.map((s) => (
              <Link
                key={s}
                href={`/warehouses?tab=rawMaterials&sub=${s}`}
                className={`rounded-md px-3 py-1.5 text-xs font-medium ${sub === s ? "bg-accent-soft text-accent-strong" : "text-ink-muted hover:bg-surface-alt"}`}
              >
                {m.subTabs[s]}
              </Link>
            ))}
          </div>

          {sub === "silos" && <RawMaterialsSilosTab dict={dict} siteId={siteId} editId={editId} baseUrl={baseUrl} />}
          {sub === "receiving" && (
            <RawMaterialsReceivingTab dict={dict} siteId={siteId} editId={editId} newSupplier={newSupplier} baseUrl={baseUrl} />
          )}
          {sub === "ledger" && <RawMaterialsLedgerTab dict={dict} restrictedSiteId={siteId} siteParam={siteParam} />}
        </>
      )}

      {tab === "spareParts" && <SparePartsTab dict={dict} user={user} />}

      {tab === "finishedGoods" && <FinishedGoodsTab dict={dict} user={user} />}
    </div>
  );
}
