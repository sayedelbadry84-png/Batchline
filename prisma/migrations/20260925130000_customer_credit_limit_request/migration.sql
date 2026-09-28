-- CustomerCreditLimitRequest: the only path by which Customer.creditLimit
-- goes up (see the model comment in schema.prisma and
-- src/lib/creditLimitRequests.ts). Additive: a new table, no change to any
-- existing row.
--
-- Hand-written for the CHECKs and the partial unique index, which Prisma
-- cannot express. The table part matches `prisma migrate diff` output.

CREATE TABLE "CustomerCreditLimitRequest" (
    "id" TEXT NOT NULL,
    "customerId" TEXT NOT NULL,
    "previousLimitMinor" BIGINT NOT NULL,
    "proposedLimitMinor" BIGINT NOT NULL,
    "reason" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'PENDING',
    "requestedById" TEXT NOT NULL,
    "requestedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "decidedById" TEXT,
    "decidedAt" TIMESTAMP(3),
    "decisionNote" TEXT,

    CONSTRAINT "CustomerCreditLimitRequest_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "CustomerCreditLimitRequest_customerId_requestedAt_idx" ON "CustomerCreditLimitRequest"("customerId", "requestedAt");

ALTER TABLE "CustomerCreditLimitRequest" ADD CONSTRAINT "CustomerCreditLimitRequest_customerId_fkey" FOREIGN KEY ("customerId") REFERENCES "Customer"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "CustomerCreditLimitRequest" ADD CONSTRAINT "CustomerCreditLimitRequest_requestedById_fkey" FOREIGN KEY ("requestedById") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "CustomerCreditLimitRequest" ADD CONSTRAINT "CustomerCreditLimitRequest_decidedById_fkey" FOREIGN KEY ("decidedById") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- One proposal in flight per customer. The application also serializes on
-- the Customer row lock; this is the backstop.
CREATE UNIQUE INDEX "CustomerCreditLimitRequest_one_pending_per_customer_key"
    ON "CustomerCreditLimitRequest"("customerId")
    WHERE "status" = 'PENDING';

ALTER TABLE "CustomerCreditLimitRequest" ADD CONSTRAINT "CustomerCreditLimitRequest_status_check"
    CHECK ("status" IN ('PENDING', 'APPROVED', 'REJECTED', 'STALE'));

-- A request is only ever for an increase, over a valid baseline.
ALTER TABLE "CustomerCreditLimitRequest" ADD CONSTRAINT "CustomerCreditLimitRequest_increase_check"
    CHECK ("previousLimitMinor" >= 0 AND "proposedLimitMinor" > "previousLimitMinor");

ALTER TABLE "CustomerCreditLimitRequest" ADD CONSTRAINT "CustomerCreditLimitRequest_reason_check"
    CHECK (length(btrim("reason")) > 0);

-- A PENDING or STALE row has no decider; an APPROVED or REJECTED row has
-- one, with a time, and it is never the requester (four-eyes, enforced
-- here as well as in the application).
ALTER TABLE "CustomerCreditLimitRequest" ADD CONSTRAINT "CustomerCreditLimitRequest_decision_check"
    CHECK (
      ("status" IN ('PENDING', 'STALE') AND "decidedById" IS NULL AND "decidedAt" IS NULL)
      OR ("status" IN ('APPROVED', 'REJECTED') AND "decidedById" IS NOT NULL AND "decidedAt" IS NOT NULL AND "decidedById" <> "requestedById")
    );
