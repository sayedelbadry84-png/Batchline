"use client";

import { useRef, useState } from "react";
import { offlineQueue } from "@/lib/offlineQueue";

type Status = "idle" | "saving" | "saved" | "error" | "queued" | "rejected" | "storageError";

// A typed { status } result, not Promise<void> (PL-R6-P2-02, sixth
// production-lifecycle review) — treating ANY resolved promise as
// success meant a rejected business outcome (a ticket that went
// COMPLETE/CANCELLED mid-edit, a stale component id, an out-of-range
// value) showed the same green checkmark as a real save. Only "OK"
// counts as saved now; every other status renders a distinct visible
// rejection and — critically — never updates lastSaved, so the field
// still looks unsaved (correctly) rather than quietly "succeeding".
// `version`, present on a real OK, is PL-R8-P1-03's own optimistic-
// concurrency token — see currentVersion below.
type ActionResult = { status: string; version?: number };

// A plain uncontrolled input, still fully wired for any surrounding
// <form>'s own submit (name + defaultValue), that also fires its own
// single-field save on blur — so a value is persisted the instant it's
// entered rather than only when the whole screen's form gets submitted.
//
// offlineQueueKind is opt-in, not automatic: only pass it for an action
// that's genuinely safe to replay blindly on reconnect (an idempotent
// field overwrite, like a scale reading) — see src/lib/offlineQueue.ts
// for why actions that create a row or transition state never queue.
export function AutoSaveField({
  action,
  hiddenFields,
  valueField,
  name,
  type = "number",
  step,
  defaultValue,
  placeholder,
  disabled,
  className,
  offlineQueueKind,
  rejectedLabel,
  storageErrorLabel,
  defaultVersion,
}: {
  action: (formData: FormData) => Promise<ActionResult>;
  hiddenFields: Record<string, string>;
  valueField: string;
  name: string;
  type?: string;
  step?: string;
  defaultValue?: string | number;
  placeholder?: string;
  disabled?: boolean;
  className?: string;
  offlineQueueKind?: string;
  // Plain strings, not per-status functions — the same Server→Client
  // serialization rule PL-R5-P1-02 already fixed elsewhere applies here
  // too. Shown as a title/tooltip on the respective mark; a generic
  // message is enough since the specific reason is already logged
  // server-side (rejected) or is inherently browser-local (storage).
  rejectedLabel?: string;
  storageErrorLabel?: string;
  // PL-R8-P1-03, eighth production-lifecycle review: the row's own
  // version at the moment this page rendered — sent as `expectedVersion`
  // on every save. currentVersion (below) is what actually advances
  // between saves within this mounted instance's own lifetime, but the
  // server is always the real authority: a save whose expectedVersion no
  // longer matches (another tab, another device, a queued offline
  // replay that landed first) comes back STALE_READING and renders
  // through the exact same "rejected" path as any other refusal, never
  // silently applied over a value this instance never actually saw.
  defaultVersion?: number;
}) {
  const [status, setStatus] = useState<Status>("idle");
  const lastSaved = useRef(defaultValue != null ? String(defaultValue) : "");
  const currentVersion = useRef(defaultVersion ?? 0);
  // PL-R7-P2-01, seventh production-lifecycle review: two overlapping
  // saves for the SAME field (a slow connection, two blurs close
  // together) used to each start their own independent Server Action
  // call with no ordering guarantee — if the first blur's save happened
  // to resolve AFTER the second's, its stale value could land in the
  // database last, and its stale response could regress the displayed
  // state back over a newer one already shown. inFlight + pendingValue
  // serialize saves for this one field: a blur that arrives while a save
  // is already in flight never starts a second concurrent request — it
  // just records the newest value, which the in-flight save's own
  // completion handler picks up and sends next. Requests for this field
  // are therefore always issued (and so always land) in the same order
  // the operator actually typed them, and only the truly latest value is
  // ever the last one sent.
  const inFlight = useRef(false);
  const pendingValue = useRef<string | null>(null);

  async function performSave(value: string) {
    inFlight.current = true;
    setStatus("saving");
    const fields = { ...hiddenFields, [valueField]: value, expectedVersion: String(currentVersion.current) };
    const fd = new FormData();
    for (const [k, v] of Object.entries(fields)) fd.set(k, v);

    try {
      const result = await action(fd);
      if (result.status === "OK") {
        lastSaved.current = value;
        if (typeof result.version === "number") currentVersion.current = result.version;
        setStatus("saved");
        setTimeout(() => setStatus((s) => (s === "saved" ? "idle" : s)), 1500);
      } else {
        // A genuine business rejection, not a network failure — never
        // queued (queuing would just retry the same rejection forever
        // once back online) and lastSaved stays exactly what it was, so
        // this field keeps looking unsaved.
        setStatus("rejected");
      }
    } catch {
      if (offlineQueueKind) {
        const enqueued = await offlineQueue.enqueue(offlineQueueKind, fields);
        if (enqueued.status === "OK") {
          lastSaved.current = value;
          setStatus("queued");
        } else {
          // PL-R7-P1-02: persistence genuinely failed (quota exceeded,
          // storage blocked) — must never claim "queued" for a value
          // that has no durable copy anywhere. lastSaved stays
          // unchanged so the field keeps looking unsaved.
          setStatus("storageError");
        }
      } else {
        setStatus("error");
      }
    } finally {
      inFlight.current = false;
      const next = pendingValue.current;
      pendingValue.current = null;
      if (next !== null && next !== lastSaved.current) {
        // Fire-and-forget on purpose — this is the SAME coalescing chain
        // handleBlur itself starts, just continuing it for the value
        // that arrived while this save was still in flight.
        void performSave(next);
      }
    }
  }

  async function handleBlur(e: React.FocusEvent<HTMLInputElement>) {
    const value = e.target.value;
    if (value === "" || value === lastSaved.current) return;

    if (offlineQueueKind && typeof navigator !== "undefined" && !navigator.onLine) {
      const fields = { ...hiddenFields, [valueField]: value, expectedVersion: String(currentVersion.current) };
      const enqueued = await offlineQueue.enqueue(offlineQueueKind, fields);
      if (enqueued.status === "OK") {
        lastSaved.current = value;
        setStatus("queued");
      } else {
        setStatus("storageError");
      }
      return;
    }

    if (inFlight.current) {
      pendingValue.current = value;
      return;
    }
    void performSave(value);
  }

  return (
    <span className="inline-flex items-center gap-1">
      <input
        name={name}
        type={type}
        step={step}
        defaultValue={defaultValue}
        placeholder={placeholder}
        disabled={disabled}
        onBlur={handleBlur}
        className={className}
      />
      <span className="w-3 shrink-0 font-mono text-xs">
        {status === "saving" && <span className="text-ink-faint">…</span>}
        {status === "saved" && <span className="text-good">✓</span>}
        {status === "error" && <span className="text-critical">!</span>}
        {status === "queued" && <span className="text-warn">⏳</span>}
        {status === "rejected" && (
          <span role="alert" className="text-critical" title={rejectedLabel}>
            ✕
          </span>
        )}
        {status === "storageError" && (
          <span role="alert" className="text-critical" title={storageErrorLabel}>
            ⚠
          </span>
        )}
      </span>
    </span>
  );
}
