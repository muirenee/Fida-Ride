import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { DataSource, QueryRunner } from 'typeorm';
import { VehicleType } from '../common/vehicle-type';
import { DriverSpatialPoint, SurgeZone, ZoneDensity } from './surge.types';

type SurgeZoneRow = {
  id: string;
  code: string;
  name: string;
  center_lat: string | number;
  center_lng: string | number;
  search_radius_meters: string | number;
  vehicle_types: string[];
};

type ZoneDensityRow = {
  zone_id: string;
  zone_code: string;
  demand_count: string | number;
  available_driver_count: string | number;
  demand_supply_ratio: string | number | null;
  latitude: string | number;
  longitude: string | number;
};

@Injectable()
export class SurgeDensityRepository {
  constructor(
    private readonly db: DataSource,
    private readonly config: ConfigService,
  ) {}

  async listActiveZones(): Promise<SurgeZone[]> {
    return this.withReadOnlyTransaction(async (runner) => {
      const rows = (await runner.query(`
        SELECT
          id,
          code,
          name,
          ST_Y(search_center) AS center_lat,
          ST_X(search_center) AS center_lng,
          search_radius_meters,
          vehicle_types
        FROM core.surge_zones
        WHERE active = TRUE
        ORDER BY priority DESC, code ASC
      `)) as SurgeZoneRow[];

      return rows.map((row) => ({
        id: row.id,
        code: row.code,
        name: row.name,
        centerLat: Number(row.center_lat),
        centerLng: Number(row.center_lng),
        searchRadiusMeters: Number(row.search_radius_meters),
        vehicleTypes: row.vehicle_types.filter(isVehicleType),
      }));
    });
  }

  async calculateZoneDensity(input: {
    zoneId: string;
    vehicleType: VehicleType;
    driverPoints: DriverSpatialPoint[];
  }): Promise<ZoneDensity | null> {
    const demandWindowSeconds = this.config.getOrThrow<number>(
      'SURGE_DEMAND_WINDOW_SECONDS',
    );

    return this.withReadOnlyTransaction(async (runner) => {
      const rows = (await runner.query(
        `
          SELECT *
          FROM core.calculate_zone_density(
            $1::uuid,
            $2::varchar,
            $3::jsonb,
            $4::integer
          )
        `,
        [
          input.zoneId,
          input.vehicleType,
          JSON.stringify(input.driverPoints),
          demandWindowSeconds,
        ],
      )) as ZoneDensityRow[];

      const row = rows[0];
      if (!row) return null;

      return {
        zoneId: row.zone_id,
        zoneCode: row.zone_code,
        demandCount: Number(row.demand_count),
        availableDriverCount: Number(row.available_driver_count),
        ratio:
          row.demand_supply_ratio === null
            ? null
            : Number(row.demand_supply_ratio),
        latitude: Number(row.latitude),
        longitude: Number(row.longitude),
      };
    });
  }

  async findZoneForPoint(input: {
    latitude: number;
    longitude: number;
    vehicleType: VehicleType;
  }): Promise<string | null> {
    return this.withReadOnlyTransaction(async (runner) => {
      const rows = (await runner.query(
        `
          WITH point AS (
            SELECT ST_SetSRID(ST_MakePoint($1, $2), 4326) AS geom
          )
          SELECT z.id
          FROM core.surge_zones z
          CROSS JOIN point p
          WHERE z.active = TRUE
            AND $3::varchar = ANY(z.vehicle_types)
            AND z.boundary && p.geom
            AND ST_Covers(z.boundary, p.geom)
          ORDER BY
            z.priority DESC,
            ST_Area(z.boundary::geography) ASC,
            z.code ASC
          LIMIT 1
        `,
        [input.longitude, input.latitude, input.vehicleType],
      )) as Array<{ id: string }>;

      return rows[0]?.id ?? null;
    });
  }

  private async withReadOnlyTransaction<T>(
    work: (runner: QueryRunner) => Promise<T>,
  ): Promise<T> {
    const runner = this.db.createQueryRunner();
    await runner.connect();
    await runner.startTransaction('REPEATABLE READ');

    try {
      await runner.query('SET TRANSACTION READ ONLY');
      await runner.query(`SELECT set_config('statement_timeout', $1, true)`, [
        `${this.config.getOrThrow<number>('SURGE_DB_STATEMENT_TIMEOUT_MS')}ms`,
      ]);
      await runner.query(`SELECT set_config('lock_timeout', $1, true)`, [
        `${this.config.getOrThrow<number>('SURGE_DB_LOCK_TIMEOUT_MS')}ms`,
      ]);
      await runner.query(
        `SELECT set_config('idle_in_transaction_session_timeout', $1, true)`,
        [`${this.config.getOrThrow<number>('SURGE_DB_IDLE_TX_TIMEOUT_MS')}ms`],
      );

      const result = await work(runner);
      await runner.commitTransaction();
      return result;
    } catch (error) {
      await runner.rollbackTransaction();
      throw error;
    } finally {
      await runner.release();
    }
  }
}

function isVehicleType(value: string): value is VehicleType {
  return Object.values(VehicleType).includes(value as VehicleType);
}
