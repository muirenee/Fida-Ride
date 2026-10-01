import {
  ConflictException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { randomUUID } from 'crypto';
import Decimal from 'decimal.js';
import { DataSource } from 'typeorm';
import { AuthPrincipal } from '../auth/jwt-auth.guard';
import { RedisService } from '../redis/redis.service';
import { AcceptBidDto } from './dto/accept-bid.dto';
import { NegotiateBidDto } from './dto/negotiate-bid.dto';

const OPEN_BIDDING_STATES = new Set(['broadcasted', 'counter_offers_received']);
const ACTIVE_TRIP_CACHE_TTL_SECONDS = 12 * 60 * 60;

type NegotiationContextRow = {
  rider_id: string;
  trip_status: string;
  trip_vehicle_type: string;
  driver_vehicle_type: string;
  verification_status: string;
  driver_rating: string;
};

type BidRow = {
  bid_id: string;
  rider_id: string;
  proposed_fare: string;
};

type AcceptedTripRow = {
  id: string;
  driver_id: string;
  fare_amount: string;
  status: string;
};

@Injectable()
export class BiddingService {
  constructor(
    private readonly dataSource: DataSource,
    private readonly redis: RedisService,
    private readonly config: ConfigService,
  ) {}

  async negotiate(dto: NegotiateBidDto, principal: AuthPrincipal) {
    this.assertDriverPrincipal(principal, dto.driver_id);

    const redisState = await this.redis.getBiddingState(dto.trip_id);
    if (!redisState || !OPEN_BIDDING_STATES.has(redisState)) {
      throw new ConflictException('Trip is not open for fare negotiation');
    }

    const rows = (await this.dataSource.query(
      `
      SELECT
        t.rider_id,
        t.status AS trip_status,
        t.vehicle_type AS trip_vehicle_type,
        d.vehicle_type AS driver_vehicle_type,
        d.verification_status,
        u.rating::text AS driver_rating
      FROM core.trips t
      JOIN core.drivers d ON d.id = $2
      JOIN core.users u ON u.id = d.user_id
      WHERE t.id = $1
      LIMIT 1
      `,
      [dto.trip_id, dto.driver_id],
    )) as NegotiationContextRow[];

    const context = rows[0];
    if (!context) throw new NotFoundException('Trip or driver not found');
    if (context.trip_status !== 'matching') {
      throw new ConflictException('Trip is no longer matching');
    }
    if (context.verification_status !== 'approved') {
      throw new ForbiddenException('Driver is not approved for bidding');
    }
    if (context.trip_vehicle_type !== context.driver_vehicle_type) {
      throw new ForbiddenException('Driver vehicle type does not match this trip');
    }

    const eligible = await this.redis.isBiddingDriverEligible(dto.trip_id, dto.driver_id);
    if (!eligible) {
      throw new ForbiddenException('Driver was not invited to bid on this trip');
    }

    const fare = new Decimal(dto.proposed_fare).toDecimalPlaces(4, Decimal.ROUND_HALF_UP);
    if (!fare.isFinite() || fare.lte(0)) {
      throw new ConflictException('Proposed fare is invalid');
    }

    const driverRating = Number(context.driver_rating);
    const bidId = await this.persistLatestActiveBid({
      tripId: dto.trip_id,
      driverId: dto.driver_id,
      proposedFare: fare.toFixed(4),
      driverRating,
    });

    const event = {
      event: 'counter_offer_received',
      trip_id: dto.trip_id,
      rider_id: context.rider_id,
      driver_id: dto.driver_id,
      proposed_fare: fare.toNumber(),
      driver_rating: driverRating,
      bid_id: bidId,
      submitted_at: new Date().toISOString(),
    };

    const ttlSeconds = this.config.getOrThrow<number>('BIDDING_TTL_SECONDS');
    const recorded = await this.redis.recordCounterOffer({
      tripId: dto.trip_id,
      driverId: dto.driver_id,
      fareScore: fare.toNumber(),
      ttlSeconds,
      payload: JSON.stringify(event),
    });

    if (!recorded) {
      await this.dataSource.query(
        `UPDATE core.trip_bids SET status = 'rejected', updated_at = NOW() WHERE id = $1 AND status = 'active'`,
        [bidId],
      );
      throw new ConflictException('Bidding closed before the offer could be recorded');
    }

    return {
      bid_id: bidId,
      trip_id: dto.trip_id,
      driver_id: dto.driver_id,
      proposed_fare: fare.toFixed(4),
      driver_rating: driverRating,
      status: 'active',
    };
  }

  async accept(dto: AcceptBidDto, principal: AuthPrincipal) {
    this.assertRiderPrincipal(principal);

    const lockKey = `bidding:trip:${dto.trip_id}:accept-lock`;
    const lockToken = randomUUID();
    const lockTtlMs = this.config.getOrThrow<number>('BIDDING_ACCEPT_LOCK_TTL_MS');
    const acquired = await this.redis.acquireLock(lockKey, lockToken, lockTtlMs);
    if (!acquired) {
      throw new ConflictException('Another bid acceptance is already in progress');
    }

    try {
      const state = await this.redis.getBiddingState(dto.trip_id);
      if (!state || !OPEN_BIDDING_STATES.has(state)) {
        throw new ConflictException('Trip is not open for bid acceptance');
      }

      const queryRunner = this.dataSource.createQueryRunner();
      await queryRunner.connect();
      await queryRunner.startTransaction();

      let accepted: AcceptedTripRow;
      let acceptedFare: string;
      let riderId: string;
      try {
        const bidRows = (await queryRunner.query(
          `
          SELECT
            b.id AS bid_id,
            t.rider_id,
            b.proposed_fare::text AS proposed_fare
          FROM core.trip_bids b
          JOIN core.trips t ON t.id = b.trip_id
          WHERE b.trip_id = $1
            AND b.driver_id = $2
            AND b.status = 'active'
          ORDER BY b.created_at DESC
          LIMIT 1
          FOR UPDATE OF b, t
          `,
          [dto.trip_id, dto.driver_id],
        )) as BidRow[];

        const bid = bidRows[0];
        if (!bid) throw new NotFoundException('Active bid not found');
        if (bid.rider_id !== principal.user_id) {
          throw new ForbiddenException('Trip does not belong to this rider');
        }

        const updated = (await queryRunner.query(
          `
          UPDATE core.trips
          SET driver_id = $2,
              fare_amount = $3::numeric,
              status = 'accepted',
              accepted_at = NOW(),
              updated_at = NOW()
          WHERE id = $1
            AND rider_id = $4
            AND status = 'matching'
            AND driver_id IS NULL
          RETURNING id, driver_id, fare_amount::text, status
          `,
          [dto.trip_id, dto.driver_id, bid.proposed_fare, principal.user_id],
        )) as AcceptedTripRow[];

        const trip = updated[0];
        if (!trip) {
          throw new ConflictException('Trip was already accepted, cancelled, or otherwise modified');
        }

        await queryRunner.query(
          `
          UPDATE core.trip_bids
          SET status = CASE WHEN driver_id = $2 AND id = $3 THEN 'accepted' ELSE 'rejected' END,
              updated_at = NOW()
          WHERE trip_id = $1 AND status = 'active'
          `,
          [dto.trip_id, dto.driver_id, bid.bid_id],
        );

        await queryRunner.commitTransaction();
        accepted = trip;
        acceptedFare = bid.proposed_fare;
        riderId = bid.rider_id;
      } catch (error) {
        await queryRunner.rollbackTransaction();
        throw error;
      } finally {
        await queryRunner.release();
      }

      const ttlSeconds = this.config.getOrThrow<number>('BIDDING_TTL_SECONDS');
      const rejectedDriverIds = await this.redis.finalizeBidding({
        tripId: dto.trip_id,
        selectedDriverId: dto.driver_id,
        ttlSeconds,
        bidAcceptedPayload: JSON.stringify({
          event: 'bid_accepted',
          trip_id: dto.trip_id,
          rider_id: riderId,
          driver_id: dto.driver_id,
          accepted_fare: Number(acceptedFare),
        }),
        tripLockedPayload: JSON.stringify({
          event: 'trip_locked',
          trip_id: dto.trip_id,
          rider_id: riderId,
          driver_id: dto.driver_id,
          accepted_fare: Number(acceptedFare),
        }),
      });

      await this.redis.setEx(
        `driver:active-trip:${dto.driver_id}`,
        ACTIVE_TRIP_CACHE_TTL_SECONDS,
        dto.trip_id,
      );

      return {
        trip_id: accepted.id,
        driver_id: accepted.driver_id,
        fare_amount: accepted.fare_amount,
        status: accepted.status,
        rejected_driver_ids: rejectedDriverIds,
      };
    } finally {
      await this.redis.releaseLock(lockKey, lockToken);
    }
  }

  private async persistLatestActiveBid(input: {
    tripId: string;
    driverId: string;
    proposedFare: string;
    driverRating: number;
  }): Promise<string> {
    const runner = this.dataSource.createQueryRunner();
    await runner.connect();
    await runner.startTransaction();
    try {
      await runner.query(
        `
        UPDATE core.trip_bids
        SET status = 'superseded', updated_at = NOW()
        WHERE trip_id = $1 AND driver_id = $2 AND status = 'active'
        `,
        [input.tripId, input.driverId],
      );

      const rows = (await runner.query(
        `
        INSERT INTO core.trip_bids (trip_id, driver_id, proposed_fare, driver_rating, status)
        VALUES ($1, $2, $3::numeric, $4::numeric, 'active')
        RETURNING id
        `,
        [input.tripId, input.driverId, input.proposedFare, input.driverRating],
      )) as Array<{ id: string }>;

      const id = rows[0]?.id;
      if (!id) throw new Error('Failed to persist bid');
      await runner.commitTransaction();
      return id;
    } catch (error) {
      await runner.rollbackTransaction();
      throw error;
    } finally {
      await runner.release();
    }
  }

  private assertDriverPrincipal(principal: AuthPrincipal, driverId: string): void {
    if (principal.role !== 'driver' || !principal.driver_id || principal.driver_id !== driverId) {
      throw new ForbiddenException('Driver identity does not match access token');
    }
  }

  private assertRiderPrincipal(principal: AuthPrincipal): void {
    if (principal.role !== 'rider') {
      throw new ForbiddenException('Rider access token required');
    }
  }
}
