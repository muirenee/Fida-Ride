import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { InjectRepository } from '@nestjs/typeorm';
import { In, Repository } from 'typeorm';
import { VehicleType } from '../common/vehicle-type';
import { DriverEntity } from '../database/entities/driver.entity';
import { RedisService } from '../redis/redis.service';

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

@Injectable()
export class DispatchService {
  constructor(
    private readonly redis: RedisService,
    private readonly config: ConfigService,
    @InjectRepository(DriverEntity)
    private readonly drivers: Repository<DriverEntity>,
  ) {}

  async nearbyAvailableDrivers(input: {
    pickupLat: number;
    pickupLng: number;
    vehicleType: VehicleType;
  }): Promise<string[]> {
    const radiusKm = Number(this.config.getOrThrow<string>('DISPATCH_RADIUS_KM'));
    const limit = this.config.getOrThrow<number>('DISPATCH_CANDIDATE_LIMIT');

    const nearby = await this.redis.geoSearch(
      'drivers:locations',
      input.pickupLng,
      input.pickupLat,
      radiusKm,
      limit,
    );

    // Test/dev telemetry may contain non-UUID members. DB driver IDs are UUIDs.
    const candidateIds = nearby.filter((id) => UUID_PATTERN.test(id));
    if (candidateIds.length === 0) return [];

    const presence = await this.redis.mGet(candidateIds.map((id) => `driver:presence:${id}`));
    const activeIds = candidateIds.filter((_, index) => presence[index] === 'available');
    if (activeIds.length === 0) return [];

    const eligible = await this.drivers.find({
      select: { id: true },
      where: {
        id: In(activeIds),
        vehicleType: input.vehicleType,
        verificationStatus: 'approved',
      },
    });

    const eligibleSet = new Set(eligible.map((driver) => driver.id));
    return activeIds.filter((id) => eligibleSet.has(id));
  }
}
