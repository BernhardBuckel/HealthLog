-- Document AI as background runs. A read that used to run inside the request
-- now runs in the worker; the request answers 202 with this row's id and the
-- client polls it. The row is a ticket: the input is cleared when the run
-- finishes and the row is deleted an hour later. Idempotent, so a re-run of a
-- half-applied migration converges.
DO $$ BEGIN
  CREATE TYPE "document_ai_run_kind" AS ENUM ('DOCUMENT_INDEX', 'LABS_OCR_EXTRACT');
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

DO $$ BEGIN
  CREATE TYPE "document_ai_run_status" AS ENUM ('QUEUED', 'RUNNING', 'SUCCEEDED', 'FAILED');
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

CREATE TABLE IF NOT EXISTS "document_ai_runs" (
  "id" TEXT NOT NULL,
  "user_id" TEXT NOT NULL,
  "kind" "document_ai_run_kind" NOT NULL,
  "document_id" TEXT,
  "status" "document_ai_run_status" NOT NULL DEFAULT 'QUEUED',
  "params_json" JSONB NOT NULL,
  "input_encrypted" BYTEA,
  "result_encrypted" BYTEA,
  "error_code" TEXT,
  "error_status" INTEGER,
  "error_message" TEXT,
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "started_at" TIMESTAMP(3),
  "finished_at" TIMESTAMP(3),
  "expires_at" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "document_ai_runs_pkey" PRIMARY KEY ("id")
);

CREATE INDEX IF NOT EXISTS "document_ai_runs_user_id_created_at_idx"
  ON "document_ai_runs" ("user_id", "created_at");
CREATE INDEX IF NOT EXISTS "document_ai_runs_document_id_kind_status_idx"
  ON "document_ai_runs" ("document_id", "kind", "status");
CREATE INDEX IF NOT EXISTS "document_ai_runs_status_expires_at_idx"
  ON "document_ai_runs" ("status", "expires_at");

DO $$ BEGIN
  ALTER TABLE "document_ai_runs"
    ADD CONSTRAINT "document_ai_runs_user_id_fkey"
    FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

DO $$ BEGIN
  ALTER TABLE "document_ai_runs"
    ADD CONSTRAINT "document_ai_runs_document_id_fkey"
    FOREIGN KEY ("document_id") REFERENCES "inbound_documents"("id") ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;
