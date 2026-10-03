-- Fida-Ride schema v12: mobile trip operations and monotonic trip revisions.
BEGIN;

SET LOCAL search_path TO core, public;

ALTER TABLE core.trips
    ADD COLUMN IF NOT EXISTS revision BIGINT NOT NULL DEFAULT 0,
    ADD COLUMN IF NOT EXISTS arrived_at TIMESTAMPTZ,
    ADD COLUMN IF NOT EXISTS cancellation_actor VARCHAR(16),
    ADD COLUMN IF NOT EXISTS cancellation_reason VARCHAR(255);

ALTER TABLE core.trips
    DROP CONSTRAINT IF EXISTS chk_trips_status;

ALTER TABLE core.trips
    ADD CONSTRAINT chk_trips_status
    CHECK (status IN (
        'created',
        'matching',
        'accepted',
        'en_route',
        'arrived',
        'picked_up',
        'completed',
        'cancelled'
    ));

ALTER TABLE core.trips
    DROP CONSTRAINT IF EXISTS chk_trips_cancellation_actor;

ALTER TABLE core.trips
    ADD CONSTRAINT chk_trips_cancellation_actor
    CHECK (
        cancellation_actor IS NULL
        OR cancellation_actor IN ('rider', 'driver', 'system')
    );

CREATE OR REPLACE FUNCTION core.bump_trip_revision()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
    NEW.revision = OLD.revision + 1;
    RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_trips_bump_revision ON core.trips;
CREATE TRIGGER trg_trips_bump_revision
BEFORE UPDATE ON core.trips
FOR EACH ROW
EXECUTE FUNCTION core.bump_trip_revision();

DROP INDEX IF EXISTS core.idx_trips_driver_operational_active;
CREATE INDEX idx_trips_driver_operational_active
    ON core.trips (driver_id, status, updated_at DESC)
    WHERE driver_id IS NOT NULL
      AND status IN ('accepted', 'en_route', 'arrived', 'picked_up');

COMMIT;
