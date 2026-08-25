"use client";

import { useState } from "react";
import { SegmentedControl } from "./SegmentedControl";
import { PumpBookingRows } from "./PumpBookingRows";

type PumpOption = { id: string; code: string; reachM: number | null; defaultOperatorId: string | null; defaultAssistantId: string | null };
type CrewOption = { id: string; name: string };

// Delivery method (chute/pump), minimum pump reach, and the pump-booking
// rows all live together here because they share one piece of state: none
// of the pump fields make sense — or should be fillable — for a chute
// job. Kept as disabled fields rather than unmounted ones so switching
// back to Pump doesn't lose what was already filled in, and a disabled
// field is simply left out of the submitted FormData (see PumpBookingRows'
// own comment), so chute submissions stay pump-free with no server change.
export function DeliveryPumpSection({
  deliveryMethodLabel,
  chuteLabel,
  pumpLabel,
  minPumpReachLabel,
  minPumpReachPlaceholder,
  pumpSectionTitle,
  pumps,
  operators,
  assistants,
  pumpRowLabels,
  labelClassName,
  inputClassName,
}: {
  deliveryMethodLabel: string;
  chuteLabel: string;
  pumpLabel: string;
  minPumpReachLabel: string;
  minPumpReachPlaceholder?: string;
  pumpSectionTitle: string;
  pumps: PumpOption[];
  operators: CrewOption[];
  assistants: CrewOption[];
  pumpRowLabels: {
    pumpPlaceholder: string;
    operator: string;
    assistant: string;
    none: string;
    addAnother: string;
    remove: string;
    noCrewWarning: string;
  };
  labelClassName: string;
  inputClassName: string;
}) {
  const [method, setMethod] = useState("CHUTE");
  const isPump = method === "PUMP";

  return (
    <>
      <div>
        <label className={labelClassName}>{deliveryMethodLabel}</label>
        <SegmentedControl
          name="deliveryMethod"
          defaultValue="CHUTE"
          onValueChange={setMethod}
          options={[
            { value: "CHUTE", label: chuteLabel },
            { value: "PUMP", label: pumpLabel },
          ]}
        />
      </div>
      <div>
        <label className={labelClassName}>{minPumpReachLabel}</label>
        <input
          name="minPumpReachM"
          type="number"
          step="0.5"
          disabled={!isPump}
          placeholder={minPumpReachPlaceholder}
          className={`${inputClassName} disabled:opacity-50`}
        />
      </div>
      <div>
        <label className={labelClassName}>{pumpSectionTitle}</label>
        <PumpBookingRows pumps={pumps} operators={operators} assistants={assistants} labels={pumpRowLabels} disabled={!isPump} />
      </div>
    </>
  );
}
