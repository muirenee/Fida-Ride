import { BadRequestException, Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { DataSource, EntityManager, QueryFailedError } from 'typeorm';
import { VehicleType } from '../common/vehicle-type';
import { RedisService } from '../redis/redis.service';
import { UpsertGeofenceDto } from './dto/upsert-geofence.dto';

interface MetricsRow {
  active_trips: number;
  flagged_fraud_alerts: number;
  gross_marketplace_revenue: string;
  currency: string;
}

interface GeometryInspectionRow {
  geometry_type: string;
  is_valid: boolean;
  validity_reason: string;
  point_count: number;
}

interface GeofenceRow {
  id: string;
  code: string;
  name: string;
  priority: number;
  active: boolean;
  vehicle_types: string[];
  updated_at: Date;
}

@Injectable()
export class AdminService {
  constructor(
    private readonly db: DataSource,
    private readonly redis: RedisService,
    private readonly config: ConfigService,
  ) {}

  async dashboardMetrics(): Promise<{
    active_trips: number;
    available_drivers: number;
    flagged_fraud_alerts: number;
    gross_marketplace_revenue: string;
    currency: string;
    generated_at: string;
  }> {
    const reportingTimeZone = this.config.get<string>(
      'ADMIN_REPORTING_TIME_ZONE',
      'Africa/Kigali',
    );

    const [metrics, availableRaw] = await Promise.all([
      this.db.transaction('READ COMMITTED', async (manager) => {
        await manager.query('SET TRANSACTION READ ONLY');
        await manager.query(`SET LOCAL statement_timeout = '1500ms'`);
        const rows = (await manager.query(
          `
            WITH bounds AS (
              SELECT
                (date_trunc('day', NOW() AT TIME ZONE $1) AT TIME ZONE $1) AS day_start,
                ((date_trunc('day', NOW() AT TIME ZONE $1) + INTERVAL '1 day') AT TIME ZONE $1)
                  AS day_end
            )
            SELECT
              COUNT(*) FILTER (
                WHERE t.status IN ('accepted', 'picked_up')
              )::int AS active_trips,
              (
                SELECT COUNT(*)::int
                FROM core.security_audit_logs s, bounds b
                WHERE s.action IN ('flagged', 'suspended')
                  AND s.occurred_at >= b.day_start
                  AND s.occurred_at < b.day_end
              ) AS flagged_fraud_alerts,
              COALESCE(
                SUM(t.fare_amount) FILTER (
                  WHERE t.status = 'completed'
                    AND t.completed_at >= b.day_start
                    AND t.completed_at < b.day_end
                ),
                0::numeric
              )::text AS gross_marketplace_revenue,
              COALESCE(
                MAX(t.currency) FILTER (
                  WHERE t.status = 'completed'
                    AND t.completed_at >= b.day_start
                    AND t.completed_at < b.day_end
                ),
                'RWF'
              ) AS currency
            FROM core.trips t
            CROSS JOIN bounds b
          `,
          [reportingTimeZone],
        )) as MetricsRow[];
        return rows[0] ?? {
          active_trips: 0,
          flagged_fraud_alerts: 0,
          gross_marketplace_revenue: '0',
          currency: 'RWF',
        };
      }),
      this.redis.get('admin:available-driver-count'),
    ]);

    const availableDrivers = Number(availableRaw ?? '0');
    return {
      active_trips: Number(metrics.active_trips),
      available_drivers:
        Number.isInteger(availableDrivers) && availableDrivers >= 0 ? availableDrivers : 0,
      flagged_fraud_alerts: Number(metrics.flagged_fraud_alerts),
      gross_marketplace_revenue: metrics.gross_marketplace_revenue,
      currency: metrics.currency,
      generated_at: new Date().toISOString(),
    };
  }

  async upsertGeofence(dto: UpsertGeofenceDto): Promise<GeofenceRow> {
    this.assertGeoJsonShape(dto.geojson);

    const vehicleTypes = dto.vehicle_types ?? Object.values(VehicleType);
    const priority = dto.priority ?? 0;
    const active = dto.active ?? true;
    const configuredMaxPoints = Number(
      this.config.get<string | number>('ADMIN_GEOFENCE_MAX_POINTS', 10_000),
    );
    const maxPoints =
      Number.isInteger(configuredMaxPoints) && configuredMaxPoints >= 100
        ? configuredMaxPoints
        : 10_000;

    let row: GeofenceRow;
    try {
      row = await this.db.transaction('SERIALIZABLE', async (manager) => {
        await manager.query(`SET LOCAL lock_timeout = '1000ms'`);
        await manager.query(`SET LOCAL statement_timeout = '3000ms'`);

        const inspection = await this.inspectGeometry(manager, dto.geojson);
        if (!inspection.is_valid) {
          throw new BadRequestException(
            `Invalid GeoJSON geometry: ${inspection.validity_reason}`,
          );
        }
        if (!['ST_Polygon', 'ST_MultiPolygon'].includes(inspection.geometry_type)) {
          throw new BadRequestException('GeoJSON must contain a Polygon or MultiPolygon');
        }
        if (inspection.point_count > maxPoints) {
          throw new BadRequestException(`Geofence exceeds the ${maxPoints} point safety limit`);
        }

        const rows = (await manager.query(
          `
            INSERT INTO core.surge_zones (
              code,
              name,
              boundary,
              vehicle_types,
              priority,
              active
            )
            VALUES (
              $1,
              $2,
              ST_Multi(
                ST_Force2D(
                  ST_SetSRID(
                    ST_GeomFromGeoJSON($3),
                    4326
                  )
                )
              ),
              $4::varchar(32)[],
              $5,
              $6
            )
            ON CONFLICT (code)
            DO UPDATE SET
              name = EXCLUDED.name,
              boundary = EXCLUDED.boundary,
              vehicle_types = EXCLUDED.vehicle_types,
              priority = EXCLUDED.priority,
              active = EXCLUDED.active,
              updated_at = NOW()
            RETURNING
              id,
              code,
              name,
              priority,
              active,
              vehicle_types,
              updated_at
          `,
          [dto.boundary_id, dto.name, dto.geojson, vehicleTypes, priority, active],
        )) as GeofenceRow[];

        const result = rows[0];
        if (!result) throw new Error('Geofence upsert did not return a row');
        return result;
      });
    } catch (error) {
      if (error instanceof BadRequestException) throw error;
      if (error instanceof QueryFailedError) {
        const databaseError = error.driverError as
          | { code?: string; message?: string }
          | undefined;
        const message = databaseError?.message ?? error.message;
        if (
          databaseError?.code === 'XX000' ||
          databaseError?.code === '22023' ||
          /geojson|geometry|polygon|parse error/iu.test(message)
        ) {
          throw new BadRequestException('GeoJSON geometry is malformed or cannot be normalized');
        }
      }
      throw error;
    }

    await this.invalidateGeofenceCaches(row.id);
    await this.redis.publish(
      'admin:geofence:updated',
      JSON.stringify({
        event: 'geofence_updated',
        zone_id: row.id,
        boundary_id: row.code,
        updated_at: row.updated_at.toISOString(),
      }),
    );

    return row;
  }

  private async inspectGeometry(
    manager: EntityManager,
    geojson: string,
  ): Promise<GeometryInspectionRow> {
    const rows = (await manager.query(
      `
        WITH geometry_input AS (
          SELECT ST_Force2D(
            ST_SetSRID(
              ST_GeomFromGeoJSON($1),
              4326
            )
          ) AS geom
        )
        SELECT
          ST_GeometryType(geom) AS geometry_type,
          ST_IsValid(geom) AS is_valid,
          ST_IsValidReason(geom) AS validity_reason,
          ST_NPoints(geom)::int AS point_count
        FROM geometry_input
      `,
      [geojson],
    )) as GeometryInspectionRow[];

    const row = rows[0];
    if (!row) throw new BadRequestException('Unable to parse GeoJSON geometry');
    return row;
  }

  private assertGeoJsonShape(raw: string): void {
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      throw new BadRequestException('geojson must be valid JSON');
    }

    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
      throw new BadRequestException('geojson must be a GeoJSON geometry object');
    }
    const type = (parsed as { type?: unknown }).type;
    if (type !== 'Polygon' && type !== 'MultiPolygon') {
      throw new BadRequestException('geojson type must be Polygon or MultiPolygon');
    }
  }

  private async invalidateGeofenceCaches(zoneId: string): Promise<void> {
    const keys: string[] = [];
    for (const vehicleType of Object.values(VehicleType)) {
      keys.push(`surge:multiplier:${zoneId}:${vehicleType}`);
      keys.push(`surge:heatmap:${vehicleType}`);
    }
    await this.redis.del(...keys);
  }
}
