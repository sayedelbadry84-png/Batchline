// BL-CR-P1-06, external-review validation (2026-09-10): the delivery
// note, quality-rejection supplement, purchase order and quotation pages
// render their stored values into editable <input defaultValue=...>
// fields, and nothing is ever written back. That is deliberate — an
// operator adjusts what prints for a particular hand-off — but it means a
// printed sheet can disagree with the system of record, its approval
// chain and its audit log, with no trace that it ever did.
//
// The decision taken (see the report's "Required decision"): these stay
// editable and are declared, on the page and on the print-out, to be
// worksheets rather than controlled documents. So the notice must NOT be
// no-print: printing is precisely when the disclaimer matters, because
// the sheet leaves the system and is read by someone who cannot see the
// database behind it.
//
// The alternative — immutable renderings of a versioned record, with
// corrections as audited amendments — remains the right answer for a
// genuinely controlled document, and is recorded as an accepted risk
// rather than closed.
export function UnofficialDocumentNotice({ label }: { label: string }) {
  return (
    <div
      role="note"
      className="rounded-lg border border-warn/40 bg-warn-soft px-3 py-2 text-center text-xs font-medium text-warn print:border print:border-black print:bg-transparent print:text-black"
    >
      {label}
    </div>
  );
}
