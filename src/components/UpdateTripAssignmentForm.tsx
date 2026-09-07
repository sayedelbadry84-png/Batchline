"use client";

import { useActionState } from "react";
import Link from "next/link";
import { updateTripAssignment } from "@/app/(app)/production/actions";
import { EquipmentAssignPicker } from "@/components/EquipmentAssignPicker";

type Option = { value: string; label: string };
type EquipmentOption = Option & { defaults: Record<string, string> };

export type UpdateTripAssignmentMessages = {
  editAssignTitle: string;
  truck: string;
  selectTruck: string;
  driver: string;
  selectDriver: string;
  pump: string;
  selectPump: string;
  pumpOperator: string;
  selectPumpOperator: string;
  pumpAssistant: string;
  none: string;
  save: string;
  cancel: string;
  errors: Record<string, string>;
};

// Was a plain <form action={updateTripAssignment}> — every refusal used
// to silently do nothing, same PL-R4-P2-02 finding as StartTripForm.
export function UpdateTripAssignmentForm({
  tripId,
  cancelHref,
  isPumpDelivery,
  defaultTruckId,
  defaultDriverId,
  defaultPumpId,
  defaultPumpOperatorId,
  defaultPumpAssistantId,
  truckOptions,
  driverOptions,
  pumpOptions,
  operatorOptions,
  assistantOptions,
  messages,
  cardClassName,
  titleClassName,
  selectClassName,
  buttonClassName,
  cancelClassName,
}: {
  tripId: string;
  cancelHref: string;
  isPumpDelivery: boolean;
  defaultTruckId: string;
  defaultDriverId: string;
  defaultPumpId: string;
  defaultPumpOperatorId: string;
  defaultPumpAssistantId: string;
  truckOptions: EquipmentOption[];
  driverOptions: Option[];
  pumpOptions: EquipmentOption[];
  operatorOptions: Option[];
  assistantOptions: Option[];
  messages: UpdateTripAssignmentMessages;
  cardClassName: string;
  titleClassName: string;
  selectClassName: string;
  buttonClassName: string;
  cancelClassName: string;
}) {
  const [state, formAction, isPending] = useActionState(updateTripAssignment, null);
  const error = state && state.status !== "OK" ? (messages.errors[state.status] ?? state.status) : null;

  return (
    <form action={formAction} className={cardClassName}>
      <input type="hidden" name="tripId" value={tripId} />
      <h2 className={titleClassName}>{messages.editAssignTitle}</h2>
      <div className="grid grid-cols-2 gap-3">
        <EquipmentAssignPicker
          equipment={{ name: "truckId", label: messages.truck, placeholder: messages.selectTruck, required: true, className: selectClassName, defaultValue: defaultTruckId, options: truckOptions }}
          dependents={[{ key: "driverId", name: "driverId", label: messages.driver, placeholder: messages.selectDriver, required: true, className: selectClassName, defaultValue: defaultDriverId, options: driverOptions }]}
        />
      </div>
      {isPumpDelivery && (
        <div className="border-t border-border pt-3">
          <div className="grid grid-cols-3 gap-3">
            <EquipmentAssignPicker
              equipment={{ name: "pumpId", label: messages.pump, placeholder: messages.selectPump, required: true, className: selectClassName, defaultValue: defaultPumpId, options: pumpOptions }}
              dependents={[
                { key: "pumpOperatorId", name: "pumpOperatorId", label: messages.pumpOperator, placeholder: messages.selectPumpOperator, required: true, className: selectClassName, defaultValue: defaultPumpOperatorId, options: operatorOptions },
                { key: "pumpAssistantId", name: "pumpAssistantId", label: messages.pumpAssistant, placeholder: messages.none, className: selectClassName, defaultValue: defaultPumpAssistantId, options: assistantOptions },
              ]}
            />
          </div>
        </div>
      )}
      <div className="flex items-center gap-3">
        <button type="submit" disabled={isPending} className={buttonClassName}>{messages.save}</button>
        <Link href={cancelHref} className={cancelClassName}>{messages.cancel}</Link>
      </div>
      {error && (
        <p role="alert" className="text-sm text-critical">
          {error}
        </p>
      )}
    </form>
  );
}
