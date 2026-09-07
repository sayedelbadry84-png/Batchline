-- PL-R5-P2-02, fifth production-lifecycle review — drum_return_check_
-- volume_bound (harden_production_lifecycle_round2) reads Trip.
-- batchTicketId without locking it, on the stated assumption that this
-- identity FK "never changes after creation". True of every current
-- application code path (confirmed read-only: no code updates Trip.
-- batchTicketId, DrumReturn.tripId, or WasteIncidentMemo.drumReturnId/
-- batchTicketId), but the database itself never enforced it — a direct
-- SQL/maintenance re-parent could still race a dependent-quantity update
-- and leave a return above its (new) owning ticket's volume, exactly the
-- kind of gap the Round-3 inverse triggers exist to close for other
-- fields.
--
-- Decision taken here (the review's own first option): these are
-- lifecycle IDENTITY links, not editable attributes — a Trip belongs to
-- the BatchTicket it was dispatched against for its whole life, a
-- DrumReturn belongs to the Trip that produced it, and a
-- WasteIncidentMemo belongs to the DrumReturn/BatchTicket that raised
-- it. Making them immutable after insert matches the business model
-- this whole review series has already assumed everywhere else, and is
-- far simpler and safer than building and testing an explicit
-- re-parenting workflow nothing in this app actually needs.
CREATE OR REPLACE FUNCTION trip_batch_ticket_immutable() RETURNS trigger AS $$
BEGIN
  IF NEW."batchTicketId" IS DISTINCT FROM OLD."batchTicketId" THEN
    RAISE EXCEPTION 'Trip.batchTicketId is immutable after creation';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER trip_batch_ticket_immutable_check
  BEFORE UPDATE ON "Trip"
  FOR EACH ROW EXECUTE FUNCTION trip_batch_ticket_immutable();

CREATE OR REPLACE FUNCTION drum_return_trip_immutable() RETURNS trigger AS $$
BEGIN
  IF NEW."tripId" IS DISTINCT FROM OLD."tripId" THEN
    RAISE EXCEPTION 'DrumReturn.tripId is immutable after creation';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER drum_return_trip_immutable_check
  BEFORE UPDATE ON "DrumReturn"
  FOR EACH ROW EXECUTE FUNCTION drum_return_trip_immutable();

CREATE OR REPLACE FUNCTION waste_incident_memo_identity_immutable() RETURNS trigger AS $$
BEGIN
  IF NEW."drumReturnId" IS DISTINCT FROM OLD."drumReturnId" OR NEW."batchTicketId" IS DISTINCT FROM OLD."batchTicketId" THEN
    RAISE EXCEPTION 'WasteIncidentMemo.drumReturnId/batchTicketId are immutable after creation';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER waste_incident_memo_identity_immutable_check
  BEFORE UPDATE ON "WasteIncidentMemo"
  FOR EACH ROW EXECUTE FUNCTION waste_incident_memo_identity_immutable();
