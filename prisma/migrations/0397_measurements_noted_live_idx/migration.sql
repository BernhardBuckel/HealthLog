-- v1.42.2 — the record search reads the notes on readings newest first.
--
-- A record can hold millions of readings and a handful of notes. Without an
-- index that holds only the noted rows, the search walks the account's whole
-- `(user_id, measured_at)` range to find them. This partial index holds the
-- live rows that carry a note (the encrypted column, or the legacy plaintext
-- one the boot backfill has not migrated yet), so the read is the handful.
--
-- Additive only, no table rewrite, no data change. Non-concurrent for the
-- reason migration 0243 gives: Prisma Migrate runs a migration file in a
-- transaction, and the entrypoint applies migrations before the app serves
-- traffic. The predicate is tiny, so the build is short.
CREATE INDEX IF NOT EXISTS "measurements_noted_live_idx"
  ON "measurements" ("user_id", "measured_at" DESC, "id" DESC)
  WHERE "deleted_at" IS NULL
    AND ("notes_encrypted" IS NOT NULL OR "notes" IS NOT NULL);
