-- Fida Ride local database bootstrap.
-- Executed once by the official PostgreSQL/PostGIS entrypoint when PGDATA is empty.

BEGIN;

CREATE EXTENSION IF NOT EXISTS postgis;
CREATE EXTENSION IF NOT EXISTS "uuid-ossp";

CREATE SCHEMA IF NOT EXISTS core AUTHORIZATION CURRENT_USER;
CREATE SCHEMA IF NOT EXISTS telemetry AUTHORIZATION CURRENT_USER;

COMMENT ON SCHEMA core IS
  'Transactional Fida Ride domain data: identity, bookings, rides, pricing, payments, and ledger.';

COMMENT ON SCHEMA telemetry IS
  'Telemetry-derived and geospatial persistence such as finalized trip paths and telemetry audit data.';

COMMIT;
