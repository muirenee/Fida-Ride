import { Injectable, Logger } from '@nestjs/common';
import { VehicleType } from '../common/vehicle-type';
import { RedisService } from '../redis/redis.service';
import { SurgePricingService } from './surge-pricing.service';
import { HeatmapPoint } from './surge.types';

@Injectable()
export class HeatmapService {
  private readonly logger = new Logger(HeatmapService.name);

  constructor(
    private readonly redis: RedisService,
    private readonly surge: SurgePricingService,
  ) {}

  async get(vehicleType: VehicleType): Promise<HeatmapPoint[]> {
    try {
      const raw = await this.redis.get(this.surge.heatmapKey(vehicleType));
      if (!raw) return [];

      const parsed = JSON.parse(raw) as unknown;
      if (!Array.isArray(parsed)) return [];

      return parsed.flatMap((value) => {
        if (!isHeatmapPoint(value)) return [];
        return [value];
      });
    } catch (error) {
      this.logger.warn(
        `Heatmap cache unavailable for ${vehicleType}: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
      return [];
    }
  }
}

function isHeatmapPoint(value: unknown): value is HeatmapPoint {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
  const point = value as Record<string, unknown>;
  return (
    typeof point.latitude === 'number' &&
    Number.isFinite(point.latitude) &&
    point.latitude >= -90 &&
    point.latitude <= 90 &&
    typeof point.longitude === 'number' &&
    Number.isFinite(point.longitude) &&
    point.longitude >= -180 &&
    point.longitude <= 180 &&
    typeof point.intensity === 'number' &&
    Number.isFinite(point.intensity) &&
    point.intensity >= 0 &&
    point.intensity <= 1
  );
}
