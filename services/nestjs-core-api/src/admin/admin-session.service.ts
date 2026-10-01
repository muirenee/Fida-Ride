import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { RedisService } from '../redis/redis.service';
import { AdminJwtPrincipal, AdminSessionRecord } from './admin-auth.types';

const ADMIN_SESSION_REVOKED_CHANNEL = 'admin:session:revoked';

@Injectable()
export class AdminSessionService {
  constructor(
    private readonly redis: RedisService,
    private readonly config: ConfigService,
  ) {}

  async create(principal: AdminJwtPrincipal): Promise<void> {
    const ttlSeconds = this.config.getOrThrow<number>('ADMIN_JWT_ACCESS_TTL_SECONDS');
    const record: AdminSessionRecord = {
      sub: principal.sub,
      role: principal.role,
      permissions: principal.permissions,
      jti: principal.jti,
      issued_at: new Date().toISOString(),
    };

    await this.redis.setEx(this.key(principal.sid), ttlSeconds, JSON.stringify(record));
  }

  async validate(principal: AdminJwtPrincipal): Promise<boolean> {
    const raw = await this.redis.get(this.key(principal.sid));
    if (!raw) return false;

    let record: AdminSessionRecord;
    try {
      record = JSON.parse(raw) as AdminSessionRecord;
    } catch {
      return false;
    }

    if (
      record.sub !== principal.sub ||
      record.jti !== principal.jti ||
      record.role !== principal.role
    ) {
      return false;
    }

    if (!Array.isArray(record.permissions)) return false;
    if (record.permissions.length !== principal.permissions.length) return false;

    const expected = [...record.permissions].sort();
    const actual = [...principal.permissions].sort();
    return expected.every((permission, index) => permission === actual[index]);
  }

  async revoke(sessionId: string): Promise<void> {
    if (!sessionId) return;
    await this.redis.del(this.key(sessionId));
    await this.redis.publish(
      ADMIN_SESSION_REVOKED_CHANNEL,
      JSON.stringify({ sid: sessionId, revoked_at: new Date().toISOString() }),
    );
  }

  private key(sessionId: string): string {
    return `admin:session:${sessionId}`;
  }
}
