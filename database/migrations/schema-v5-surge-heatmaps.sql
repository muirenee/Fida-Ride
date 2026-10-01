BEGIN;

-- -----------------------------------------------------------------------------
-- Dynamic pricing zones
-- -----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS core.surge_zones (
    id                    UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    code                  VARCHAR(64) NOT NULL UNIQUE,
    name                  VARCHAR(128) NOT NULL,
    boundary              GEOMETRY(MultiPolygon, 4326) NOT NULL,
    search_center         GEOMETRY(Point, 4326) NOT NULL,
    search_radius_meters  INTEGER NOT NULL,
    vehicle_types         VARCHAR(32)[] NOT NULL DEFAULT ARRAY[
                              'taxi',
                              'moto',
                              'premium',
                              'tuk_tuk',
                              'ev',
                              'accessible',
                              'other'
                          ]::VARCHAR(32)[],
    priority              SMALLINT NOT NULL DEFAULT 0,
    active                BOOLEAN NOT NULL DEFAULT TRUE,
    created_at            TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at            TIMESTAMPTZ NOT NULL DEFAULT NOW(),

    CONSTRAINT chk_surge_zones_valid_geometry
        CHECK (ST_IsValid(boundary)),
    CONSTRAINT chk_surge_zones_nonempty_geometry
        CHECK (NOT ST_IsEmpty(boundary)),
    CONSTRAINT chk_surge_zones_search_radius
        CHECK (search_radius_meters > 0),
    CONSTRAINT chk_surge_zones_vehicle_types
        CHECK (
            cardinality(vehicle_types) > 0
            AND vehicle_types <@ ARRAY[
                'taxi',
                'moto',
                'premium',
                'tuk_tuk',
                'ev',
                'accessible',
                'other'
            ]::VARCHAR(32)[]
        )
);

CREATE INDEX IF NOT EXISTS idx_surge_zones_boundary_gist
    ON core.surge_zones USING GIST (boundary);

CREATE INDEX IF NOT EXISTS idx_surge_zones_active_priority
    ON core.surge_zones (active, priority DESC, code)
    WHERE active = TRUE;

-- A point-on-surface guarantees that the Redis pre-filter origin is inside the
-- zone. The radius is the farthest polygon vertex plus a 250 m safety margin,
-- so a GEOSEARCH circle can never exclude a driver who is actually inside the
-- polygon before the exact PostGIS ST_Covers test is applied.
CREATE OR REPLACE FUNCTION core.set_surge_zone_metrics()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
DECLARE
    max_vertex_distance DOUBLE PRECISION;
BEGIN
    NEW.search_center := ST_PointOnSurface(NEW.boundary);

    SELECT COALESCE(
        MAX(
            ST_Distance(
                NEW.search_center::geography,
                (dumped).geom::geography
            )
        ),
        0
    )
    INTO max_vertex_distance
    FROM ST_DumpPoints(NEW.boundary) AS dumped;

    NEW.search_radius_meters := CEIL(max_vertex_distance + 250)::INTEGER;
    NEW.updated_at := NOW();
    RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_surge_zones_metrics ON core.surge_zones;
CREATE TRIGGER trg_surge_zones_metrics
BEFORE INSERT OR UPDATE OF boundary ON core.surge_zones
FOR EACH ROW
EXECUTE FUNCTION core.set_surge_zone_metrics();

DROP TRIGGER IF EXISTS trg_surge_zones_set_updated_at ON core.surge_zones;
CREATE TRIGGER trg_surge_zones_set_updated_at
BEFORE UPDATE ON core.surge_zones
FOR EACH ROW
EXECUTE FUNCTION core.set_updated_at();

-- Active, unassigned demand is the hot path for zone scans. These partial
-- indexes are substantially smaller than full-table indexes and keep spatial
-- density scans bounded as trip history grows.
CREATE INDEX IF NOT EXISTS idx_trips_active_unassigned_pickup_gist
    ON core.trips USING GIST (pickup_location)
    WHERE driver_id IS NULL
      AND status IN ('created', 'matching');

CREATE INDEX IF NOT EXISTS idx_trips_active_unassigned_vehicle_created
    ON core.trips (vehicle_type, created_at DESC)
    WHERE driver_id IS NULL
      AND status IN ('created', 'matching');

-- -----------------------------------------------------------------------------
-- Density function
--
-- Driver positions stay transient in Redis. NestJS obtains a radius-prefiltered
-- set from drivers:locations, verifies driver:presence:<id> = available and
-- core.drivers business eligibility, then passes only those compact points into
-- this function for exact polygon membership. PostgreSQL therefore remains the
-- authority for ride demand without becoming an every-GPS-ping telemetry store.
-- -----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION core.calculate_zone_density(
    p_zone_id UUID,
    p_vehicle_type VARCHAR,
    p_driver_points JSONB DEFAULT '[]'::JSONB,
    p_demand_window_seconds INTEGER DEFAULT 600
)
RETURNS TABLE (
    zone_id UUID,
    zone_code VARCHAR,
    demand_count BIGINT,
    available_driver_count BIGINT,
    demand_supply_ratio NUMERIC,
    latitude DOUBLE PRECISION,
    longitude DOUBLE PRECISION
)
LANGUAGE sql
STABLE
PARALLEL RESTRICTED
AS $$
    WITH zone AS (
        SELECT
            z.id,
            z.code,
            z.boundary,
            z.search_center
        FROM core.surge_zones z
        WHERE z.id = p_zone_id
          AND z.active = TRUE
          AND p_vehicle_type = ANY(z.vehicle_types)
    ),
    demand AS (
        SELECT COUNT(*)::BIGINT AS total
        FROM core.trips t
        CROSS JOIN zone z
        WHERE t.driver_id IS NULL
          AND t.status IN ('created', 'matching')
          AND t.vehicle_type = p_vehicle_type
          AND t.created_at >= NOW() - make_interval(
              secs => GREATEST(p_demand_window_seconds, 30)
          )
          AND t.pickup_location && z.boundary
          AND ST_Covers(z.boundary, t.pickup_location)
    ),
    driver_input AS (
        SELECT DISTINCT ON (d.driver_id)
            d.driver_id,
            d.longitude,
            d.latitude
        FROM jsonb_to_recordset(COALESCE(p_driver_points, '[]'::JSONB)) AS d(
            driver_id UUID,
            longitude DOUBLE PRECISION,
            latitude DOUBLE PRECISION
        )
        WHERE d.longitude BETWEEN -180 AND 180
          AND d.latitude BETWEEN -90 AND 90
        ORDER BY d.driver_id
    ),
    supply AS (
        SELECT COUNT(*)::BIGINT AS total
        FROM driver_input d
        CROSS JOIN zone z
        WHERE ST_Covers(
            z.boundary,
            ST_SetSRID(
                ST_MakePoint(d.longitude, d.latitude),
                4326
            )
        )
    )
    SELECT
        z.id,
        z.code,
        d.total,
        s.total,
        CASE
            WHEN s.total = 0 THEN NULL
            ELSE ROUND(d.total::NUMERIC / s.total::NUMERIC, 4)
        END,
        ST_Y(z.search_center),
        ST_X(z.search_center)
    FROM zone z
    CROSS JOIN demand d
    CROSS JOIN supply s;
$$;

COMMIT;
