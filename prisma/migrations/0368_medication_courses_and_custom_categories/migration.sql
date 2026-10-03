-- Medication categories: adopt the side table into the schema.
--
-- `medication_categories` used to be created by the app at runtime (migration
-- 0004 had dropped it as orphaned and the app recreated it on first use). It
-- is now a Prisma model. The DDL below is identical to what the runtime
-- helper ran, and Postgres gives the unnamed primary key, foreign key and
-- index the same names Prisma expects, so a database that already holds the
-- runtime table keeps it untouched and every row in it; a fresh database gets
-- the same table. Idempotent.
CREATE TABLE IF NOT EXISTS "medication_categories" (
  "medication_id" TEXT NOT NULL,
  "category" TEXT NOT NULL DEFAULT 'OTHER',
  "updated_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "medication_categories_pkey" PRIMARY KEY ("medication_id"),
  CONSTRAINT "medication_categories_medication_id_fkey"
    FOREIGN KEY ("medication_id") REFERENCES "medications"("id") ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS "medication_categories_category_idx"
  ON "medication_categories"("category");
