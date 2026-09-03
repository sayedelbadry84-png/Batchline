"use client";

import { useState } from "react";
import { ui } from "@/lib/ui";
import { EquipmentPicker } from "@/components/EquipmentPicker";

type OrderOption = { id: string; orderNumber: string; equipmentType: string; equipmentId: string; equipmentLabel: string };
type EquipmentOption = { type: string; id: string; label: string };

// The work-order and equipment fields on the spare-part issuance form,
// paired together: every MaintenanceOrder is already against one real
// unit (via its ticket), so picking the order should pick that unit too
// — not leave the equipment field sitting empty for the same job. Keying
// EquipmentPicker on the selected order remounts it with that equipment
// pre-selected (React's own recommended way to reset state from a prop,
// no effect needed) — the user can still pick a different unit by hand
// afterward if the part genuinely went somewhere else, that just won't
// survive picking yet another order.
export function MaintenanceOrderAndEquipmentFields({
  orders,
  equipmentOptions,
  orderLabel,
  orderHint,
  orderNone,
  equipmentLabel,
  equipmentHint,
  equipmentPlaceholder,
  equipmentTypeLabels,
}: {
  orders: OrderOption[];
  equipmentOptions: EquipmentOption[];
  orderLabel: string;
  orderHint: string;
  orderNone: string;
  equipmentLabel: string;
  equipmentHint: string;
  equipmentPlaceholder: string;
  equipmentTypeLabels: Record<string, string>;
}) {
  const [selectedOrderId, setSelectedOrderId] = useState("");
  const selectedOrder = orders.find((o) => o.id === selectedOrderId) ?? null;

  return (
    <>
      <div>
        <label className={ui.label}>{orderLabel}</label>
        <select
          name="maintenanceOrderId"
          value={selectedOrderId}
          onChange={(e) => setSelectedOrderId(e.target.value)}
          className={ui.select}
        >
          <option value="">{orderNone}</option>
          {orders.map((o) => (
            <option key={o.id} value={o.id}>{o.orderNumber} — {o.equipmentLabel}</option>
          ))}
        </select>
        <p className="mt-1 text-xs text-ink-muted">{orderHint}</p>
      </div>
      <div>
        <label className={ui.label}>{equipmentLabel}</label>
        <EquipmentPicker
          key={selectedOrder ? `${selectedOrder.equipmentType}::${selectedOrder.equipmentId}` : "none"}
          options={equipmentOptions}
          placeholder={equipmentPlaceholder}
          typeLabels={equipmentTypeLabels}
          required={false}
          initialSelection={selectedOrder ? { type: selectedOrder.equipmentType, id: selectedOrder.equipmentId } : null}
        />
        <p className="mt-1 text-xs text-ink-muted">{equipmentHint}</p>
      </div>
    </>
  );
}
