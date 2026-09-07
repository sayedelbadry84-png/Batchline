"use client";

import { useActionState } from "react";
import { startTrip } from "@/app/(app)/production/actions";
import { EquipmentAssignPicker } from "@/components/EquipmentAssignPicker";

type Option = { value: string; label: string };
type EquipmentOption = Option & { defaults: Record<string, string> };

export type StartTripMessages = {
  assignTitle: string;
  truck: string;
  selectTruck: string;
  driver: string;
  selectDriver: string;
  noTrucksAvailable: string;
  pumpDeliveryNote: string;
  pump: string;
  selectPump: string;
  pumpOperator: string;
  selectPumpOperator: string;
  pumpAssistant: string;
  none: string;
  minPumpReachNote: (m: number) => string;
  startTripButton: string;
  errors: Record<string, string>;
};

// Was a plain <form action={startTrip}> — every refusal (a busy truck, an
// out-of-scope plant after a concurrent transfer, a pump crew member
// already on another trip, ...) used to just silently do nothing
// (PL-R4-P2-02, fourth production-lifecycle review). useActionState now
// renders the actual typed reason startTripForTicket's own domain result
// carries.
export function StartTripForm({
  batchTicketId,
  returnTarget,
  isPumpDelivery,
  minPumpReachM,
  trucksAvailable,
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
}: {
  batchTicketId: string;
  // Where startTrip redirects on success (see parseTripReturnTarget/
  // tripReturnPath, src/lib/releaseRouting.ts) — "operator" for the
  // mobile operator ticket page, omitted (defaults to /trips) for the
  // desktop production detail page.
  returnTarget?: "operator";
  isPumpDelivery: boolean;
  minPumpReachM: number | null;
  trucksAvailable: boolean;
  truckOptions: EquipmentOption[];
  driverOptions: Option[];
  pumpOptions: EquipmentOption[];
  operatorOptions: Option[];
  assistantOptions: Option[];
  messages: StartTripMessages;
  cardClassName: string;
  titleClassName: string;
  selectClassName: string;
  buttonClassName: string;
}) {
  const [state, formAction, isPending] = useActionState(startTrip, null);
  const error = state && state.status !== "OK" ? (messages.errors[state.status] ?? state.status) : null;

  return (
    <form action={formAction} className={cardClassName}>
      <input type="hidden" name="batchTicketId" value={batchTicketId} />
      {returnTarget && <input type="hidden" name="returnTarget" value={returnTarget} />}
      <h2 className={titleClassName}>{messages.assignTitle}</h2>
      <div className="grid grid-cols-2 gap-3">
        <EquipmentAssignPicker
          equipment={{ name: "truckId", label: messages.truck, placeholder: messages.selectTruck, required: true, className: selectClassName, options: truckOptions }}
          dependents={[{ key: "driverId", name: "driverId", label: messages.driver, placeholder: messages.selectDriver, required: true, className: selectClassName, options: driverOptions }]}
        />
      </div>
      {!trucksAvailable && <p className="text-xs text-warn">{messages.noTrucksAvailable}</p>}
      {isPumpDelivery && (
        <div className="border-t border-border pt-3">
          <p className="mb-2 text-xs text-ink-muted">{messages.pumpDeliveryNote}</p>
          <div className="grid grid-cols-3 gap-3">
            <EquipmentAssignPicker
              equipment={{ name: "pumpId", label: messages.pump, placeholder: messages.selectPump, required: true, className: selectClassName, options: pumpOptions }}
              dependents={[
                { key: "pumpOperatorId", name: "pumpOperatorId", label: messages.pumpOperator, placeholder: messages.selectPumpOperator, required: true, className: selectClassName, options: operatorOptions },
                { key: "pumpAssistantId", name: "pumpAssistantId", label: messages.pumpAssistant, placeholder: messages.none, className: selectClassName, options: assistantOptions },
              ]}
            />
          </div>
          {minPumpReachM != null && <p className="mt-1 text-xs text-ink-muted">{messages.minPumpReachNote(minPumpReachM)}</p>}
        </div>
      )}
      <button type="submit" disabled={isPending} className={`${buttonClassName} self-start`}>
        {messages.startTripButton}
      </button>
      {error && (
        <p role="alert" className="text-sm text-critical">
          {error}
        </p>
      )}
    </form>
  );
}
