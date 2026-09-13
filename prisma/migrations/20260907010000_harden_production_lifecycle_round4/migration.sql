-- PL-R4-P1-02, fourth production-lifecycle review — the child-side bound
-- triggers (trip_check_volume_bounds, drum_return_check_volume_bound,
-- waste_memo_check_volume_bound, all from the Round-2 migration) each
-- read the parent row's quantity with a plain SELECT, not a locking one.
-- The inverse parent-lowering triggers (batch_ticket_check_volume_lower_
-- bound, drum_return_check_volume_lower_bound, both from Round 3) are
-- fine as they are: the UPDATE statement that fires them already holds
-- an implicit row lock on the parent for the whole transaction. That
-- asymmetry is the bug — under plain READ COMMITTED, a transaction
-- lowering a parent's quantity and a transaction raising a child's
-- quantity above the parent's PRE-lowering value can each read a
-- pre-commit snapshot of the other side, both pass their own check, and
-- both commit, leaving the child's quantity above its (now-lower)
-- parent.
--
-- The fix is entirely on the child side: make each child-side trigger
-- take that same lock (SELECT ... FOR UPDATE) on the parent row before
-- comparing. A concurrent parent-lowering UPDATE already holds that
-- row's lock for its own transaction's duration, so the child-side
-- trigger's own locking read now genuinely waits for it to commit or
-- roll back, then re-reads the true post-commit parent value — the two
-- directions serialize on the shared parent row instead of racing.
-- Same function names, same triggers already attached from Round 2 — no
-- need to recreate the triggers themselves, only replace the function
-- bodies (same pattern as Round 2's own crew-collision trigger fix).
CREATE OR REPLACE FUNCTION trip_check_volume_bounds() RETURNS trigger AS $$
DECLARE
  ticket_volume float8;
BEGIN
  SELECT "volumeM3" INTO ticket_volume FROM "BatchTicket" WHERE id = NEW."batchTicketId" FOR UPDATE;
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

CREATE OR REPLACE FUNCTION drum_return_check_volume_bound() RETURNS trigger AS $$
DECLARE
  parent_ticket_id text;
  ticket_volume float8;
BEGIN
  -- Trip.batchTicketId never changes after creation, so this lookup
  -- itself needs no lock — only the BatchTicket row it resolves to does.
  SELECT t."batchTicketId" INTO parent_ticket_id FROM "Trip" t WHERE t.id = NEW."tripId";
  IF parent_ticket_id IS NULL THEN
    RETURN NEW;
  END IF;
  SELECT bt."volumeM3" INTO ticket_volume FROM "BatchTicket" bt WHERE bt.id = parent_ticket_id FOR UPDATE;
  IF ticket_volume IS NOT NULL AND NEW."returnedVolumeM3" > ticket_volume + 0.001 THEN
    RAISE EXCEPTION 'DrumReturn.returnedVolumeM3 (%) cannot exceed the trip ticket volume (%)', NEW."returnedVolumeM3", ticket_volume;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE OR REPLACE FUNCTION waste_memo_check_volume_bound() RETURNS trigger AS $$
DECLARE
  return_volume float8;
BEGIN
  SELECT "returnedVolumeM3" INTO return_volume FROM "DrumReturn" WHERE id = NEW."drumReturnId" FOR UPDATE;
  IF return_volume IS NOT NULL AND NEW."wastedVolumeM3" > return_volume + 0.001 THEN
    RAISE EXCEPTION 'WasteIncidentMemo.wastedVolumeM3 (%) cannot exceed its DrumReturn.returnedVolumeM3 (%)', NEW."wastedVolumeM3", return_volume;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
