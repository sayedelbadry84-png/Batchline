-- Hand-written, same reasoning as the two prior hardening migrations.
-- PL-R3-P2-04, third production-lifecycle review: the cross-table
-- quantity-bound triggers added in the previous migration
-- (trip_check_volume_bounds, drum_return_check_volume_bound,
-- waste_memo_check_volume_bound) only ever protect the CHILD side — a
-- Trip/DrumReturn/WasteIncidentMemo can't be inserted or updated to
-- exceed its own parent's quantity, but nothing stopped the PARENT
-- quantity itself from later being lowered below an already-existing
-- child. No current application code path ever updates
-- BatchTicket.volumeM3 or DrumReturn.returnedVolumeM3 after creation
-- (confirmed by inspection), so this is a pure defensive backstop for a
-- direct SQL/maintenance write, not a fix for a reachable bug — but the
-- stated goal is an independent database invariant, not one that only
-- holds as long as the application never tries.
--
-- Each trigger only constrains a REDUCTION (NEW < OLD) — raising a
-- parent quantity is never a problem for its own children.

CREATE OR REPLACE FUNCTION batch_ticket_check_volume_lower_bound() RETURNS trigger AS $$
DECLARE
  max_child float8;
BEGIN
  IF NEW."volumeM3" >= OLD."volumeM3" THEN
    RETURN NEW;
  END IF;

  SELECT GREATEST(
    COALESCE((SELECT MAX(t."volumeDeliveredM3") FROM "Trip" t WHERE t."batchTicketId" = NEW.id), 0),
    COALESCE((SELECT MAX(t."reclaimedVolumeM3") FROM "Trip" t WHERE t."batchTicketId" = NEW.id), 0),
    COALESCE((SELECT MAX(dr."returnedVolumeM3") FROM "DrumReturn" dr JOIN "Trip" t ON t.id = dr."tripId" WHERE t."batchTicketId" = NEW.id), 0)
  ) INTO max_child;

  IF NEW."volumeM3" < max_child - 0.001 THEN
    RAISE EXCEPTION 'BatchTicket.volumeM3 cannot be reduced below % (an existing dependent Trip/DrumReturn quantity)', max_child;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER batch_ticket_volume_lower_bound_check
  BEFORE UPDATE ON "BatchTicket"
  FOR EACH ROW EXECUTE FUNCTION batch_ticket_check_volume_lower_bound();

CREATE OR REPLACE FUNCTION drum_return_check_volume_lower_bound() RETURNS trigger AS $$
DECLARE
  memo_volume float8;
BEGIN
  IF NEW."returnedVolumeM3" >= OLD."returnedVolumeM3" THEN
    RETURN NEW;
  END IF;

  SELECT wm."wastedVolumeM3" INTO memo_volume FROM "WasteIncidentMemo" wm WHERE wm."drumReturnId" = NEW.id;

  IF memo_volume IS NOT NULL AND NEW."returnedVolumeM3" < memo_volume - 0.001 THEN
    RAISE EXCEPTION 'DrumReturn.returnedVolumeM3 cannot be reduced below % (an existing WasteIncidentMemo.wastedVolumeM3)', memo_volume;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER drum_return_volume_lower_bound_check
  BEFORE UPDATE ON "DrumReturn"
  FOR EACH ROW EXECUTE FUNCTION drum_return_check_volume_lower_bound();
