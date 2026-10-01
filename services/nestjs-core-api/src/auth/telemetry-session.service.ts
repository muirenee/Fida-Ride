import { ForbiddenException, Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { randomBytes, randomUUID } from 'node:crypto';
import { AuthPrincipal } from './jwt-auth.guard';
import { RedisService } from '../redis/redis.service';

@Injectable()
export class TelemetrySessionService {
  constructor(
    private readonly redis: RedisService,
    private readonly config: ConfigService,
  ) {}

  async issue(principal: AuthPrincipal): Promise<{
    session_id: string;
    session_key: string;
    expires_at: string;
  }> {
    if (principal.role !== 'driver' || !principal.driver_id) {
      throw new ForbiddenException('Driver account required for telemetry session issuance.');
    }

    const ttlSeconds = this.config.getOrThrow<number>('TELEMETRY_SESSION_TTL_SECONDS');
    const sessionId = randomUUID();
    const sessionKey = randomBytes(32);
    const driverId = principal.driver_id;

    await this.redis.setExMany([
      {
        key: this.activeSessionKey(driverId),
        ttlSeconds,
        value: sessionId,
      },
      {
        key: this.sessionKey(driverId, sessionId),
        ttlSeconds,
        value: sessionKey.toString('base64'),
      },
    ]);

    return {
      session_id: sessionId,
      session_key: sessionKey.toString('base64'),
      expires_at: new Date(Date.now() + ttlSeconds * 1000).toISOString(),
    };
  }

  private activeSessionKey(driverId: string): string {
    return `telemetry:active-session:${driverId}`;
  }

  private sessionKey(driverId: string, sessionId: string): string {
    return `telemetry:session:${driverId}:${sessionId}`;
  }
}
