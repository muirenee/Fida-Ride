import { ForbiddenException, Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { TripEntity } from '../database/entities/trip.entity';
import { RedisService } from '../redis/redis.service';
import { UsersService } from '../users/users.service';
import { RequestRideDto } from './dto/request-ride.dto';
import { DispatchService } from './dispatch.service';
import { PricingService } from './pricing.service';

@Injectable()
export class RidesService {
  private readonly logger = new Logger(RidesService.name);

  constructor(
    @InjectRepository(TripEntity)
    private readonly trips: Repository<TripEntity>,
    private readonly users: UsersService,
    private readonly pricing: PricingService,
    private readonly dispatch: DispatchService,
    private readonly redis: RedisService,
    private readonly config: ConfigService,
  ) {}

  async requestRide(dto: RequestRideDto) {
    const rider = await this.users.requireById(dto.rider_id);
    if (rider.status !== 'active') throw new ForbiddenException('Rider account is not active');

    const quote = await this.pricing.quote({
      pickupLat: dto.pickup_lat,
      pickupLng: dto.pickup_lng,
      dropoffLat: dto.dropoff_lat,
      dropoffLng: dto.dropoff_lng,
      vehicleType: dto.vehicle_type,
    });

    const trip = await this.trips.save(
      this.trips.create({
        riderId: rider.id,
        driverId: null,
        status: 'matching',
        vehicleType: dto.vehicle_type,
        fareAmount: quote.fareAmount,
        currency: 'RWF',
        surgeMultiplier: quote.surgeMultiplier,
        paymentMethod: 'cash',
        pickupLocation: {
          type: 'Point',
          coordinates: [dto.pickup_lng, dto.pickup_lat],
        },
        dropoffLocation: {
          type: 'Point',
          coordinates: [dto.dropoff_lng, dto.dropoff_lat],
        },
        ridePath: null,
        matchingStartedAt: new Date(),
      }),
    );

    let candidateDriverIds: string[] = [];
    let dispatchDeferred = false;

    try {
      candidateDriverIds = await this.dispatch.nearbyAvailableDrivers({
        pickupLat: dto.pickup_lat,
        pickupLng: dto.pickup_lng,
        vehicleType: dto.vehicle_type,
      });

      await this.redis.publish(
        'ride:dispatch:requested',
        JSON.stringify({
          trip_id: trip.id,
          rider_id: rider.id,
          vehicle_type: dto.vehicle_type,
          pickup: { lat: dto.pickup_lat, lng: dto.pickup_lng },
          candidate_driver_ids: candidateDriverIds,
          requested_at: new Date().toISOString(),
        }),
      );
    } catch (error) {
      // PostgreSQL owns the ride state. Cache/broker failure must not make a client
      // retry an already-created ride; a future dispatch worker can recover it.
      dispatchDeferred = true;
      this.logger.error(
        `Initial dispatch failed for trip ${trip.id}`,
        error instanceof Error ? error.stack : String(error),
      );
    }

    return {
      trip_id: trip.id,
      status: trip.status,
      vehicle_type: trip.vehicleType,
      estimated_distance_meters: Math.round(quote.distanceMeters),
      estimated_fare: trip.fareAmount,
      currency: trip.currency,
      surge_multiplier: trip.surgeMultiplier,
      dispatch: {
        radius_km: Number(this.config.getOrThrow<string>('DISPATCH_RADIUS_KM')),
        candidate_count: candidateDriverIds.length,
        deferred: dispatchDeferred,
      },
    };
  }
}
