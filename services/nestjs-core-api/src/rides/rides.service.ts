import { ForbiddenException, Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { InjectRepository } from '@nestjs/typeorm';
import { QueryFailedError, Repository } from 'typeorm';
import { TripEntity } from '../database/entities/trip.entity';
import { RedisService } from '../redis/redis.service';
import { UsersService } from '../users/users.service';
import { RequestRideDto } from './dto/request-ride.dto';
import { DispatchService } from './dispatch.service';
import { PricingService } from './pricing.service';

export interface RideRequestContext {
  sourceChannel?: string;
  sourceRequestId?: string;
}

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

  async requestRide(dto: RequestRideDto, context?: RideRequestContext) {
    const rider = await this.users.requireById(dto.rider_id);
    if (rider.status !== 'active') throw new ForbiddenException('Rider account is not active');

    const quote = await this.pricing.quote({
      pickupLat: dto.pickup_lat,
      pickupLng: dto.pickup_lng,
      dropoffLat: dto.dropoff_lat,
      dropoffLng: dto.dropoff_lng,
      vehicleType: dto.vehicle_type,
    });

    const idempotentExisting = await this.findBySource(context);
    if (idempotentExisting) {
      return this.buildResponse(idempotentExisting, quote.distanceMeters, [], true);
    }

    let trip: TripEntity;
    try {
      trip = await this.trips.save(
        this.trips.create({
          riderId: rider.id,
          driverId: null,
          status: 'matching',
          vehicleType: dto.vehicle_type,
          sourceChannel: context?.sourceChannel ?? null,
          sourceRequestId: context?.sourceRequestId ?? null,
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
    } catch (error) {
      if (this.isUniqueViolation(error)) {
        const existing = await this.findBySource(context);
        if (existing) return this.buildResponse(existing, quote.distanceMeters, [], true);
      }
      throw error;
    }

    let candidateDriverIds: string[] = [];
    let dispatchDeferred = false;
    const biddingTtlSeconds = this.config.getOrThrow<number>('BIDDING_TTL_SECONDS');

    try {
      candidateDriverIds = await this.dispatch.nearbyAvailableDrivers({
        pickupLat: dto.pickup_lat,
        pickupLng: dto.pickup_lng,
        vehicleType: dto.vehicle_type,
      });

      await this.redis.openBidding(trip.id, candidateDriverIds, biddingTtlSeconds);

      await this.redis.publish(
        'ride:dispatch:requested',
        JSON.stringify({
          trip_id: trip.id,
          rider_id: rider.id,
          vehicle_type: dto.vehicle_type,
          pickup: { lat: dto.pickup_lat, lng: dto.pickup_lng },
          candidate_driver_ids: candidateDriverIds,
          bidding_expires_in_seconds: biddingTtlSeconds,
          requested_at: new Date().toISOString(),
        }),
      );
    } catch (error) {
      dispatchDeferred = true;
      this.logger.error(
        `Initial dispatch/bidding setup failed for trip ${trip.id}`,
        error instanceof Error ? error.stack : String(error),
      );
    }

    return this.buildResponse(trip, quote.distanceMeters, candidateDriverIds, dispatchDeferred);
  }

  private async findBySource(context?: RideRequestContext): Promise<TripEntity | null> {
    if (!context?.sourceChannel || !context.sourceRequestId) return null;
    return this.trips.findOne({
      where: {
        sourceChannel: context.sourceChannel,
        sourceRequestId: context.sourceRequestId,
      },
    });
  }

  private buildResponse(
    trip: TripEntity,
    distanceMeters: number,
    candidateDriverIds: string[],
    dispatchDeferred: boolean,
  ) {
    const biddingTtlSeconds = this.config.getOrThrow<number>('BIDDING_TTL_SECONDS');
    return {
      trip_id: trip.id,
      status: trip.status,
      vehicle_type: trip.vehicleType,
      estimated_distance_meters: Math.round(distanceMeters),
      estimated_fare: trip.fareAmount,
      currency: trip.currency,
      surge_multiplier: trip.surgeMultiplier,
      bidding: {
        state: dispatchDeferred ? 'deferred' : 'broadcasted',
        expires_in_seconds: biddingTtlSeconds,
      },
      dispatch: {
        radius_km: Number(this.config.getOrThrow<string>('DISPATCH_RADIUS_KM')),
        candidate_count: candidateDriverIds.length,
        deferred: dispatchDeferred,
      },
    };
  }

  private isUniqueViolation(error: unknown): boolean {
    if (!(error instanceof QueryFailedError)) return false;
    return (error.driverError as { code?: string } | undefined)?.code === '23505';
  }
}
