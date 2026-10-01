import { Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { createClient } from 'redis';

const BIDDING_EVENTS_CHANNEL = 'bidding:events';

export interface RedisGeoMemberPosition {
  member: string;
  longitude: number;
  latitude: number;
}

const recordCounterOfferScript = `
local state = redis.call('GET', KEYS[1])
if state ~= 'broadcasted' and state ~= 'counter_offers_received' then
  return 0
end
redis.call('ZADD', KEYS[2], ARGV[1], ARGV[2])
redis.call('EXPIRE', KEYS[2], ARGV[3])
redis.call('SET', KEYS[3], ARGV[4], 'EX', ARGV[3])
redis.call('SET', KEYS[1], 'counter_offers_received', 'EX', ARGV[3])
redis.call('PUBLISH', ARGV[5], ARGV[4])
return 1
`;

const finalizeBiddingScript = `
local state = redis.call('GET', KEYS[1])
if state ~= 'broadcasted' and state ~= 'counter_offers_received' then
  return {}
end
redis.call('SET', KEYS[1], 'bid_accepted', 'EX', ARGV[3])
redis.call('PUBLISH', ARGV[4], ARGV[5])
local drivers = redis.call('ZRANGE', KEYS[2], 0, -1)
local rejected = {}
for _, driverID in ipairs(drivers) do
  if driverID ~= ARGV[1] then
    table.insert(rejected, driverID)
  end
  redis.call('DEL', ARGV[2] .. driverID)
end
redis.call('DEL', KEYS[2])
redis.call('DEL', KEYS[3])
redis.call('SET', KEYS[1], 'trip_locked', 'EX', ARGV[3])
redis.call('PUBLISH', ARGV[4], ARGV[6])
return rejected
`;

const releaseLockScript = `
if redis.call('GET', KEYS[1]) == ARGV[1] then
  return redis.call('DEL', KEYS[1])
end
return 0
`;

const claimDeviceOwnerScript = `
local owner = redis.call('GET', KEYS[1])
if not owner then
  redis.call('SET', KEYS[1], ARGV[1], 'EX', ARGV[2])
  return ''
end
if owner == ARGV[1] then
  redis.call('EXPIRE', KEYS[1], ARGV[2])
  return ''
end
return owner
`;

const addScoreWithTtlScript = `
local score = redis.call('INCRBY', KEYS[1], ARGV[1])
redis.call('EXPIRE', KEYS[1], ARGV[2])
return score
`;

@Injectable()
export class RedisService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(RedisService.name);
  private readonly client: ReturnType<typeof createClient>;
  private readonly subscribers = new Set<ReturnType<typeof createClient>>();

  constructor(private readonly config: ConfigService) {
    this.client = createClient({
      socket: {
        host: this.config.getOrThrow<string>('REDIS_HOST'),
        port: this.config.getOrThrow<number>('REDIS_PORT'),
        reconnectStrategy: (retries) => Math.min(retries * 100, 3000),
      },
      password: this.config.getOrThrow<string>('REDIS_PASSWORD'),
      database: this.config.getOrThrow<number>('REDIS_DB'),
    });

    this.client.on('error', (error) => {
      this.logger.error('Redis client error', error instanceof Error ? error.stack : String(error));
    });
  }

  async onModuleInit(): Promise<void> {
    await this.client.connect();
    await this.client.ping();
    this.logger.log('Redis connection ready');
  }

  async onModuleDestroy(): Promise<void> {
    for (const subscriber of this.subscribers) {
      try {
        if (subscriber.isOpen) await subscriber.close();
      } catch (error) {
        this.logger.warn(
          `Redis subscriber close failed: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
    }
    this.subscribers.clear();

    if (this.client.isOpen) await this.client.close();
  }

  ping(): Promise<string> {
    return this.client.ping();
  }

  get(key: string): Promise<string | null> {
    return this.client.get(key);
  }

  setEx(key: string, ttlSeconds: number, value: string): Promise<string | null> {
    return this.client.setEx(key, ttlSeconds, value);
  }

  async setExMany(
    entries: Array<{ key: string; ttlSeconds: number; value: string }>,
  ): Promise<void> {
    if (entries.length === 0) return;

    const transaction = this.client.multi();
    for (const entry of entries) {
      transaction.setEx(entry.key, entry.ttlSeconds, entry.value);
    }
    await transaction.exec();
  }

  async del(...keys: string[]): Promise<number> {
    if (keys.length === 0) return 0;
    return this.client.del(keys);
  }

  incr(key: string): Promise<number> {
    return this.client.incr(key);
  }

  mGet(keys: string[]): Promise<Array<string | null>> {
    if (keys.length === 0) return Promise.resolve([]);
    return this.client.mGet(keys);
  }

  publish(channel: string, payload: string): Promise<number> {
    return this.client.publish(channel, payload);
  }

  async subscribe(
    channel: string,
    listener: (message: string) => void | Promise<void>,
  ): Promise<() => Promise<void>> {
    const subscriber = this.client.duplicate();
    subscriber.on('error', (error) => {
      this.logger.error(
        `Redis subscriber error on ${channel}`,
        error instanceof Error ? error.stack : String(error),
      );
    });

    await subscriber.connect();
    await subscriber.subscribe(channel, (message) => {
      void Promise.resolve(listener(message)).catch((error: unknown) => {
        this.logger.error(
          `Redis subscription handler failed on ${channel}`,
          error instanceof Error ? error.stack : String(error),
        );
      });
    });
    this.subscribers.add(subscriber);

    return async () => {
      if (!this.subscribers.delete(subscriber)) return;
      if (!subscriber.isOpen) return;
      await subscriber.unsubscribe(channel);
      await subscriber.close();
    };
  }

  async claimDeviceOwner(
    key: string,
    userId: string,
    ttlSeconds: number,
  ): Promise<string | null> {
    const result = await this.client.eval(claimDeviceOwnerScript, {
      keys: [key],
      arguments: [userId, String(ttlSeconds)],
    });
    const owner = String(result ?? '');
    return owner.length > 0 ? owner : null;
  }

  async addScoreWithTtl(key: string, increment: number, ttlSeconds: number): Promise<number> {
    const result = await this.client.eval(addScoreWithTtlScript, {
      keys: [key],
      arguments: [String(increment), String(ttlSeconds)],
    });
    return Number(result);
  }

  async geoSearch(
    key: string,
    longitude: number,
    latitude: number,
    radiusKm: number,
    limit: number,
  ): Promise<string[]> {
    const reply = await this.client.geoSearch(
      key,
      { longitude, latitude },
      { radius: radiusKm, unit: 'km' },
      { SORT: 'ASC', COUNT: limit },
    );

    return reply.map((member) => String(member));
  }

  async geoSearchWithCoordinates(
    key: string,
    longitude: number,
    latitude: number,
    radiusKm: number,
    limit: number,
  ): Promise<RedisGeoMemberPosition[]> {
    const members = await this.geoSearch(key, longitude, latitude, radiusKm, limit);
    if (members.length === 0) return [];

    const positions = await this.client.geoPos(key, members);
    const result: RedisGeoMemberPosition[] = [];

    for (let index = 0; index < members.length; index += 1) {
      const position = positions[index];
      if (!position) continue;

      const memberLongitude = Number(position.longitude);
      const memberLatitude = Number(position.latitude);
      if (!Number.isFinite(memberLongitude) || !Number.isFinite(memberLatitude)) continue;

      result.push({
        member: members[index],
        longitude: memberLongitude,
        latitude: memberLatitude,
      });
    }

    return result;
  }

  async openBidding(tripId: string, eligibleDriverIds: string[], ttlSeconds: number): Promise<void> {
    const stateKey = this.biddingStateKey(tripId);
    const offersKey = this.biddingOffersKey(tripId);
    const eligibleKey = this.biddingEligibleKey(tripId);

    await this.client.del([offersKey, eligibleKey]);
    await this.client.set(stateKey, 'bidding_initiated', { EX: ttlSeconds });
    if (eligibleDriverIds.length > 0) {
      await this.client.sAdd(eligibleKey, eligibleDriverIds);
      await this.client.expire(eligibleKey, ttlSeconds);
    }
    await this.client.set(stateKey, 'broadcasted', { EX: ttlSeconds });
  }

  getBiddingState(tripId: string): Promise<string | null> {
    return this.client.get(this.biddingStateKey(tripId));
  }

  async isBiddingDriverEligible(tripId: string, driverId: string): Promise<boolean> {
    return (await this.client.sIsMember(this.biddingEligibleKey(tripId), driverId)) === 1;
  }

  async recordCounterOffer(input: {
    tripId: string;
    driverId: string;
    fareScore: number;
    ttlSeconds: number;
    payload: string;
  }): Promise<boolean> {
    const result = await this.client.eval(recordCounterOfferScript, {
      keys: [
        this.biddingStateKey(input.tripId),
        this.biddingOffersKey(input.tripId),
        this.biddingOfferKey(input.tripId, input.driverId),
      ],
      arguments: [
        String(input.fareScore),
        input.driverId,
        String(input.ttlSeconds),
        input.payload,
        BIDDING_EVENTS_CHANNEL,
      ],
    });

    return Number(result) === 1;
  }

  async acquireLock(key: string, token: string, ttlMs: number): Promise<boolean> {
    const result = await this.client.set(key, token, { NX: true, PX: ttlMs });
    return result === 'OK';
  }

  async releaseLock(key: string, token: string): Promise<void> {
    await this.client.eval(releaseLockScript, {
      keys: [key],
      arguments: [token],
    });
  }

  async finalizeBidding(input: {
    tripId: string;
    selectedDriverId: string;
    ttlSeconds: number;
    bidAcceptedPayload: string;
    tripLockedPayload: string;
  }): Promise<string[]> {
    const result = await this.client.eval(finalizeBiddingScript, {
      keys: [
        this.biddingStateKey(input.tripId),
        this.biddingOffersKey(input.tripId),
        this.biddingEligibleKey(input.tripId),
      ],
      arguments: [
        input.selectedDriverId,
        `bidding:trip:${input.tripId}:offer:`,
        String(input.ttlSeconds),
        BIDDING_EVENTS_CHANNEL,
        input.bidAcceptedPayload,
        input.tripLockedPayload,
      ],
    });

    if (!Array.isArray(result)) return [];
    return result.map((driverId) => String(driverId));
  }

  private biddingStateKey(tripId: string): string {
    return `bidding:trip:${tripId}:state`;
  }

  private biddingOffersKey(tripId: string): string {
    return `bidding:trip:${tripId}:offers`;
  }

  private biddingEligibleKey(tripId: string): string {
    return `bidding:trip:${tripId}:eligible`;
  }

  private biddingOfferKey(tripId: string, driverId: string): string {
    return `bidding:trip:${tripId}:offer:${driverId}`;
  }
}
