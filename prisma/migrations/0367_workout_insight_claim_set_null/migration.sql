-- The per-workout insight claim is the ledger behind the daily insight cap.
-- It used to cascade with its workout, so deleting a workout freed the day's
-- slot and a delete-and-re-add loop could buy more paragraphs than the cap
-- allows. The claim now outlives the workout with a null `workout_id`; a
-- daily retention job drops rows older than a week. Idempotent: a re-run
-- finds the column already nullable and the constraint already re-created.
ALTER TABLE "workout_insight_generation_claims"
  ALTER COLUMN "workout_id" DROP NOT NULL;

ALTER TABLE "workout_insight_generation_claims"
  DROP CONSTRAINT IF EXISTS "workout_insight_generation_claims_workout_id_fkey";

ALTER TABLE "workout_insight_generation_claims"
  ADD CONSTRAINT "workout_insight_generation_claims_workout_id_fkey"
  FOREIGN KEY ("workout_id") REFERENCES "workouts"("id") ON DELETE SET NULL ON UPDATE CASCADE;
