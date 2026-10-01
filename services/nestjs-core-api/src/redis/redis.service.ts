import { Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { createClient } from 'redis';

@Injectable()
export class RedisService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(RedisService.name);
  private readonly client: ReturnType<typeof createClient>;

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
}
