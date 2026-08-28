import { redirect } from "next/navigation";

// Merged into Purchasing as its "suppliers" tab — the supplier roster and
// material catalog are the same buying workflow as purchase orders and
// contracts, just no longer worth a separate sidebar entry. This route
// stays only so any old bookmark or deep link (e.g. mix-designs' "add a
// supplier" link) still lands somewhere real.
export default function SuppliersPage() {
  redirect("/purchasing?tab=suppliers");
}
