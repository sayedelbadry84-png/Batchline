-- PL-R9-P1-03, ninth production-lifecycle review: the single shared
-- BatchComponentActual.version column (round 8) is checked/incremented
-- by TWO independent AutoSaveField instances per aggregate component —
-- one for actualMassKg, one for moisturePct — each holding its own
-- private currentVersion ref. A normal, non-concurrent sequential save
-- of both fields on one page load (save actual, then save moisture)
-- makes the second save's stale ref collide with the first save's own
-- increment, returning a false STALE_READING with no competing user or
-- device anywhere. Splitting into one version column per protected
-- field removes the false conflict entirely: an actual-field save can
-- never be made to look stale by a moisture-field save, or vice versa,
-- because each field's autosave now compares/increments only its own
-- column.
--
-- Backfilled from the existing shared column (not reset to 0) so a
-- browser tab already open with the old defaultVersion={c.version} at
-- the moment this migration deploys still sends a value that matches —
-- avoiding a wave of spurious STALE_READING on the very next autosave
-- after deploy, for either field.
ALTER TABLE "BatchComponentActual" ADD COLUMN "actualVersion" INTEGER NOT NULL DEFAULT 0;
ALTER TABLE "BatchComponentActual" ADD COLUMN "moistureVersion" INTEGER NOT NULL DEFAULT 0;

UPDATE "BatchComponentActual" SET "actualVersion" = "version", "moistureVersion" = "version";

ALTER TABLE "BatchComponentActual" DROP COLUMN "version";
