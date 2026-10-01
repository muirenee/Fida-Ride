import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { InjectRepository } from '@nestjs/typeorm';
import { In, Repository } from 'typeorm';
import { VehicleType } from '../common/vehicle-type';
import { DriverEntity } from '../database/entities/driver.entity';
import { RedisService } from '../redis/redis.service';
import { DriverSpatialPoint, SurgeZone, ZoneSupplySnapshot } from './surge.types';

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

@Injectable()
export class SurgeSupplyService {
  constructor(
    private readonly redis: RedisService,
    private readonly config: ConfigService,
    @InjectRepository(DriverEntity)
    private readonly drivers: Repository<DriverEntity>,
  ) {}

  async availableDriversForZone(zone: SurgeZone): Promise<ZoneSupplySnapshot> {
    const limit = this.config.getOrThrow<number>('SURGE_DRIVER_PREFILTER_LIMIT');
    const nearby = await this.redis.geoSearchWithCoordinates(
      'drivers:locations',
      zone.centerLng,
      zone.centerLat,
      zone.searchRadiusMeters / 1000,
      limit,
    );

    const valid = nearby.filter((entry) => UUID_PATTERN.test(entry.member));
    const presence = await this.redis.mGet(
      valid.map((entry) => `driver:presence:${entry.member}`),
    );

    const available = valid.filter((_, index) => presence[index] === 'available');
    if (available.length === 0) {
      return {
        byVehicleType: new Map<VehicleType, DriverSpatialPoint[]>(),
        truncated: nearby.length >= limit,
      };
    }

    const eligible = await this.drivers.find({
      select: {
        id: true,
        vehicleType: true,
      },
      where: {
        id: In(available.map((entry) => entry.member)),
        verificationStatus: 'approved',
      },
    });

    const vehicleByDriver = new Map<string, VehicleType>();
    for (const driver of eligible) {
      if (isVehicleType(driver.vehicleType)) {
        vehicleByDriver.set(driver.id, driver.vehicleType);
      }
    }

    const byVehicleType = new Map<VehicleType, DriverSpatialPoint[]>();
    for (const entry of available) {
      const vehicleType = vehicleByDriver.get(entry.member);
      if (!vehicleType) continue;

      const current = byVehicleType.get(vehicleType) ?? [];
      current.push({
        driver_id: entry.member,
        longitude: entry.longitude,
        latitude: entry.latitude,
      });
      byVehicleType.set(vehicleType, current);
    }

    return {
      byVehicleType,
      truncated: nearby.length >= limit,
    };
  }
}

function isVehicleType(value: string): value is VehicleType {
  return Object.values(VehicleType).includes(value as VehicleType);
}
