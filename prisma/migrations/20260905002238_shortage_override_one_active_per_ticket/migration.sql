-- Enforces "at most one active (PENDING or APPROVED-unconsumed) shortage
-- override request per ticket" at the database level, the same
-- claim-via-constraint pattern InventoryMovement's own idempotency
-- constraint uses — application code checks first for a friendly typed
-- result (ALREADY_PENDING/ALREADY_APPROVED), but this is what actually
-- prevents two concurrent requests for the same ticket from both landing.
-- REJECTED/CONSUMED rows are excluded, so a new request can always be
-- made once the previous one is fully resolved.
CREATE UNIQUE INDEX "ShortageOverrideRequest_one_active_per_ticket"
  ON "ShortageOverrideRequest" ("batchTicketId")
  WHERE "status" IN ('PENDING', 'APPROVED');
