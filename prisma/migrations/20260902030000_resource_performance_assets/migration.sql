ALTER TABLE assets
  ADD COLUMN IF NOT EXISTS upload_status text NOT NULL DEFAULT 'ready',
  ADD COLUMN IF NOT EXISTS declared_size_bytes bigint,
  ADD COLUMN IF NOT EXISTS upload_expires_at timestamptz,
  ADD COLUMN IF NOT EXISTS upload_started_at timestamptz,
  ADD COLUMN IF NOT EXISTS uploaded_at timestamptz;

UPDATE assets
SET upload_status = 'ready',
    uploaded_at = COALESCE(uploaded_at, updated_at)
WHERE upload_status IS NULL OR upload_status NOT IN ('pending', 'uploading', 'failed', 'ready');

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'assets_upload_status_check'
      AND conrelid = 'assets'::regclass
  ) THEN
    ALTER TABLE assets
      ADD CONSTRAINT assets_upload_status_check
      CHECK (upload_status IN ('pending', 'uploading', 'failed', 'ready'));
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS assets_upload_cleanup_idx
  ON assets (upload_status, upload_expires_at, updated_at);
