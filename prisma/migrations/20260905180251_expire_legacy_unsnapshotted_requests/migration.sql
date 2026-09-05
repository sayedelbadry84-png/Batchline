-- A shortage-override request approved (or still pending) before the
-- shortageSnapshot column existed has no bound snapshot at all, so
-- completeBatchTicket's per-material allowance map built from it is
-- empty and can never actually authorize a shortage — leaving that
-- request stuck active forever (blocking a fresh, correctly-snapshotted
-- request via the one-active-per-ticket index) without ever being able
-- to do the one thing it exists for (BL-FU-P1-02, sixth review).
--
-- No rows in this database currently match (confirmed before writing
-- this migration), so this is a no-op here — added for correctness of
-- the upgrade path itself, in case this migration history is ever
-- replayed against a database that does have such rows (a restored
-- backup, a staging environment seeded before the snapshot feature).
-- Deliberately EXPIRED, not fabricated from current stock: a snapshot
-- invented now would not represent what an approver actually reviewed.
UPDATE "ShortageOverrideRequest"
SET "status" = 'EXPIRED'
WHERE "status" IN ('PENDING', 'APPROVED')
  AND "shortageSnapshot" IS NULL;
