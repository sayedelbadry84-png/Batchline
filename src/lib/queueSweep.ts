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
// - busy: rows this sweep CLAIMED and then could not take, because
//   another processor held a live lease on them (auto-requisition only)
//   — real, in-flight work owned elsewhere, never "finished".
//   PL-R15-P1-01, fifteenth production-lifecycle review: this counter is
//   deliberately NOT "every row someone else is working on". A row whose
//   owner is mid-transaction is ROW-LOCKED, and the claim query
//   (claimEligiblePendingAutoRequisitions) uses FOR UPDATE SKIP LOCKED,
//   so such a row is excluded before selection: it is not claimed, not
//   processed, and appears in NO counter this sweep returns. `busy`
//   therefore only ever covers the narrower race where the claim
//   succeeded — the row was not locked at select time — and the lease
//   turned out to belong to someone else by the time it was processed.
//   A sweep reporting claimed: 0 across the board is the normal, correct
//   result while another worker is actively holding the only queued row.
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
