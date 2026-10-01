import { Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { randomUUID } from 'node:crypto';
import { VehicleType } from '../common/vehicle-type';
import { RedisService } from '../redis/redis.service';
import { SurgeDensityRepository } from './surge-density.repository';
import { SurgeSupplyService } from './surge-supply.service';
import { HeatmapPoint, SurgeZone, ZoneDensity } from './surge.types';

interface ZoneMetric {
  density: ZoneDensity;
  multiplier: number;
}

@Injectable()
export class SurgePricingService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(SurgePricingService.name);
  private timer: NodeJS.Timeout | null = null;
  private running = false;

  constructor(
    private readonly config: ConfigService,
    private readonly redis: RedisService,
    private readonly densityRepository: SurgeDensityRepository,
    private readonly supply: SurgeSupplyService,
  ) {}

  onModuleInit(): void {
    if (!this.isEnabled()) return;

    const intervalMs = this.config.getOrThrow<number>('SURGE_REFRESH_INTERVAL_MS');
    this.timer = setInterval(() => {
      void this.refresh();
    }, intervalMs);
    this.timer.unref();
    void this.refresh();
  }

  onModuleDestroy(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  async getMultiplierForPickup(input: {
    latitude: number;
    longitude: number;
    vehicleType: VehicleType;
  }): Promise<number> {
    if (!this.isEnabled()) return 1;

    try {
      const zoneId = await this.densityRepository.findZoneForPoint(input);
      if (!zoneId) return 1;

      const cached = await this.redis.get(this.multiplierKey(zoneId, input.vehicleType));
      const multiplier = Number(cached);
      const maximum = this.config.getOrThrow<number>('SURGE_MAX_MULTIPLIER');

      if (!Number.isFinite(multiplier) || multiplier < 1 || multiplier > maximum) {
        return 1;
      }

      return multiplier;
    } catch (error) {
      // Dynamic pricing must fail open to the normal fare. Cache/database trouble
      // must never inflate a rider's fare or make ride quoting unavailable.
      this.logger.warn(
        `Surge lookup failed; using 1.0x: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
      return 1;
    }
  }

  heatmapKey(vehicleType: VehicleType): string {
    return `surge:heatmap:${vehicleType}`;
  }

  private async refresh(): Promise<void> {
    if (this.running || !this.isEnabled()) return;
    this.running = true;

    const lockKey = 'surge:refresh:lock';
    const lockToken = randomUUID();
    const lockTtlMs = this.config.getOrThrow<number>('SURGE_REFRESH_LOCK_TTL_MS');
    let acquired = false;

    try {
      acquired = await this.redis.acquireLock(lockKey, lockToken, lockTtlMs);
      if (!acquired) return;

      const zones = await this.densityRepository.listActiveZones();
      const metricsByVehicle = new Map<VehicleType, ZoneMetric[]>();
      const cacheEntries: Array<{ key: string; ttlSeconds: number; value: string }> = [];
      const cacheTtlSeconds = this.config.getOrThrow<number>('SURGE_CACHE_TTL_SECONDS');

      for (const zone of zones) {
        await this.refreshZone(zone, metricsByVehicle, cacheEntries, cacheTtlSeconds);
      }

      for (const vehicleType of Object.values(VehicleType)) {
        const metrics = metricsByVehicle.get(vehicleType) ?? [];
        const heatmap = this.buildHeatmap(metrics);
        cacheEntries.push({
          key: this.heatmapKey(vehicleType),
          ttlSeconds: cacheTtlSeconds,
          value: JSON.stringify(heatmap),
        });
      }

      await this.redis.setExMany(cacheEntries);
    } catch (error) {
      this.logger.error(
        'Surge refresh failed',
        error instanceof Error ? error.stack : String(error),
      );
    } finally {
      if (acquired) await this.redis.releaseLock(lockKey, lockToken);
      this.running = false;
    }
  }

  private async refreshZone(
    zone: SurgeZone,
    metricsByVehicle: Map<VehicleType, ZoneMetric[]>,
    cacheEntries: Array<{ key: string; ttlSeconds: number; value: string }>,
    cacheTtlSeconds: number,
  ): Promise<void> {
    try {
      const supplySnapshot = await this.supply.availableDriversForZone(zone);

      if (supplySnapshot.truncated) {
        this.logger.warn(
          `Surge supply prefilter reached its configured limit for zone ${zone.code}; ` +
            'forcing 1.0x to avoid overcharging from an undercounted driver supply',
        );
      }

      for (const vehicleType of zone.vehicleTypes) {
        try {
          const density = await this.densityRepository.calculateZoneDensity({
            zoneId: zone.id,
            vehicleType,
            driverPoints: supplySnapshot.byVehicleType.get(vehicleType) ?? [],
          });
          if (!density) continue;

          const multiplier = supplySnapshot.truncated
            ? 1
            : this.calculateMultiplier(density);

          cacheEntries.push({
            key: this.multiplierKey(zone.id, vehicleType),
            ttlSeconds: cacheTtlSeconds,
            value: multiplier.toFixed(4),
          });

          const current = metricsByVehicle.get(vehicleType) ?? [];
          current.push({ density, multiplier });
          metricsByVehicle.set(vehicleType, current);
        } catch (error) {
          this.logger.warn(
            `Surge density calculation failed for ${zone.code}/${vehicleType}: ${
              error instanceof Error ? error.message : String(error)
            }`,
          );
        }
      }
    } catch (error) {
      this.logger.warn(
        `Surge supply refresh failed for zone ${zone.code}: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    }
  }

  private calculateMultiplier(density: ZoneDensity): number {
    if (density.demandCount <= 0) return 1;

    const maximum = this.config.getOrThrow<number>('SURGE_MAX_MULTIPLIER');
    if (density.availableDriverCount <= 0) return maximum;

    const threshold = this.config.getOrThrow<number>('SURGE_RATIO_THRESHOLD');
    const ratio = density.ratio ?? 0;
    if (ratio <= threshold) return 1;

    const start = this.config.getOrThrow<number>('SURGE_START_MULTIPLIER');
    const slope = this.config.getOrThrow<number>('SURGE_PROGRESSIVE_SLOPE');
    const raw = start + (ratio - threshold) * slope;
    const rounded = Math.round(raw * 20) / 20;
    return Math.min(maximum, Math.max(start, rounded));
  }

  private buildHeatmap(metrics: ZoneMetric[]): HeatmapPoint[] {
    const positive = metrics.filter((metric) => metric.density.demandCount > 0);
    const maximumDemand = Math.max(0, ...positive.map((metric) => metric.density.demandCount));
    if (maximumDemand === 0) return [];

    return positive.map(({ density }) => ({
      latitude: density.latitude,
      longitude: density.longitude,
      intensity: Math.round((density.demandCount / maximumDemand) * 1000) / 1000,
    }));
  }

  private multiplierKey(zoneId: string, vehicleType: VehicleType): string {
    return `surge:multiplier:${zoneId}:${vehicleType}`;
  }

  private isEnabled(): boolean {
    return this.config.get<boolean>('SURGE_PRICING_ENABLED', false);
  }
}
