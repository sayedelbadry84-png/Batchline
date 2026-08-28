import { redirect } from "next/navigation";

// Merged into Warehouses as the "Raw Materials → Silos & Hoppers" sub-tab
// — see warehouses/rawMaterialsSilos.tsx, which reuses this module's own
// actions.ts unchanged. This route stays only so any old bookmark still
// lands somewhere real.
export default function SilosPage() {
  redirect("/warehouses?tab=rawMaterials&sub=silos");
}
