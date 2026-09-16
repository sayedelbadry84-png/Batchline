-- Payment record on a payroll run: who marked it paid and the transfer
-- reference. Both nullable — runs paid before this migration have neither,
-- and inventing a value for them would be worse than showing it absent.
ALTER TABLE "PayrollRun" ADD COLUMN "paidById" TEXT;
ALTER TABLE "PayrollRun" ADD COLUMN "paymentReference" TEXT;
ALTER TABLE "PayrollRun" ADD CONSTRAINT "PayrollRun_paidById_fkey" FOREIGN KEY ("paidById") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;
