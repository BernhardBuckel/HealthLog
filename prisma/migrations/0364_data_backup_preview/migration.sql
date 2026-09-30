-- What the restore preview shows for a stored backup, worked out while the
-- copy is written, so the preview no longer reads the whole copy inside a web
-- request. Nullable: a copy written before this release has none until its
-- first preview has read it once.
ALTER TABLE "data_backups" ADD COLUMN IF NOT EXISTS "preview" JSONB;
