import {
  BadRequestException,
  HttpException,
  HttpStatus,
  Injectable,
  Logger,
  OnModuleInit,
  UnauthorizedException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { JwtService } from '@nestjs/jwt';
import { createHmac, randomBytes, randomUUID } from 'crypto';
import * as argon2 from 'argon2';
import { DataSource } from 'typeorm';
import { RedisService } from '../redis/redis.service';
import { AdminJwtPrincipal, AdminRole } from './admin-auth.types';
import { AdminSessionService } from './admin-session.service';
import { AdminLoginDto } from './dto/admin-login.dto';

type AdminAccountRow = {
  id: string;
  username: string;
  password_hash: string;
  role: AdminRole;
  permissions: string[];
  status: 'active' | 'disabled';
  failed_login_count: number;
  locked_until: Date | null;
};

export type AdminLoginResult = {
  accessToken: string;
  expiresInSeconds: number;
  principal: AdminJwtPrincipal;
};

@Injectable()
export class AdminAuthService implements OnModuleInit {
  private readonly logger = new Logger(AdminAuthService.name);
  private dummyPasswordHash = '';

  constructor(
    private readonly db: DataSource,
    private readonly redis: RedisService,
    private readonly jwt: JwtService,
    private readonly config: ConfigService,
    private readonly sessions: AdminSessionService,
  ) {}

  async onModuleInit(): Promise<void> {
    this.dummyPasswordHash = await argon2.hash(randomBytes(32), {
      type: argon2.argon2id,
      memoryCost: 19_456,
      timeCost: 2,
      parallelism: 1,
    });
  }

  assertSecureTransport(headers: Record<string, string | string[] | undefined>): void {
    const nodeEnv = this.config.get<string>('NODE_ENV', 'development');
    const requireHttps = this.config.get<boolean>('ADMIN_REQUIRE_HTTPS', nodeEnv === 'production');
    if (!requireHttps) return;

    const raw = headers['x-forwarded-proto'];
    const value = Array.isArray(raw) ? raw[0] : raw;
    const protocol = value?.split(',')[0]?.trim().toLowerCase();
    if (protocol !== 'https') {
      throw new BadRequestException('Secure transport required');
    }
  }

  async login(
    dto: AdminLoginDto,
    context: { ip: string; userAgent: string },
  ): Promise<AdminLoginResult> {
    const username = dto.username.trim().toLowerCase();
    await this.enforceRateLimit(username, context.ip);

    const rows = (await this.db.query(
      `
        SELECT
          id,
          username,
          password_hash,
          role,
          permissions,
          status,
          failed_login_count,
          locked_until
        FROM core.admin_accounts
        WHERE LOWER(username) = $1
        LIMIT 1
      `,
      [username],
    )) as AdminAccountRow[];

    const account = rows[0];
    const hashToVerify = account?.password_hash ?? this.dummyPasswordHash;

    let passwordMatches = false;
    try {
      passwordMatches = await argon2.verify(hashToVerify, dto.password, {
        type: argon2.argon2id,
      });
    } catch {
      passwordMatches = false;
    }

    const now = new Date();
    const lockExpired = !account?.locked_until || account.locked_until.getTime() <= now.getTime();
    const accountUsable = account?.status === 'active' && lockExpired;

    if (!account || !passwordMatches || !accountUsable) {
      if (account?.status === 'active' && lockExpired) {
        await this.registerFailedLogin(account.id);
      }
      await this.writeAudit('admin_login_failed', 'medium', context, account?.id);
      throw new UnauthorizedException('Invalid administrative credentials');
    }

    await this.db.query(
      `
        UPDATE core.admin_accounts
        SET failed_login_count = 0,
            locked_until = NULL,
            last_login_at = NOW(),
            updated_at = NOW()
        WHERE id = $1
      `,
      [account.id],
    );

    const permissions = this.normalizePermissions(account.role, account.permissions ?? []);
    const principal: AdminJwtPrincipal = {
      sub: account.id,
      role: account.role,
      permissions,
      sid: randomUUID(),
      jti: randomUUID(),
    };

    const ttlSeconds = this.config.get<number>('ADMIN_JWT_ACCESS_TTL_SECONDS', 900);
    const accessToken = await this.jwt.signAsync(
      {
        role: principal.role,
        permissions: principal.permissions,
        sid: principal.sid,
      },
      {
        secret: this.config.getOrThrow<string>('ADMIN_JWT_HS256_SECRET'),
        algorithm: 'HS256',
        subject: principal.sub,
        jwtid: principal.jti,
        issuer: this.config.get<string>('ADMIN_JWT_ISSUER', 'fida-ride-admin'),
        audience: this.config.get<string>('ADMIN_JWT_AUDIENCE', 'fida-admin'),
        expiresIn: ttlSeconds,
      },
    );

    await this.sessions.create(principal);
    await this.writeAudit('admin_login_success', 'info', context, account.id);

    return { accessToken, expiresInSeconds: ttlSeconds, principal };
  }

  private async enforceRateLimit(username: string, ip: string): Promise<void> {
    const windowSeconds = this.config.get<number>('ADMIN_LOGIN_RATE_WINDOW_SECONDS', 900);
    const perAccountMax = this.config.get<number>('ADMIN_LOGIN_RATE_ACCOUNT_MAX', 10);
    const perIpMax = this.config.get<number>('ADMIN_LOGIN_RATE_IP_MAX', 30);

    const [accountScore, ipScore] = await Promise.all([
      this.redis.addScoreWithTtl(
        `admin:login-rate:account:${this.fingerprint(`account:${username}`)}`,
        1,
        windowSeconds,
      ),
      this.redis.addScoreWithTtl(
        `admin:login-rate:ip:${this.fingerprint(`ip:${ip}`)}`,
        1,
        windowSeconds,
      ),
    ]);

    if (accountScore > perAccountMax || ipScore > perIpMax) {
      throw new HttpException('Authentication temporarily unavailable', HttpStatus.TOO_MANY_REQUESTS);
    }
  }

  private async registerFailedLogin(accountId: string): Promise<void> {
    const maxFailures = this.config.get<number>('ADMIN_LOGIN_MAX_FAILURES', 5);
    const lockSeconds = this.config.get<number>('ADMIN_LOGIN_LOCK_SECONDS', 900);

    await this.db.query(
      `
        UPDATE core.admin_accounts
        SET failed_login_count = failed_login_count + 1,
            locked_until = CASE
              WHEN failed_login_count + 1 >= $2
                THEN NOW() + ($3 * INTERVAL '1 second')
              ELSE locked_until
            END,
            updated_at = NOW()
        WHERE id = $1
      `,
      [accountId, maxFailures, lockSeconds],
    );
  }

  private normalizePermissions(role: AdminRole, permissions: string[]): string[] {
    const normalized = new Set(
      permissions
        .map((permission) => permission.trim())
        .filter((permission) => permission.length > 0 && permission.length <= 128),
    );
    if (role === 'super_admin') normalized.add('admin:*');
    return [...normalized].sort();
  }

  private fingerprint(value: string): string {
    const secret = this.config.get<string>(
      'ADMIN_LOGIN_RATE_HMAC_SECRET',
      this.config.getOrThrow<string>('ADMIN_JWT_HS256_SECRET'),
    );
    return createHmac('sha256', secret).update(`fida-admin-rate:${value}`).digest('hex');
  }

  private async writeAudit(
    eventType: string,
    severity: 'info' | 'medium',
    context: { ip: string; userAgent: string },
    adminAccountId?: string,
  ): Promise<void> {
    try {
      await this.db.query(
        `
          INSERT INTO core.security_audit_logs (
            source,
            event_type,
            severity,
            action,
            risk_score,
            confidence,
            reason_codes,
            metadata
          )
          VALUES (
            'admin_auth',
            $1,
            $2,
            'observe',
            0,
            1.0000,
            '[]'::jsonb,
            $3::jsonb
          )
        `,
        [
          eventType,
          severity,
          JSON.stringify({
            admin_account_id: adminAccountId ?? null,
            ip_hash: this.fingerprint(`ip:${context.ip}`),
            user_agent: context.userAgent.slice(0, 256),
          }),
        ],
      );
    } catch (error) {
      this.logger.warn(
        `Admin authentication audit write failed: ${error instanceof Error ? error.message : 'unknown error'}`,
      );
    }
  }
}
