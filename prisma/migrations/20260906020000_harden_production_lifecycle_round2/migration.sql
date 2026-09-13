-- Hand-written, same reasoning as 20260906010000_harden_production_
-- lifecycle_invariants. PL-R2-P2-04/P2-05, second production-lifecycle
-- review. Preflighted against the real database first — every check
-- below currently matches zero existing/violating rows.

-- ---------------------------------------------------------------------
-- PL-R2-P2-04 — a return reason is mandatory for every returned
-- quantity (the owner's own Round 1 default) — the domain now enforces
-- this (src/lib/tripLifecycle.ts), and the database backstops it too.
-- The existing CHECK constraint (DrumReturn_reasonCode_check, from the
-- prior migration) already restricts a non-null value to the allow-
-- list; NOT NULL is additive, not a replacement for it.
-- ---------------------------------------------------------------------
ALTER TABLE "DrumReturn" ALTER COLUMN "reasonCode" SET NOT NULL;

-- ---------------------------------------------------------------------
-- PL-R2-P1-02 — WasteIncidentMemo needs a real denial state so a
-- suspected rejection Quality finds unfounded can actually be resolved
-- (previously PENDING was the only reachable non-APPROVED state). The
-- prior migration's own CHECK only allowed PENDING/APPROVED; replacing
-- it here (a new migration altering a constraint from an earlier one is
-- the normal forward-only path — the rule is never editing an already-
-- applied migration FILE, not that a constraint can never change again).
-- ---------------------------------------------------------------------
ALTER TABLE "WasteIncidentMemo" DROP CONSTRAINT "WasteIncidentMemo_status_check";
ALTER TABLE "WasteIncidentMemo" ADD CONSTRAINT "WasteIncidentMemo_status_check"
  CHECK (status IN ('PENDING', 'APPROVED', 'REJECTED'));

-- ---------------------------------------------------------------------
-- PL-R2-P2-05 — moisturePct had no database range check at all.
-- ---------------------------------------------------------------------
ALTER TABLE "BatchComponentActual" ADD CONSTRAINT "BatchComponentActual_moisturePct_range"
  CHECK ("moisturePct" IS NULL OR ("moisturePct" >= 0 AND "moisturePct" <= 100));

-- ---------------------------------------------------------------------
-- PL-R2-P2-05 — cross-table quantity bounds the prior migration's plain
-- CHECK constraints couldn't express (a CHECK can only see its own row).
-- Each is a constraint trigger's less strict cousin — a plain BEFORE
-- trigger is enough here since none of these need to be deferrable (the
-- referenced parent row — BatchTicket for a Trip, Trip for a DrumReturn,
-- DrumReturn for a WasteIncidentMemo — always already exists by the time
-- a child row referencing it is written in every real code path). A
-- small epsilon (0.001) absorbs floating-point rounding, not a real
-- business tolerance.
-- ---------------------------------------------------------------------
CREATE OR REPLACE FUNCTION trip_check_volume_bounds() RETURNS trigger AS $$
DECLARE
  ticket_volume float8;
BEGIN
  SELECT "volumeM3" INTO ticket_volume FROM "BatchTicket" WHERE id = NEW."batchTicketId";
  IF ticket_volume IS NULL THEN
    RETURN NEW;
  END IF;
  IF NEW."volumeDeliveredM3" IS NOT NULL AND NEW."volumeDeliveredM3" > ticket_volume + 0.001 THEN
    RAISE EXCEPTION 'Trip.volumeDeliveredM3 (%) cannot exceed its own BatchTicket.volumeM3 (%)', NEW."volumeDeliveredM3", ticket_volume;
  END IF;
  IF NEW."reclaimedVolumeM3" IS NOT NULL AND NEW."reclaimedVolumeM3" > ticket_volume + 0.001 THEN
    RAISE EXCEPTION 'Trip.reclaimedVolumeM3 (%) cannot exceed its own BatchTicket.volumeM3 (%)', NEW."reclaimedVolumeM3", ticket_volume;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER trip_volume_bounds_check
  BEFORE INSERT OR UPDATE ON "Trip"
  FOR EACH ROW EXECUTE FUNCTION trip_check_volume_bounds();

CREATE OR REPLACE FUNCTION drum_return_check_volume_bound() RETURNS trigger AS $$
DECLARE
  ticket_volume float8;
BEGIN
  SELECT bt."volumeM3" INTO ticket_volume FROM "Trip" t JOIN "BatchTicket" bt ON bt.id = t."batchTicketId" WHERE t.id = NEW."tripId";
  IF ticket_volume IS NOT NULL AND NEW."returnedVolumeM3" > ticket_volume + 0.001 THEN
    RAISE EXCEPTION 'DrumReturn.returnedVolumeM3 (%) cannot exceed the trip ticket volume (%)', NEW."returnedVolumeM3", ticket_volume;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER drum_return_volume_bound_check
  BEFORE INSERT OR UPDATE ON "DrumReturn"
  FOR EACH ROW EXECUTE FUNCTION drum_return_check_volume_bound();

CREATE OR REPLACE FUNCTION waste_memo_check_volume_bound() RETURNS trigger AS $$
DECLARE
  return_volume float8;
BEGIN
  SELECT "returnedVolumeM3" INTO return_volume FROM "DrumReturn" WHERE id = NEW."drumReturnId";
  IF return_volume IS NOT NULL AND NEW."wastedVolumeM3" > return_volume + 0.001 THEN
    RAISE EXCEPTION 'WasteIncidentMemo.wastedVolumeM3 (%) cannot exceed its DrumReturn.returnedVolumeM3 (%)', NEW."wastedVolumeM3", return_volume;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER waste_memo_volume_bound_check
  BEFORE INSERT OR UPDATE ON "WasteIncidentMemo"
  FOR EACH ROW EXECUTE FUNCTION waste_memo_check_volume_bound();

-- ---------------------------------------------------------------------
-- PL-R2-P2-05 — the cross-column pump-crew collision trigger (added in
-- the prior migration) only ever performed a plain EXISTS read with no
-- lock of its own, explicitly relying on every caller using Serializable
-- isolation for that read to be safe against a genuinely concurrent
-- insert — its own comment said so. That is not an independent database
-- backstop: two default-isolation (READ COMMITTED) connections can both
-- observe no conflicting Trip and both insert. Replacing the function
-- body (same function name, same trigger already attached — no need to
-- recreate the trigger itself) to take transaction-scoped advisory locks
-- on every involved crew id, sorted, BEFORE the EXISTS checks — this
-- makes the check correct under ANY isolation level, not just
-- Serializable, and is released automatically at commit or rollback.
-- ---------------------------------------------------------------------
CREATE OR REPLACE FUNCTION trip_check_pump_crew_collision() RETURNS trigger AS $$
DECLARE
  crew_ids text[];
  cid text;
BEGIN
  IF NEW.status = 'CLOSED' THEN
    RETURN NEW;
  END IF;

  crew_ids := ARRAY[]::text[];
  IF NEW."pumpOperatorId" IS NOT NULL THEN crew_ids := array_append(crew_ids, NEW."pumpOperatorId"); END IF;
  IF NEW."pumpAssistantId" IS NOT NULL THEN crew_ids := array_append(crew_ids, NEW."pumpAssistantId"); END IF;
  IF array_length(crew_ids, 1) IS NULL THEN
    RETURN NEW;
  END IF;
  crew_ids := ARRAY(SELECT unnest(crew_ids) ORDER BY 1);

  FOREACH cid IN ARRAY crew_ids LOOP
    PERFORM pg_advisory_xact_lock(hashtext('pumpcrew:' || cid));
  END LOOP;

  IF NEW."pumpOperatorId" IS NOT NULL AND EXISTS (
    SELECT 1 FROM "Trip"
    WHERE id <> NEW.id AND status <> 'CLOSED'
      AND ("pumpOperatorId" = NEW."pumpOperatorId" OR "pumpAssistantId" = NEW."pumpOperatorId")
  ) THEN
    RAISE EXCEPTION 'Pump crew member % is already the operator or assistant on another open trip', NEW."pumpOperatorId";
  END IF;
  IF NEW."pumpAssistantId" IS NOT NULL AND EXISTS (
    SELECT 1 FROM "Trip"
    WHERE id <> NEW.id AND status <> 'CLOSED'
      AND ("pumpOperatorId" = NEW."pumpAssistantId" OR "pumpAssistantId" = NEW."pumpAssistantId")
  ) THEN
    RAISE EXCEPTION 'Pump crew member % is already the operator or assistant on another open trip', NEW."pumpAssistantId";
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
