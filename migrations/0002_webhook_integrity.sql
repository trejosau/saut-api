CREATE TABLE IF NOT EXISTS webhook_events (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  provider text NOT NULL,
  event_id text NOT NULL,
  event_id_source text NOT NULL,
  event_type text NOT NULL,
  payload jsonb NOT NULL,
  payload_sha256 text NOT NULL,
  status text NOT NULL DEFAULT 'processing',
  attempts integer NOT NULL DEFAULT 1,
  last_error text,
  received_at timestamptz NOT NULL DEFAULT now(),
  processed_at timestamptz,
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(provider, event_id)
);
CREATE INDEX IF NOT EXISTS webhook_events_status_idx ON webhook_events(status, updated_at);
