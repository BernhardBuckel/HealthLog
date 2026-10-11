-- Per-medication option to record each scheduled dose as taken without a
-- tap, the instant it was last switched on (no slot before it is filled),
-- and the marker on an intake the auto-take job recorded.
ALTER TABLE "medications" ADD COLUMN "auto_mark_taken" BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE "medications" ADD COLUMN "auto_mark_taken_since" TIMESTAMPTZ(6);
ALTER TABLE "medication_intake_events" ADD COLUMN "auto_recorded" BOOLEAN NOT NULL DEFAULT false;

