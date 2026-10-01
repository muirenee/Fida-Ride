-- Fida-Ride schema v2: fields required by the NestJS ride request/dispatch API.
BEGIN;

ALTER TABLE core.trips
    ADD COLUMN IF NOT EXISTS vehicle_type VARCHAR(32);

-- Safe backfill for any pre-v2 local/development rows.
UPDATE core.trips
SET vehicle_type = 'taxi'
WHERE vehicle_type IS NULL;

ALTER TABLE core.trips
    ALTER COLUMN vehicle_type SET NOT NULL;

DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1
        FROM pg_constraint
        WHERE conname = 'chk_trips_vehicle_type'
          AND conrelid = 'core.trips'::regclass
    ) THEN
        ALTER TABLE core.trips
            ADD CONSTRAINT chk_trips_vehicle_type
            CHECK (vehicle_type IN (
                'taxi',
                'moto',
                'premium',
                'tuk_tuk',
                'ev',
                'accessible',
                'other'
            ));
    END IF;
END;
$$;

CREATE INDEX IF NOT EXISTS idx_trips_matching_vehicle_created
    ON core.trips (vehicle_type, created_at)
    WHERE status = 'matching';

COMMIT;
