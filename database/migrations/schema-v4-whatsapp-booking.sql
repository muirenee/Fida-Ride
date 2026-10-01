-- Fida-Ride schema v4: durable WhatsApp booking inbox and ride-source idempotency.
BEGIN;

ALTER TABLE core.trips
    ADD COLUMN IF NOT EXISTS source_channel VARCHAR(32),
    ADD COLUMN IF NOT EXISTS source_request_id VARCHAR(255);

CREATE UNIQUE INDEX IF NOT EXISTS uq_trips_source_request
    ON core.trips (source_channel, source_request_id)
    WHERE source_channel IS NOT NULL
      AND source_request_id IS NOT NULL;

CREATE TABLE IF NOT EXISTS core.whatsapp_inbox (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    message_id VARCHAR(255) NOT NULL UNIQUE,
    sender_phone VARCHAR(32) NOT NULL,
    message_type VARCHAR(32) NOT NULL,
    message_text TEXT,
    location_lat DOUBLE PRECISION,
    location_lng DOUBLE PRECISION,
    location_name TEXT,
    location_address TEXT,
    raw_payload JSONB NOT NULL,
    status VARCHAR(16) NOT NULL DEFAULT 'pending'
        CHECK (status IN ('pending', 'processing', 'completed', 'failed')),
    attempts INTEGER NOT NULL DEFAULT 0 CHECK (attempts >= 0),
    next_attempt_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    locked_at TIMESTAMPTZ,
    processed_at TIMESTAMPTZ,
    last_error TEXT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_whatsapp_inbox_pending
    ON core.whatsapp_inbox (status, next_attempt_at, created_at);

CREATE INDEX IF NOT EXISTS idx_whatsapp_inbox_sender_created
    ON core.whatsapp_inbox (sender_phone, created_at DESC);

DROP TRIGGER IF EXISTS trg_whatsapp_inbox_set_updated_at ON core.whatsapp_inbox;
CREATE TRIGGER trg_whatsapp_inbox_set_updated_at
BEFORE UPDATE ON core.whatsapp_inbox
FOR EACH ROW
EXECUTE FUNCTION core.set_updated_at();

COMMENT ON TABLE core.whatsapp_inbox IS
    'Durable Meta WhatsApp inbound-message inbox used by the asynchronous booking worker.';
COMMENT ON COLUMN core.trips.source_request_id IS
    'External idempotency key, for example a WhatsApp wamid, unique within source_channel.';

COMMIT;
