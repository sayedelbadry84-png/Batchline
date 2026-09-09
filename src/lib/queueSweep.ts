// PL-R12-P2-02, twelfth production-lifecycle review: the shared, truthful
// result shape for this app's two database-backed retry queues
// (PendingAutoRequisition, PendingBlobDeletion).
//
// Both sweeps previously reported only "attempted/succeeded" — and both
// counted success the moment the EXTERNAL work returned, with the
// database transition that actually removes the row swallowed by
// `.catch(() => {})`. A sweep that left every row it touched still
// sitting in the queue therefore reported a clean run, which is exactly
// how a stuck queue stays invisible.
//
// - claimed: rows this sweep took responsibility for.
// - resolved: rows whose work AND whose database transition both
//   committed. Nothing else counts as done.
// - busy: rows another processor held a live lease on (auto-requisition
//   only) — real, in-flight work owned elsewhere, never "finished".
// - externalFailed: the outside-world step (requisition/notify, blob
//   delete) failed; the row remains queued with backoff recorded.
// - bookkeepingFailed: the outside-world step succeeded (or its failure
//   was real) but the row could not be updated/removed to match. These
//   rows are the ones an operator must actually look at: the queue's
//   state no longer reflects reality.
// - deadLettered: total rows currently parked past the retry threshold,
//   awaiting a human (see the dead-letter operations view).
export type QueueSweepCounts = {
  claimed: number;
  resolved: number;
  busy: number;
  externalFailed: number;
  bookkeepingFailed: number;
  deadLettered: number;
};
