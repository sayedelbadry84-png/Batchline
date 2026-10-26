-- Audit 2026-10-26 P1-B: how many stored money values are NOT a whole
-- number of minor units. READ ONLY: the whole run is one READ ONLY
-- transaction that is rolled back, and it prints counts only (no ids, no
-- names, no amounts). Run it before deciding whether any historical row
-- needs a correction; it changes nothing and proposes nothing.
--
--   psql -X -v ON_ERROR_STOP=1 -f scripts/audit-2026-10/fractional_money_readonly.sql "<db>"
--
-- A non-zero count is a candidate for an owner decision, never a row to
-- rewrite: a sent or ZATCA-cleared invoice, or a posted journal entry, is
-- corrected by a reviewed credit note or reversing entry, not an UPDATE.
\set ON_ERROR_STOP on
BEGIN TRANSACTION READ ONLY;
SELECT current_database() AS database, now() AS checked_at;
-- abs(x*100 - round(x*100)) > 1e-6 is the same test as isWholeMinorUnits.
SELECT 'Invoice' AS "table", 'subtotal/taxAmount/total' AS columns, COUNT(*) AS fractional_rows FROM "Invoice"
  WHERE abs("subtotal"*100 - round(("subtotal"*100)::numeric)::float8) > 1e-6
     OR abs("taxAmount"*100 - round(("taxAmount"*100)::numeric)::float8) > 1e-6
     OR abs("total"*100 - round(("total"*100)::numeric)::float8) > 1e-6
UNION ALL SELECT 'Invoice (ZATCA generated)', 'any of the above', COUNT(*) FROM "Invoice"
  WHERE "zatcaStatus" IS NOT NULL AND (
        abs("subtotal"*100 - round(("subtotal"*100)::numeric)::float8) > 1e-6
     OR abs("taxAmount"*100 - round(("taxAmount"*100)::numeric)::float8) > 1e-6
     OR abs("total"*100 - round(("total"*100)::numeric)::float8) > 1e-6)
UNION ALL SELECT 'InvoiceLine', 'lineTotal', COUNT(*) FROM "InvoiceLine"
  WHERE abs("lineTotal"*100 - round(("lineTotal"*100)::numeric)::float8) > 1e-6
UNION ALL SELECT 'JournalLine', 'debit/credit', COUNT(*) FROM "JournalLine"
  WHERE abs("debit"*100 - round(("debit"*100)::numeric)::float8) > 1e-6
     OR abs("credit"*100 - round(("credit"*100)::numeric)::float8) > 1e-6
UNION ALL SELECT 'Payment', 'amount', COUNT(*) FROM "Payment"
  WHERE abs("amount"*100 - round(("amount"*100)::numeric)::float8) > 1e-6
UNION ALL SELECT 'CreditNote', 'amount', COUNT(*) FROM "CreditNote"
  WHERE abs("amount"*100 - round(("amount"*100)::numeric)::float8) > 1e-6
UNION ALL SELECT 'CashTransaction', 'amount', COUNT(*) FROM "CashTransaction"
  WHERE abs("amount"*100 - round(("amount"*100)::numeric)::float8) > 1e-6
UNION ALL SELECT 'SupplierBill', 'subtotal/taxAmount/total', COUNT(*) FROM "SupplierBill"
  WHERE abs("subtotal"*100 - round(("subtotal"*100)::numeric)::float8) > 1e-6
     OR abs("taxAmount"*100 - round(("taxAmount"*100)::numeric)::float8) > 1e-6
     OR abs("total"*100 - round(("total"*100)::numeric)::float8) > 1e-6
UNION ALL SELECT 'SupplierPayment', 'amount', COUNT(*) FROM "SupplierPayment"
  WHERE abs("amount"*100 - round(("amount"*100)::numeric)::float8) > 1e-6
UNION ALL SELECT 'EndOfServiceSettlement (unpaid)', 'payableAmount', COUNT(*) FROM "EndOfServiceSettlement"
  WHERE "status" <> 'PAID' AND abs("payableAmount"*100 - round(("payableAmount"*100)::numeric)::float8) > 1e-6
UNION ALL SELECT 'PayrollLine', 'netPay/grossPay', COUNT(*) FROM "PayrollLine"
  WHERE abs("netPay"*100 - round(("netPay"*100)::numeric)::float8) > 1e-6
     OR abs("grossPay"*100 - round(("grossPay"*100)::numeric)::float8) > 1e-6;
-- Journal entries whose lines do not balance to the exact minor unit.
SELECT COUNT(*) AS unbalanced_journal_entries FROM (
  SELECT "journalEntryId" FROM "JournalLine" GROUP BY "journalEntryId"
  HAVING round((SUM("debit")*100)::numeric) <> round((SUM("credit")*100)::numeric)
) u;
ROLLBACK;
