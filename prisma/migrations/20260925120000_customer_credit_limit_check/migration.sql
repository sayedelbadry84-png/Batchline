-- Customer.creditLimit gates every reservation (src/lib/creditPolicy.ts),
-- and the customer forms used to store whatever Number() made of the
-- input: "Infinity" (a limit no balance can reach, which switched the
-- credit check off for that customer), NaN, or a negative value. The
-- application now parses the field as money; this is the backstop.
--
-- Postgres orders NaN above every other float8, Infinity included, so
-- `< 'Infinity'` rejects both Infinity and NaN.
--
-- Preflight, not a silent repair: a customer already holding an invalid
-- limit stops the migration with the offending ids, because choosing the
-- replacement limit is a credit decision for a person, not for a
-- migration. To check ahead of deploying:
--   SELECT "id", "code", "legalName", "creditLimit" FROM "Customer"
--   WHERE NOT ("creditLimit" >= 0 AND "creditLimit" < 'Infinity'::float8);
DO $$
DECLARE
  bad TEXT;
BEGIN
  SELECT string_agg("id" || ' (' || "creditLimit"::text || ')', ', ')
    INTO bad
    FROM "Customer"
    WHERE NOT ("creditLimit" >= 0 AND "creditLimit" < 'Infinity'::float8);
  IF bad IS NOT NULL THEN
    RAISE EXCEPTION 'Customer rows with an invalid creditLimit must be corrected before this migration: %', bad;
  END IF;
END
$$;

ALTER TABLE "Customer" ADD CONSTRAINT "Customer_creditLimit_check"
    CHECK ("creditLimit" >= 0 AND "creditLimit" < 'Infinity'::float8);
