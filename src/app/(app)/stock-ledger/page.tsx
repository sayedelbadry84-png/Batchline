import { redirect } from "next/navigation";

// Merged into Warehouses as the "Raw Materials → Stock Ledger" sub-tab —
// see warehouses/rawMaterialsLedger.tsx. This route stays only so any old
// bookmark still lands somewhere real.
export default function StockLedgerPage() {
  redirect("/warehouses?tab=rawMaterials&sub=ledger");
}
