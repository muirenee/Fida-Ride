-- Fida-Ride durable settlement outbox v9

BEGIN;

SET LOCAL search_path TO core, public;

CREATE TABLE IF NOT EXISTS core.wallet_settlement_outbox (
    id              UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    trip_id         UUID NOT NULL UNIQUE,
    status          VARCHAR(16) NOT NULL DEFAULT 'pending',
    attempts        INTEGER NOT NULL DEFAULT 0,
    next_attempt_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    locked_at       TIMESTAMPTZ,
    completed_at    TIMESTAMPTZ,
    last_error      TEXT,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),

    CONSTRAINT fk_wallet_settlement_outbox_trip
        FOREIGN KEY (trip_id)
        REFERENCES core.trips(id)
        ON UPDATE CASCADE
        ON DELETE RESTRICT,

    CONSTRAINT chk_wallet_settlement_outbox_status
        CHECK (status IN ('pending', 'processing', 'completed', 'failed')),

    CONSTRAINT chk_wallet_settlement_outbox_attempts
        CHECK (attempts >= 0)
);

CREATE INDEX IF NOT EXISTS idx_wallet_settlement_outbox_claim
    ON core.wallet_settlement_outbox (status, next_attempt_at, created_at)
    WHERE status IN ('pending', 'processing');

DROP TRIGGER IF EXISTS trg_wallet_settlement_outbox_set_updated_at
    ON core.wallet_settlement_outbox;
CREATE TRIGGER trg_wallet_settlement_outbox_set_updated_at
BEFORE UPDATE ON core.wallet_settlement_outbox
FOR EACH ROW
EXECUTE FUNCTION core.set_updated_at();

CREATE OR REPLACE FUNCTION core.enqueue_trip_wallet_settlement()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
    IF NEW.status = 'completed'
       AND OLD.status IS DISTINCT FROM NEW.status
       AND NEW.settlement_transaction_id IS NULL THEN
        INSERT INTO core.wallet_settlement_outbox (trip_id)
        VALUES (NEW.id)
        ON CONFLICT (trip_id) DO NOTHING;
    END IF;

    RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_enqueue_trip_wallet_settlement ON core.trips;
CREATE TRIGGER trg_enqueue_trip_wallet_settlement
AFTER UPDATE OF status ON core.trips
FOR EACH ROW
EXECUTE FUNCTION core.enqueue_trip_wallet_settlement();

-- Recover completed-but-unsettled trips that existed before this migration.
INSERT INTO core.wallet_settlement_outbox (trip_id)
SELECT t.id
FROM core.trips t
WHERE t.status = 'completed'
  AND t.settlement_transaction_id IS NULL
ON CONFLICT (trip_id) DO NOTHING;

COMMENT ON TABLE core.wallet_settlement_outbox IS
    'Durable handoff from trip completion to idempotent wallet settlement. Workers claim rows with SKIP LOCKED.';

COMMIT;
