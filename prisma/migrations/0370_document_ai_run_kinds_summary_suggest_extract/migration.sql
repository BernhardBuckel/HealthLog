-- Two more kinds of background document AI run.
--
-- Summaries and filing suggestions can now run in the same background worker
-- as "Read with AI" and the lab scan (0366): the request queues the read and
-- answers 202, and the result is polled from the run. The synchronous routes
-- are unchanged; the new kinds only name the run.
--
-- Purely additive. `ADD VALUE IF NOT EXISTS` makes a rerun safe, and no new
-- value is used elsewhere in this migration, which is the one thing Postgres
-- forbids inside the transaction that adds it. No row is rewritten.
--
-- Reversibility: Postgres cannot drop an enum value, so the values would stay
-- (inert with no rows that carry them).
ALTER TYPE "document_ai_run_kind" ADD VALUE IF NOT EXISTS 'DOCUMENT_SUMMARY';
ALTER TYPE "document_ai_run_kind" ADD VALUE IF NOT EXISTS 'DOCUMENT_SUGGEST';
