-- Fida-Ride admin operations indexes v10
-- PostgreSQL 15+

BEGIN;

SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '30s';
SET LOCAL search_path TO core, public;

-- Dashboard GBV/revenue scans only need today's completed trips. A partial index
-- keeps the reporting path small while INCLUDE avoids extra heap reads for fare
-- and currency in common index-only plans.
CREATE INDEX IF NOT EXISTS idx_trips_completed_reporting
    ON core.trips (completed_at DESC)
    INCLUDE (fare_amount, currency)
    WHERE status = 'completed';

-- Active-trip count is a frequent operations metric. Keep this separate from
-- historical statuses so the index remains compact.
CREATE INDEX IF NOT EXISTS idx_trips_admin_active
    ON core.trips (status, updated_at DESC)
    WHERE status IN ('accepted', 'picked_up');

COMMIT;
