BEGIN;

CREATE TABLE IF NOT EXISTS core.trip_bids (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    trip_id UUID NOT NULL REFERENCES core.trips(id) ON DELETE CASCADE,
    driver_id UUID NOT NULL REFERENCES core.drivers(id) ON DELETE RESTRICT,
    proposed_fare NUMERIC(19,4) NOT NULL CHECK (proposed_fare > 0),
    driver_rating NUMERIC(3,2) NOT NULL CHECK (driver_rating >= 0 AND driver_rating <= 5),
    status VARCHAR(24) NOT NULL DEFAULT 'active'
        CHECK (status IN ('active', 'superseded', 'accepted', 'rejected', 'withdrawn')),
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_trip_bids_trip_status_created
    ON core.trip_bids (trip_id, status, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_trip_bids_driver_created
    ON core.trip_bids (driver_id, created_at DESC);

CREATE UNIQUE INDEX IF NOT EXISTS uq_trip_bids_one_active_per_driver
    ON core.trip_bids (trip_id, driver_id)
    WHERE status = 'active';

DROP TRIGGER IF EXISTS trg_trip_bids_updated_at ON core.trip_bids;
CREATE TRIGGER trg_trip_bids_updated_at
BEFORE UPDATE ON core.trip_bids
FOR EACH ROW
EXECUTE FUNCTION core.set_updated_at();

COMMIT;
