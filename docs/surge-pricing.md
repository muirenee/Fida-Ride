# Fida-Ride dynamic surge pricing and demand heatmaps

## Data ownership

- PostgreSQL/PostGIS is authoritative for ride demand and geo-fenced zone geometry.
- Go telemetry + Redis is authoritative for current driver position and presence.
- Redis surge keys are derived cache data only. They are never authoritative for trip state or money already committed to a trip.
- Driver GPS pings are not copied into PostgreSQL for surge calculation.

## Flow

1. Go telemetry writes driver coordinates to `drivers:locations` and availability to `driver:presence:<driverId>`.
2. `SurgePricingService` takes a short Redis distributed lock so only one NestJS replica refreshes a cycle.
3. For each active `core.surge_zones` polygon, Redis `GEOSEARCH` performs a bounding-circle prefilter.
4. Presence and approved driver/vehicle eligibility are checked.
5. The compact candidate coordinates are passed to `core.calculate_zone_density`.
6. PostGIS uses `ST_Covers` for exact polygon membership and counts active unassigned pickup points with partial GiST indexes.
7. The service calculates a capped progressive multiplier and stores it in Redis as `surge:multiplier:<zoneId>:<vehicleType>`.
8. `PricingService` resolves the pickup zone and reads that cached multiplier before finalizing the upfront quote.
9. Tier-specific heatmap arrays are stored as `surge:heatmap:<vehicleType>` and exposed through `GET /api/v1/maps/heatmaps?vehicle_type=taxi`.

## Zone creation

No pricing polygons are seeded automatically because surge boundaries are a business/operations decision. Insert reviewed GeoJSON/WKT polygons explicitly. `boundary` must be a `MultiPolygon` in WGS84 / SRID 4326.

Example shape only:

```sql
INSERT INTO core.surge_zones (
    code,
    name,
    boundary,
    vehicle_types,
    priority
)
VALUES (
    'example-zone',
    'Example Zone',
    ST_Multi(
        ST_SetSRID(
            ST_GeomFromText('POLYGON((30.00 -1.95, 30.02 -1.95, 30.02 -1.93, 30.00 -1.93, 30.00 -1.95))'),
            4326
        )
    ),
    ARRAY['taxi', 'moto']::varchar(32)[],
    10
);
```

Replace the example polygon with reviewed operational geometry before enabling surge.

## Safety behavior

- Surge defaults to disabled.
- Cache miss, Redis failure, spatial query timeout, invalid cached multiplier, or unknown zone all fail open to `1.0x`.
- If the Redis driver prefilter reaches its configured limit, supply may be undercounted; the service therefore forces that zone to `1.0x` rather than risk overcharging.
- Spatial reads run in short `REPEATABLE READ`, `READ ONLY` transactions with local statement, lock, and idle-in-transaction timeouts.
- When supply is zero and demand exists, the multiplier reaches the configured cap. The default cap is `3.0x`.
- Heatmap intensity is normalized passenger demand (`0.0` to `1.0`) within each vehicle tier, not the surge multiplier itself.
