import { redirect } from "next/navigation";

// Merged into Warehouses as the "Raw Materials → Material Receiving"
// sub-tab — see warehouses/rawMaterialsReceiving.tsx, which reuses this
// module's own actions.ts unchanged. This route stays only so any old
// bookmark still lands somewhere real.
export default function MaterialReceivingPage() {
  redirect("/warehouses?tab=rawMaterials&sub=receiving");
}
