-- Person-defined symptoms and their timestamped events. A definition is the
-- person's own name for a symptom (encrypted); an event is one occurrence with
-- a 0-10 intensity and an optional link to an illness episode. Idempotent, so
-- a re-run of a half-applied migration converges.
CREATE TABLE IF NOT EXISTS "symptom_definitions" (
  "id" TEXT NOT NULL,
  "user_id" TEXT NOT NULL,
  "label_encrypted" BYTEA NOT NULL,
  "icon" TEXT,
  "sort_order" INTEGER NOT NULL DEFAULT 0,
  "is_active" BOOLEAN NOT NULL DEFAULT true,
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "symptom_definitions_pkey" PRIMARY KEY ("id")
);

CREATE INDEX IF NOT EXISTS "symptom_definitions_user_id_sort_order_idx"
  ON "symptom_definitions" ("user_id", "sort_order");

DO $$ BEGIN
  ALTER TABLE "symptom_definitions"
    ADD CONSTRAINT "symptom_definitions_user_id_fkey"
    FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

CREATE TABLE IF NOT EXISTS "symptom_events" (
  "id" TEXT NOT NULL,
  "user_id" TEXT NOT NULL,
  "definition_id" TEXT NOT NULL,
  "occurred_at" TIMESTAMP(3) NOT NULL,
  "intensity" INTEGER NOT NULL,
  "note_encrypted" BYTEA,
  "episode_id" TEXT,
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "symptom_events_pkey" PRIMARY KEY ("id")
);

CREATE INDEX IF NOT EXISTS "symptom_events_user_id_occurred_at_idx"
  ON "symptom_events" ("user_id", "occurred_at");
CREATE INDEX IF NOT EXISTS "symptom_events_definition_id_occurred_at_idx"
  ON "symptom_events" ("definition_id", "occurred_at");
CREATE INDEX IF NOT EXISTS "symptom_events_episode_id_idx"
  ON "symptom_events" ("episode_id");

DO $$ BEGIN
  ALTER TABLE "symptom_events"
    ADD CONSTRAINT "symptom_events_intensity_check"
    CHECK ("intensity" >= 0 AND "intensity" <= 10);
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

DO $$ BEGIN
  ALTER TABLE "symptom_events"
    ADD CONSTRAINT "symptom_events_user_id_fkey"
    FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

DO $$ BEGIN
  ALTER TABLE "symptom_events"
    ADD CONSTRAINT "symptom_events_definition_id_fkey"
    FOREIGN KEY ("definition_id") REFERENCES "symptom_definitions"("id") ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

DO $$ BEGIN
  ALTER TABLE "symptom_events"
    ADD CONSTRAINT "symptom_events_episode_id_fkey"
    FOREIGN KEY ("episode_id") REFERENCES "illness_episodes"("id") ON DELETE SET NULL ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;
