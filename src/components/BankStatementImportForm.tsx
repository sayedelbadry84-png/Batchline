"use client";

import { useActionState } from "react";
import { importBankStatement, type ImportBankStatementState, type BankStatementRowError } from "@/app/(app)/finance/actions";
import { createDateFormatters } from "@/lib/datetime";

export type BankStatementImportMessages = {
  site: string;
  file: string;
  button: string;
  pending: string;
  imported: string;
  alreadyImported: string;
  needsReviewLegacy: string;
  needsReviewDifferentBytes: string;
  noLines: string;
  invalidRequest: string;
  failed: string;
  rowErrorsTitle: string;
  rowErrorsMore: string;
  rowBadDate: string;
  rowBadAmount: string;
};

type Action = (prev: ImportBankStatementState, formData: FormData) => Promise<ImportBankStatementState>;

// Dictionary strings carry {name} placeholders rather than being functions,
// because they cross the server/client boundary as props.
function fill(template: string, values: Record<string, string | number>): string {
  return template.replace(/\{(\w+)\}/g, (whole, key: string) => (key in values ? String(values[key]) : whole));
}

function summary(state: NonNullable<ImportBankStatementState>, m: BankStatementImportMessages, date: (iso: string) => string): string {
  switch (state.status) {
    case "IMPORTED":
      return fill(m.imported, { lines: state.lineCount, matched: state.matchedCount });
    case "ALREADY_IMPORTED":
      return fill(m.alreadyImported, { date: date(state.importedAt) });
    case "NEEDS_REVIEW":
      return fill(state.earlierIdentity === "LEGACY_TEXT" ? m.needsReviewLegacy : m.needsReviewDifferentBytes, { date: date(state.importedAt) });
    case "NO_LINES":
      return m.noLines;
    case "INVALID_REQUEST":
      return m.invalidRequest;
    case "FAILED":
      return m.failed;
    default:
      // A status added to the action later must still say something: an
      // empty result is exactly the silent reload this form replaced.
      return m.failed;
  }
}

function rowErrorText(e: BankStatementRowError, m: BankStatementImportMessages): string {
  return fill(e.code === "BAD_DATE" ? m.rowBadDate : m.rowBadAmount, { row: e.row, value: e.value });
}

// The upload form for a bank statement. importBankStatement used to return
// void, so a repeat upload, an unreadable file and a successful import all
// looked the same: the page reloaded. Every outcome now renders here; only
// IMPORTED is presented as a success, and a statement that needs a human
// comparison says so rather than reading as either a duplicate or an import.
export function BankStatementImportForm({
  sites,
  messages,
  timeZone,
  classNames,
  action = importBankStatement,
}: {
  sites: { id: string; code: string; name: string }[];
  messages: BankStatementImportMessages;
  timeZone: string;
  classNames: { label: string; select: string; input: string; button: string };
  action?: Action;
}) {
  const [state, formAction, isPending] = useActionState(action, null);
  const dt = createDateFormatters(timeZone);
  const text = state ? summary(state, messages, (iso) => dt.dateTime(iso)) : null;
  const rowErrors = state && (state.status === "IMPORTED" || state.status === "NO_LINES") ? state : null;
  const ok = state?.status === "IMPORTED";

  return (
    <div>
      <form action={formAction} className="flex flex-wrap items-end gap-3">
        <div>
          <label htmlFor="bank-statement-site" className={classNames.label}>{messages.site}</label>
          <select id="bank-statement-site" name="siteId" required className={classNames.select} defaultValue={sites.length === 1 ? sites[0].id : ""}>
            <option value="" disabled>—</option>
            {sites.map((s) => (
              <option key={s.id} value={s.id}>{s.code} — {s.name}</option>
            ))}
          </select>
        </div>
        <div>
          <label htmlFor="bank-statement-file" className={classNames.label}>{messages.file}</label>
          <input id="bank-statement-file" name="file" type="file" accept=".csv,text/csv" required className={classNames.input} />
        </div>
        <button type="submit" disabled={isPending} className={classNames.button}>
          {isPending ? messages.pending : messages.button}
        </button>
      </form>
      {text && (
        <div
          role={ok ? "status" : "alert"}
          data-status={state?.status}
          className={`mt-3 rounded-md border px-3 py-2 text-sm ${ok ? "border-good/40 bg-good-soft text-good" : "border-critical/40 bg-critical-soft text-critical"}`}
        >
          <p>{text}</p>
          {rowErrors && rowErrors.rowErrorCount > 0 && (
            <div className="mt-2 text-ink">
              <p>{fill(messages.rowErrorsTitle, { count: rowErrors.rowErrorCount })}</p>
              <ul className="list-disc ps-5">
                {rowErrors.rowErrors.map((e) => (
                  <li key={e.row} dir="auto">{rowErrorText(e, messages)}</li>
                ))}
              </ul>
              {rowErrors.rowErrorCount > rowErrors.rowErrors.length && (
                <p>{fill(messages.rowErrorsMore, { count: rowErrors.rowErrorCount - rowErrors.rowErrors.length })}</p>
              )}
            </div>
          )}
        </div>
      )}
    </div>
  );
}
