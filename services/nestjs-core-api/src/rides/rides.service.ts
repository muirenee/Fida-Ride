import {
  ConflictException,
  ForbiddenException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { InjectRepository } from '@nestjs/typeorm';
import { randomUUID } from 'node:crypto';
import { DataSource, In, QueryFailedError, Repository } from 'typeorm';
import { AuthPrincipal } from '../auth/jwt-auth.guard';
import { DriverEntity } from '../database/entities/driver.entity';
import { TripEntity } from '../database/entities/trip.entity';
import { RedisService } from '../redis/redis.service';
import { UsersService } from '../users/users.service';
import { DriverTripAction } from './dto/driver-trip-action.dto';
import { RequestRideDto } from './dto/request-ride.dto';
import { DispatchService } from './dispatch.service';
import { PricingService } from './pricing.service';

const ACTIVE_DRIVER_STATUSES = ['accepted', 'en_route', 'arrived', 'picked_up'];
const CANCELLABLE_STATUSES = ['created', 'matching', 'accepted', 'en_route', 'arrived'];
const OPEN_BIDDING_STATES = new Set(['broadcasted', 'counter_offers_received']);
const MOBILE_PRESENCE_TTL_SECONDS = 30;
const ACTIVE_TRIP_CACHE_TTL_SECONDS = 12 * 60 * 60;

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
    @InjectRepository(DriverEntity)
    private readonly drivers: Repository<DriverEntity>,
    private readonly dataSource: DataSource,
    private readonly users: UsersService,
    private readonly pricing: PricingService,
    private readonly dispatch: DispatchService,
    private readonly redis: RedisService,
    private readonly config: ConfigService,
  ) {}

  async requestRide(dto: RequestRideDto, context?: RideRequestContext) {
    const rider = await this.users.requireById(dto.rider_id);
    if (rider.status !== 'active') throw new ForbiddenException('Rider account is not active');

    const existingActive = await this.trips.findOne({
      where: {
        riderId: rider.id,
        status: In(['created', 'matching', ...ACTIVE_DRIVER_STATUSES]),
      },
      order: { createdAt: 'DESC' },
    });
    if (existingActive) {
      throw new ConflictException('Rider already has an active trip');
    }

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
          paymentMethod: dto.payment_method ?? 'cash',
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

  async getTrip(tripId: string, principal: AuthPrincipal) {
    const trip = await this.requireTrip(tripId);
    this.assertTripVisibleToPrincipal(trip, principal);
    return this.snapshot(trip);
  }

  async getActiveRiderTrip(principal: AuthPrincipal) {
    if (principal.role !== 'rider') {
      throw new ForbiddenException('Rider access token required');
    }

    const trip = await this.trips.findOne({
      where: {
        riderId: principal.user_id,
        status: In(['created', 'matching', ...ACTIVE_DRIVER_STATUSES]),
      },
      order: { updatedAt: 'DESC' },
    });

    return {
      trip: trip ? this.snapshot(trip) : null,
    };
  }

  async getActiveDriverTrip(principal: AuthPrincipal) {
    const driver = await this.requireDriverPrincipal(principal);
    const trip = await this.trips.findOne({
      where: {
        driverId: driver.id,
        status: In(ACTIVE_DRIVER_STATUSES),
      },
      order: { updatedAt: 'DESC' },
    });

    return {
      trip: trip ? this.snapshot(trip) : null,
    };
  }

  async listDriverOffers(principal: AuthPrincipal) {
    const driver = await this.requireDriverPrincipal(principal);
    if (driver.verificationStatus !== 'approved') {
      throw new ForbiddenException('Driver is not approved to receive ride offers');
    }
    if (!driver.isOnline || !driver.isAvailable) {
      return { offers: [], generated_at: new Date().toISOString() };
    }

    const active = await this.trips.findOne({
      where: { driverId: driver.id, status: In(ACTIVE_DRIVER_STATUSES) },
    });
    if (active) {
      return { offers: [], generated_at: new Date().toISOString() };
    }

    const candidates = await this.trips.find({
      where: {
        status: 'matching',
        vehicleType: driver.vehicleType,
      },
      order: { createdAt: 'DESC' },
      take: 20,
    });

    const eligibility = await Promise.all(
      candidates.map((trip) => this.redis.isBiddingDriverEligible(trip.id, driver.id)),
    );

    return {
      offers: candidates
        .filter((_, index) => eligibility[index])
        .map((trip) => this.snapshot(trip)),
      generated_at: new Date().toISOString(),
    };
  }

  async setDriverAvailability(
    principal: AuthPrincipal,
    dto: { is_available: boolean; latitude?: number; longitude?: number },
  ) {
    const driver = await this.requireDriverPrincipal(principal);
    if (driver.verificationStatus !== 'approved') {
      throw new ForbiddenException('Driver must be approved before going online');
    }

    if (!dto.is_available) {
      await this.drivers.update(driver.id, {
        isAvailable: false,
        isOnline: false,
      });
      await Promise.all([
        this.redis.del(`driver:presence:${driver.id}`),
        this.redis.removeDriverLocation(driver.id),
      ]);

      return {
        driver_id: driver.id,
        is_online: false,
        is_available: false,
        presence_ttl_seconds: 0,
      };
    }

    if (dto.latitude == null || dto.longitude == null) {
      throw new ConflictException('Latitude and longitude are required when going online');
    }

    const active = await this.trips.findOne({
      where: { driverId: driver.id, status: In(ACTIVE_DRIVER_STATUSES) },
    });
    if (active) {
      throw new ConflictException('Driver already has an active trip');
    }

    await this.drivers.update(driver.id, {
      isAvailable: true,
      isOnline: true,
    });
    await Promise.all([
      this.redis.upsertDriverLocation(driver.id, dto.longitude, dto.latitude),
      this.redis.setEx(
        `driver:presence:${driver.id}`,
        MOBILE_PRESENCE_TTL_SECONDS,
        'available',
      ),
    ]);

    return {
      driver_id: driver.id,
      is_online: true,
      is_available: true,
      latitude: dto.latitude,
      longitude: dto.longitude,
      presence_ttl_seconds: MOBILE_PRESENCE_TTL_SECONDS,
    };
  }

  async acceptTrip(tripId: string, principal: AuthPrincipal) {
    const driver = await this.requireDriverPrincipal(principal);
    if (driver.verificationStatus !== 'approved') {
      throw new ForbiddenException('Driver is not approved to accept rides');
    }
    if (!driver.isOnline || !driver.isAvailable) {
      throw new ConflictException('Driver must be online and available');
    }

    const active = await this.trips.findOne({
      where: { driverId: driver.id, status: In(ACTIVE_DRIVER_STATUSES) },
    });
    if (active) throw new ConflictException('Driver already has an active trip');

    const eligible = await this.redis.isBiddingDriverEligible(tripId, driver.id);
    if (!eligible) throw new ForbiddenException('Driver was not invited to this trip');

    const biddingState = await this.redis.getBiddingState(tripId);
    if (!biddingState || !OPEN_BIDDING_STATES.has(biddingState)) {
      throw new ConflictException('Trip is no longer open for acceptance');
    }

    const lockKey = `bidding:trip:${tripId}:accept-lock`;
    const lockToken = randomUUID();
    const lockTtlMs = this.config.getOrThrow<number>('BIDDING_ACCEPT_LOCK_TTL_MS');
    const acquired = await this.redis.acquireLock(lockKey, lockToken, lockTtlMs);
    if (!acquired) throw new ConflictException('Another driver is accepting this trip');

    try {
      const rows = (await this.dataSource.query(
        `
          UPDATE core.trips
          SET driver_id = $2,
              status = 'accepted',
              accepted_at = NOW(),
              updated_at = NOW()
          WHERE id = $1
            AND status = 'matching'
            AND driver_id IS NULL
            AND vehicle_type = $3
          RETURNING id
        `,
        [tripId, driver.id, driver.vehicleType],
      )) as Array<{ id: string }>;

      if (!rows[0]) {
        throw new ConflictException('Trip was already accepted or is no longer available');
      }

      const trip = await this.requireTrip(tripId);
      const biddingTtlSeconds = this.config.getOrThrow<number>('BIDDING_TTL_SECONDS');

      try {
        await this.redis.finalizeBidding({
          tripId,
          selectedDriverId: driver.id,
          ttlSeconds: biddingTtlSeconds,
          bidAcceptedPayload: JSON.stringify({
            event: 'ride_accepted',
            trip_id: trip.id,
            rider_id: trip.riderId,
            driver_id: driver.id,
            accepted_fare: Number(trip.fareAmount ?? 0),
          }),
          tripLockedPayload: JSON.stringify({
            event: 'trip_locked',
            trip_id: trip.id,
            rider_id: trip.riderId,
            driver_id: driver.id,
            accepted_fare: Number(trip.fareAmount ?? 0),
          }),
        });
      } catch (error) {
        this.logger.error(
          `Redis bidding finalization failed for accepted trip ${trip.id}`,
          error instanceof Error ? error.stack : String(error),
        );
      }

      await Promise.all([
        this.drivers.update(driver.id, { isAvailable: false, isOnline: true }),
        this.redis.setEx(
          `driver:active-trip:${driver.id}`,
          ACTIVE_TRIP_CACHE_TTL_SECONDS,
          trip.id,
        ),
        this.redis.setEx(
          `driver:presence:${driver.id}`,
          MOBILE_PRESENCE_TTL_SECONDS,
          'busy',
        ),
      ]);

      await this.publishStatus(trip);
      return this.snapshot(trip);
    } finally {
      await this.redis.releaseLock(lockKey, lockToken);
    }
  }

  async driverAction(
    tripId: string,
    action: DriverTripAction,
    principal: AuthPrincipal,
  ) {
    const driver = await this.requireDriverPrincipal(principal);
    const trip = await this.requireTrip(tripId);
    if (trip.driverId !== driver.id) {
      throw new ForbiddenException('Trip is not assigned to this driver');
    }

    const transition = this.driverTransition(action);
    if (trip.status !== transition.from) {
      throw new ConflictException(
        `Cannot apply ${action} while trip status is ${trip.status}`,
      );
    }
    if (action === 'complete' && trip.ridePath == null) {
      throw new ConflictException(
        'Trip telemetry path must be finalized before completion',
      );
    }

    const timestampAssignment =
      transition.timestampColumn == null
        ? ''
        : `, ${transition.timestampColumn} = NOW()`;

    const rows = (await this.dataSource.query(
      `
        UPDATE core.trips
        SET status = $3,
            updated_at = NOW()
            ${timestampAssignment}
        WHERE id = $1
          AND driver_id = $2
          AND status = $4
        RETURNING id
      `,
      [tripId, driver.id, transition.to, transition.from],
    )) as Array<{ id: string }>;

    if (!rows[0]) throw new ConflictException('Trip changed before the action was applied');

    const updated = await this.requireTrip(tripId);
    if (transition.to === 'completed') {
      await this.redis.del(`driver:active-trip:${driver.id}`);
      await this.drivers.update(driver.id, { isAvailable: false });
    }

    await this.publishStatus(updated);
    return this.snapshot(updated);
  }

  async cancelTrip(
    tripId: string,
    reason: string | undefined,
    principal: AuthPrincipal,
  ) {
    const trip = await this.requireTrip(tripId);
    if (!CANCELLABLE_STATUSES.includes(trip.status)) {
      throw new ConflictException('Trip can no longer be cancelled normally');
    }

    let actor: 'rider' | 'driver';
    if (principal.role === 'rider') {
      if (trip.riderId !== principal.user_id) {
        throw new ForbiddenException('Trip does not belong to this rider');
      }
      actor = 'rider';
    } else {
      const driver = await this.requireDriverPrincipal(principal);
      if (trip.driverId !== driver.id) {
        throw new ForbiddenException('Trip is not assigned to this driver');
      }
      actor = 'driver';
    }

    const normalizedReason = reason?.trim() || null;
    const rows = (await this.dataSource.query(
      `
        UPDATE core.trips
        SET status = 'cancelled',
            cancelled_at = NOW(),
            cancellation_actor = $3,
            cancellation_reason = $4,
            updated_at = NOW()
        WHERE id = $1
          AND status = $2
        RETURNING id
      `,
      [tripId, trip.status, actor, normalizedReason],
    )) as Array<{ id: string }>;

    if (!rows[0]) throw new ConflictException('Trip changed before cancellation was applied');

    if (trip.status === 'matching') {
      await this.redis.cancelBidding(trip.id);
    }
    if (trip.driverId) {
      await this.redis.del(`driver:active-trip:${trip.driverId}`);
      await this.drivers.update(trip.driverId, { isAvailable: false });
    }

    const updated = await this.requireTrip(tripId);
    await this.publishStatus(updated);
    return this.snapshot(updated);
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

  private async requireTrip(tripId: string): Promise<TripEntity> {
    const trip = await this.trips.findOne({ where: { id: tripId } });
    if (!trip) throw new NotFoundException('Trip not found');
    return trip;
  }

  private async requireDriverPrincipal(principal: AuthPrincipal): Promise<DriverEntity> {
    if (principal.role !== 'driver' || !principal.driver_id) {
      throw new ForbiddenException('Driver access token required');
    }

    const driver = await this.users.findDriverByUserId(principal.user_id);
    if (!driver || driver.id !== principal.driver_id) {
      throw new ForbiddenException('Driver identity does not match access token');
    }
    return driver;
  }

  private assertTripVisibleToPrincipal(trip: TripEntity, principal: AuthPrincipal): void {
    if (principal.role === 'rider' && trip.riderId === principal.user_id) return;
    if (
      principal.role === 'driver' &&
      principal.driver_id != null &&
      trip.driverId === principal.driver_id
    ) {
      return;
    }
    throw new ForbiddenException('Trip is not visible to this account');
  }

  private driverTransition(action: DriverTripAction): {
    from: string;
    to: string;
    timestampColumn: string | null;
  } {
    switch (action) {
      case 'en_route':
        return { from: 'accepted', to: 'en_route', timestampColumn: null };
      case 'arrive':
        return { from: 'en_route', to: 'arrived', timestampColumn: 'arrived_at' };
      case 'start':
        return { from: 'arrived', to: 'picked_up', timestampColumn: 'picked_up_at' };
      case 'complete':
        return { from: 'picked_up', to: 'completed', timestampColumn: 'completed_at' };
    }
  }

  private lifecycleStatus(trip: TripEntity): string | null {
    switch (trip.status) {
      case 'created':
        return 'quoting';
      case 'matching':
        return 'searching';
      case 'accepted':
        return 'driver_assigned';
      case 'en_route':
        return 'driver_en_route';
      case 'arrived':
        return 'driver_arrived';
      case 'picked_up':
        return 'in_progress';
      case 'completed':
        return 'completed';
      case 'cancelled':
        if (trip.cancellationActor === 'rider') return 'cancelled_by_rider';
        if (trip.cancellationActor === 'driver') return 'cancelled_by_driver';
        return null;
      default:
        return null;
    }
  }

  private snapshot(trip: TripEntity) {
    const pickup = trip.pickupLocation.coordinates;
    const dropoff = trip.dropoffLocation.coordinates;

    return {
      trip_id: trip.id,
      rider_id: trip.riderId,
      driver_id: trip.driverId,
      status: trip.status,
      lifecycle_status: this.lifecycleStatus(trip),
      revision: Number(trip.revision),
      vehicle_type: trip.vehicleType,
      fare_amount: trip.fareAmount,
      currency: trip.currency,
      surge_multiplier: trip.surgeMultiplier,
      payment_method: trip.paymentMethod,
      pickup: { lat: pickup[1], lng: pickup[0] },
      dropoff: { lat: dropoff[1], lng: dropoff[0] },
      cancellation_actor: trip.cancellationActor,
      cancellation_reason: trip.cancellationReason,
      created_at: trip.createdAt.toISOString(),
      updated_at: trip.updatedAt.toISOString(),
      accepted_at: trip.acceptedAt?.toISOString() ?? null,
      arrived_at: trip.arrivedAt?.toISOString() ?? null,
      picked_up_at: trip.pickedUpAt?.toISOString() ?? null,
      completed_at: trip.completedAt?.toISOString() ?? null,
      cancelled_at: trip.cancelledAt?.toISOString() ?? null,
    };
  }

  private async publishStatus(trip: TripEntity): Promise<void> {
    await this.redis.publish(
      'ride:status:changed',
      JSON.stringify({
        event: 'ride_status_changed',
        trip_id: trip.id,
        rider_id: trip.riderId,
        driver_id: trip.driverId,
        status: trip.status,
        lifecycle_status: this.lifecycleStatus(trip),
        revision: Number(trip.revision),
        updated_at: trip.updatedAt.toISOString(),
      }),
    );
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
      lifecycle_status: this.lifecycleStatus(trip),
      revision: Number(trip.revision),
      vehicle_type: trip.vehicleType,
      payment_method: trip.paymentMethod,
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
