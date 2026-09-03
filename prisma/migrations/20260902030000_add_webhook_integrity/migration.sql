CREATE TABLE "webhook_events" (
  "id" uuid NOT NULL DEFAULT gen_random_uuid(),
  "provider" text NOT NULL,
  "event_id" text NOT NULL,
  "event_id_source" text NOT NULL,
  "event_type" text NOT NULL,
  "payload" jsonb NOT NULL,
  "payload_sha256" text NOT NULL,
  "status" text NOT NULL DEFAULT 'processing',
  "attempts" integer NOT NULL DEFAULT 1,
  "last_error" text,
  "received_at" timestamptz(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "processed_at" timestamptz(6),
  "updated_at" timestamptz(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT "webhook_events_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "webhook_events_provider_event_id_key" ON "webhook_events"("provider", "event_id");
CREATE INDEX "webhook_events_status_updated_at_idx" ON "webhook_events"("status", "updated_at");
