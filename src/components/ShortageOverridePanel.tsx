"use client";

import { useActionState } from "react";
import {
  requestShortageOverride,
  approveShortageOverrideRequest,
  rejectShortageOverrideRequest,
  type RequestShortageOverrideActionState,
  type DecideShortageOverrideActionState,
} from "@/app/(app)/production/actions";

export type ShortageOverrideRequestStatus = "PENDING" | "APPROVED" | "REJECTED" | "CONSUMED";

export type LatestShortageOverrideRequest = {
  id: string;
  status: ShortageOverrideRequestStatus;
  reason: string;
  requestedByName: string;
  rejectionNote: string | null;
} | null;

export type ShortageOverridePanelMessages = {
  title: string;
  noneHint: string;
  requestedByPrefix: string;
  pendingStatus: string;
  approvedStatus: string;
  rejectedStatus: string;
  consumedStatus: string;
  requestLabel: string;
  requestPlaceholder: string;
  requestButton: string;
  approveButton: string;
  rejectButton: string;
  rejectionNoteLabel: string;
  rejectionNotePlaceholder: string;
  errorNotFound: string;
  errorTicketTerminal: string;
  errorAlreadyPending: string;
  errorAlreadyApproved: string;
  errorNotPending: string;
};

function requestErrorText(state: NonNullable<RequestShortageOverrideActionState>, m: ShortageOverridePanelMessages): string | null {
  switch (state.status) {
    case "OK":
      return null;
    case "NOT_FOUND":
      return m.errorNotFound;
    case "TICKET_TERMINAL":
      return m.errorTicketTerminal;
    case "ALREADY_PENDING":
      return m.errorAlreadyPending;
    case "ALREADY_APPROVED":
      return m.errorAlreadyApproved;
  }
}

function decisionErrorText(state: NonNullable<DecideShortageOverrideActionState>, m: ShortageOverridePanelMessages): string | null {
  switch (state.status) {
    case "OK":
      return null;
    case "NOT_FOUND":
      return m.errorNotFound;
    case "NOT_PENDING":
      return m.errorNotPending;
  }
}

// P1-04 — the request/approval workflow that replaced the old
// shortage-override note field on CompleteBatchForm. Rendered alongside
// that form on both the desk (production/[id]) and operator ticket views.
// canRequest/canDecide are resolved server-side from the viewer's own
// permissions (production.requestShortageOverride /
// approveShortageOverrideRequest / rejectShortageOverrideRequest) — this
// component trusts what it's given rather than re-deriving authorization
// client-side.
export function ShortageOverridePanel({
  ticketId,
  latestRequest,
  canRequest,
  canDecide,
  isTerminal,
  messages: m,
  cardClassName,
  titleClassName,
  hintClassName,
  labelClassName,
  inputClassName,
  buttonClassName,
  secondaryButtonClassName,
}: {
  ticketId: string;
  latestRequest: LatestShortageOverrideRequest;
  canRequest: boolean;
  canDecide: boolean;
  isTerminal: boolean;
  messages: ShortageOverridePanelMessages;
  cardClassName: string;
  titleClassName: string;
  hintClassName: string;
  labelClassName: string;
  inputClassName: string;
  buttonClassName: string;
  secondaryButtonClassName: string;
}) {
  const [requestState, requestAction, requestPending] = useActionState(requestShortageOverride, null);
  const [approveState, approveAction, approvePending] = useActionState(approveShortageOverrideRequest, null);
  const [rejectState, rejectAction, rejectPending] = useActionState(rejectShortageOverrideRequest, null);

  const hasActive = latestRequest?.status === "PENDING" || latestRequest?.status === "APPROVED";
  const showRequestForm = canRequest && !isTerminal && !hasActive;
  const showDecision = canDecide && latestRequest?.status === "PENDING";

  const statusLabel = latestRequest
    ? {
        PENDING: m.pendingStatus,
        APPROVED: m.approvedStatus,
        REJECTED: m.rejectedStatus,
        CONSUMED: m.consumedStatus,
      }[latestRequest.status]
    : null;

  if (!latestRequest && !showRequestForm) return null;

  return (
    <div className={cardClassName}>
      <h2 className={titleClassName}>{m.title}</h2>

      {latestRequest && (
        <div>
          <p className={hintClassName}>
            {statusLabel} — {m.requestedByPrefix} {latestRequest.requestedByName}
          </p>
          <p className={hintClassName}>{latestRequest.reason}</p>
          {latestRequest.status === "REJECTED" && latestRequest.rejectionNote && <p className={hintClassName}>{latestRequest.rejectionNote}</p>}
        </div>
      )}

      {!latestRequest && !hasActive && <p className={hintClassName}>{m.noneHint}</p>}

      {showRequestForm && (
        <form action={requestAction}>
          <input type="hidden" name="batchTicketId" value={ticketId} />
          <label className={labelClassName}>{m.requestLabel}</label>
          <textarea name="reason" rows={2} required placeholder={m.requestPlaceholder} className={inputClassName} />
          <button type="submit" disabled={requestPending} className={buttonClassName}>
            {m.requestButton}
          </button>
          {requestState && requestState.status !== "OK" && (
            <p role="alert" className="text-sm text-critical">
              {requestErrorText(requestState, m)}
            </p>
          )}
        </form>
      )}

      {showDecision && (
        <div className="flex flex-col gap-2">
          <form action={approveAction}>
            <input type="hidden" name="requestId" value={latestRequest!.id} />
            <button type="submit" disabled={approvePending} className={buttonClassName}>
              {m.approveButton}
            </button>
          </form>
          <form action={rejectAction} className="flex flex-col gap-1">
            <input type="hidden" name="requestId" value={latestRequest!.id} />
            <label className={labelClassName}>{m.rejectionNoteLabel}</label>
            <textarea name="rejectionNote" rows={2} required placeholder={m.rejectionNotePlaceholder} className={inputClassName} />
            <button type="submit" disabled={rejectPending} className={secondaryButtonClassName}>
              {m.rejectButton}
            </button>
          </form>
          {approveState && approveState.status !== "OK" && (
            <p role="alert" className="text-sm text-critical">
              {decisionErrorText(approveState, m)}
            </p>
          )}
          {rejectState && rejectState.status !== "OK" && (
            <p role="alert" className="text-sm text-critical">
              {decisionErrorText(rejectState, m)}
            </p>
          )}
        </div>
      )}
    </div>
  );
}
