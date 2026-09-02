ALTER TABLE "sessions"
  ADD COLUMN IF NOT EXISTS "previous_refresh_token_hash" text;

CREATE INDEX IF NOT EXISTS "sessions_previous_refresh_token_hash_idx"
  ON "sessions"("previous_refresh_token_hash");
