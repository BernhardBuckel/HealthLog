-- The encryption key backup step and the boot check that the configured key
-- opens this database.
--
-- Four nullable columns on the instance settings row record which key the
-- operator confirmed a backup of (id and fingerprint, never the key). The
-- canary table holds one known plaintext per key id, sealed under that key; a
-- process whose key cannot open it refuses to serve. Both are written at
-- runtime, so the migration only creates the shapes.
ALTER TABLE "app_settings" ADD COLUMN IF NOT EXISTS "encryption_key_backup_confirmed_at" TIMESTAMP(3);
ALTER TABLE "app_settings" ADD COLUMN IF NOT EXISTS "encryption_key_backup_confirmed_key_id" TEXT;
ALTER TABLE "app_settings" ADD COLUMN IF NOT EXISTS "encryption_key_backup_confirmed_fingerprint" TEXT;
ALTER TABLE "app_settings" ADD COLUMN IF NOT EXISTS "encryption_key_backup_confirmed_by_user_id" TEXT;

CREATE TABLE IF NOT EXISTS "encryption_key_canaries" (
    "key_id" TEXT NOT NULL,
    "ciphertext" TEXT NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "encryption_key_canaries_pkey" PRIMARY KEY ("key_id")
);
