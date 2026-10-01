import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import Decimal from 'decimal.js';
import { DataSource } from 'typeorm';
import { VehicleType } from '../common/vehicle-type';

const VEHICLE_MULTIPLIER: Record<VehicleType, string> = {
  [VehicleType.Taxi]: '1.00',
  [VehicleType.Moto]: '0.65',
  [VehicleType.Premium]: '1.80',
  [VehicleType.TukTuk]: '0.80',
  [VehicleType.Ev]: '1.10',
  [VehicleType.Accessible]: '1.30',
  [VehicleType.Other]: '1.00',
};

@Injectable()
export class PricingService {
  constructor(
    private readonly db: DataSource,
    private readonly config: ConfigService,
  ) {}

  async quote(input: {
    pickupLat: number;
    pickupLng: number;
    dropoffLat: number;
    dropoffLng: number;
    vehicleType: VehicleType;
  }): Promise<{ distanceMeters: number; fareAmount: string; surgeMultiplier: string }> {
    const rows = await this.db.query<Array<{ distance_meters: string }>>(
      `SELECT ST_Distance(
          ST_SetSRID(ST_MakePoint($1, $2), 4326)::geography,
          ST_SetSRID(ST_MakePoint($3, $4), 4326)::geography
        )::text AS distance_meters`,
      [input.pickupLng, input.pickupLat, input.dropoffLng, input.dropoffLat],
    );

    const distanceMeters = Number(rows[0]?.distance_meters ?? 0);
    const distanceKm = new Decimal(distanceMeters).div(1000);
    const baseFare = new Decimal(this.config.getOrThrow<string>('RIDE_BASE_FARE_RWF'));
    const perKm = new Decimal(this.config.getOrThrow<string>('RIDE_PER_KM_RWF'));
    const vehicleMultiplier = new Decimal(VEHICLE_MULTIPLIER[input.vehicleType]);
    const surgeMultiplier = new Decimal(1);

    const fare = baseFare
      .plus(distanceKm.mul(perKm))
      .mul(vehicleMultiplier)
      .mul(surgeMultiplier)
      .toDecimalPlaces(0, Decimal.ROUND_HALF_UP);

    return {
      distanceMeters,
      fareAmount: fare.toFixed(4),
      surgeMultiplier: surgeMultiplier.toFixed(4),
    };
  }
}
