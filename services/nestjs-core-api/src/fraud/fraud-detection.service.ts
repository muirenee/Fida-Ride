import { ForbiddenException, Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { createHmac } from 'node:crypto';
import { DataSource } from 'typeorm';
import { AuthPrincipal } from '../auth/jwt-auth.guard';
import { RedisService } from '../redis/redis.service';
import {
  ApiRiskMetadata,
  FraudAction,
  FraudAssessmentResult,
  FraudSeverity,
  FraudSignal,
  TelemetryVelocityJumpEvent,
} from './fraud.types';

interface DriverIdentityRow {
  user_id: string;
  user_status: string;
  driver_status: string;
}

interface UserStatusRow {
  status: string;
}

@Injectable()
export class FraudDetectionService {
  private readonly logger = new Logger(FraudDetectionService.name);

  constructor(
    private readonly db: DataSource,
    private readonly redis: RedisService,
    private readonly config: ConfigService,
  ) {}

  async assertAccountAllowed(principal: AuthPrincipal): Promise<void> {
    const cacheKey = this.accountStateKey(principal.user_id);

    try {
      const cached = await this.redis.get(cacheKey);
      if (cached) {
        this.assertAllowedStatus(cached);
        return;
      }
    } catch (error) {
      this.logger.warn(
        `Fraud account-state cache unavailable for ${principal.user_id}: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    }

    const rows = await this.db.query<UserStatusRow[]>(
      'SELECT status FROM core.users WHERE id = $1 LIMIT 1',
      [principal.user_id],
    );
    const status = rows[0]?.status;
    if (!status) throw new ForbiddenException('Account is unavailable');

    try {
      await this.redis.setEx(
        cacheKey,
        this.config.getOrThrow<number>('FRAUD_ACCOUNT_STATE_CACHE_SECONDS'),
        status,
      );
    } catch (error) {
      this.logger.warn(
        `Unable to cache account security state for ${principal.user_id}: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    }

    this.assertAllowedStatus(status);
  }

  async assessApiRequest(
    principal: AuthPrincipal,
    input: ApiRiskMetadata,
  ): Promise<FraudAssessmentResult | null> {
    if (!this.config.get<boolean>('FRAUD_DETECTION_ENABLED', true)) return null;

    const signals: FraudSignal[] = [];
    let deviceHash: string | undefined;

    if (input.deviceId) {
      deviceHash = this.hashDeviceId(input.deviceId);

      try {
        const conflictingOwner = await this.redis.claimDeviceOwner(
          `fraud:device-owner:${deviceHash}`,
          principal.user_id,
          this.config.getOrThrow<number>('FRAUD_DEVICE_BIND_TTL_SECONDS'),
        );

        if (conflictingOwner && conflictingOwner !== principal.user_id) {
          signals.push({
            code: 'device_parallel_accounts',
            weight: this.config.getOrThrow<number>('FRAUD_WEIGHT_DEVICE_PARALLEL_ACCOUNT'),
            metadata: {
              conflicting_account_id: conflictingOwner,
            },
          });
        }
      } catch (error) {
        this.logger.warn(
          `Device ownership check failed: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
    }

    if (input.deviceTimestampInvalid) {
      signals.push({
        code: 'device_timestamp_invalid',
        weight: this.config.getOrThrow<number>('FRAUD_WEIGHT_INVALID_DEVICE_TIMESTAMP'),
      });
    } else if (input.deviceTimestampMs !== undefined) {
      const skewMs = Math.abs(Date.now() - input.deviceTimestampMs);
      const allowedSkew = this.config.getOrThrow<number>('FRAUD_DEVICE_CLOCK_SKEW_MS');
      if (skewMs > allowedSkew) {
        signals.push({
          code: 'device_clock_skew',
          weight: this.config.getOrThrow<number>('FRAUD_WEIGHT_DEVICE_CLOCK_SKEW'),
          metadata: {
            skew_ms: skewMs,
            allowed_skew_ms: allowedSkew,
          },
        });
      }
    }

    if (input.mockLocation === true) {
      signals.push({
        code: 'mock_location_reported',
        weight: this.config.getOrThrow<number>('FRAUD_WEIGHT_MOCK_LOCATION'),
      });
    }

    if (signals.length === 0) return null;

    return this.applySignals({
      userId: principal.user_id,
      driverId: principal.driver_id,
      source: 'core_api',
      eventType: 'api_request_risk',
      deviceHash,
      requestId: input.requestId,
      signals,
      metadata: {
        method: input.method,
        path: input.path,
        remote_ip: input.remoteIp,
      },
    });
  }

  async assessTelemetryVelocity(
    event: TelemetryVelocityJumpEvent,
  ): Promise<FraudAssessmentResult | null> {
    if (!this.config.get<boolean>('FRAUD_DETECTION_ENABLED', true)) return null;

    const rows = await this.db.query<DriverIdentityRow[]>(
      `
        SELECT
          d.user_id,
          u.status AS user_status,
          d.verification_status AS driver_status
        FROM core.drivers d
        JOIN core.users u ON u.id = d.user_id
        WHERE d.id = $1
        LIMIT 1
      `,
      [event.driver_id],
    );

    const identity = rows[0];
    if (!identity) {
      this.logger.warn(`Velocity event referenced unknown driver ${event.driver_id}`);
      return null;
    }

    const signal: FraudSignal = {
      code: 'telemetry_velocity_jump',
      weight: this.config.getOrThrow<number>('FRAUD_WEIGHT_VELOCITY_JUMP'),
      metadata: {
        speed_kph: event.speed_kph,
        distance_meters: event.distance_meters,
        elapsed_ms: event.elapsed_ms,
        previous: event.previous,
        current: event.current,
      },
    };

    return this.applySignals({
      userId: identity.user_id,
      driverId: event.driver_id,
      source: 'go_telemetry',
      eventType: 'telemetry_velocity_jump',
      signals: [signal],
      metadata: {
        observed_at: event.observed_at,
        user_status_at_detection: identity.user_status,
        driver_status_at_detection: identity.driver_status,
      },
    });
  }

  private async applySignals(input: {
    userId: string;
    driverId?: string;
    source: string;
    eventType: string;
    deviceHash?: string;
    requestId?: string;
    signals: FraudSignal[];
    metadata?: Record<string, unknown>;
  }): Promise<FraudAssessmentResult> {
    const increment = input.signals.reduce((sum, signal) => sum + signal.weight, 0);
    const riskWindowSeconds = this.config.getOrThrow<number>('FRAUD_RISK_WINDOW_SECONDS');

    let riskScore = increment;
    try {
      riskScore = await this.redis.addScoreWithTtl(
        this.riskScoreKey(input.userId),
        increment,
        riskWindowSeconds,
      );
    } catch (error) {
      this.logger.error(
        `Distributed fraud score unavailable for ${input.userId}; using current signal batch only`,
        error instanceof Error ? error.stack : String(error),
      );
    }

    const confidence = Math.min(1, Math.max(0, riskScore / 100));
    const action = this.actionForScore(riskScore);
    const severity = this.severityFor(action, riskScore);

    await this.persistAssessment({
      userId: input.userId,
      driverId: input.driverId,
      source: input.source,
      eventType: input.eventType,
      deviceHash: input.deviceHash,
      requestId: input.requestId,
      riskScore,
      confidence,
      action,
      severity,
      signals: input.signals,
      metadata: input.metadata ?? {},
    });

    if (action !== 'observe') {
      await this.enforceSecurityHold(
        input.userId,
        input.driverId,
        action,
        input.signals.map((signal) => signal.code),
      );
    }

    return {
      riskScore,
      confidence,
      action,
      signals: input.signals,
    };
  }

  private async persistAssessment(input: {
    userId: string;
    driverId?: string;
    source: string;
    eventType: string;
    deviceHash?: string;
    requestId?: string;
    riskScore: number;
    confidence: number;
    action: FraudAction;
    severity: FraudSeverity;
    signals: FraudSignal[];
    metadata: Record<string, unknown>;
  }): Promise<void> {
    await this.db.transaction(async (manager) => {
      if (input.action === 'flagged') {
        await manager.query(
          `UPDATE core.users SET status = 'flagged', updated_at = NOW()
           WHERE id = $1 AND status = 'active'`,
          [input.userId],
        );
        await manager.query(
          `UPDATE core.drivers SET verification_status = 'flagged', updated_at = NOW()
           WHERE user_id = $1 AND verification_status IN ('pending', 'approved')`,
          [input.userId],
        );
      } else if (input.action === 'suspended') {
        await manager.query(
          `UPDATE core.users SET status = 'suspended', updated_at = NOW()
           WHERE id = $1 AND status IN ('active', 'flagged')`,
          [input.userId],
        );
        await manager.query(
          `UPDATE core.drivers SET verification_status = 'suspended', updated_at = NOW()
           WHERE user_id = $1 AND verification_status IN ('pending', 'approved', 'flagged')`,
          [input.userId],
        );
      }

      await manager.query(
        `
          INSERT INTO core.security_audit_logs (
            actor_user_id,
            driver_id,
            device_hash,
            request_id,
            source,
            event_type,
            severity,
            action,
            risk_score,
            confidence,
            reason_codes,
            metadata
          ) VALUES (
            $1, $2, $3, $4, $5, $6, $7, $8, $9, $10,
            $11::jsonb, $12::jsonb
          )
        `,
        [
          input.userId,
          input.driverId ?? null,
          input.deviceHash ?? null,
          input.requestId ?? null,
          input.source,
          input.eventType,
          input.severity,
          input.action,
          input.riskScore,
          input.confidence,
          JSON.stringify(input.signals.map((signal) => signal.code)),
          JSON.stringify({
            ...input.metadata,
            signals: input.signals,
          }),
        ],
      );
    });
  }

  private async enforceSecurityHold(
    userId: string,
    driverId: string | undefined,
    action: Exclude<FraudAction, 'observe'>,
    reasons: string[],
  ): Promise<void> {
    const stateTtl = this.config.getOrThrow<number>('FRAUD_BLOCK_CACHE_TTL_SECONDS');
    const accountState = action;

    try {
      await this.redis.setEx(this.accountStateKey(userId), stateTtl, accountState);
      await this.redis.publish(
        'security:disconnect',
        JSON.stringify({
          event: 'security_disconnect',
          user_id: userId,
          driver_id: driverId ?? '',
          action,
          reason: reasons.join(','),
          issued_at: new Date().toISOString(),
        }),
      );
    } catch (error) {
      this.logger.error(
        `Security hold persisted but realtime disconnect failed for ${userId}`,
        error instanceof Error ? error.stack : String(error),
      );
    }
  }

  private actionForScore(score: number): FraudAction {
    if (score >= this.config.getOrThrow<number>('FRAUD_SUSPEND_THRESHOLD')) {
      return 'suspended';
    }
    if (score >= this.config.getOrThrow<number>('FRAUD_FLAG_THRESHOLD')) {
      return 'flagged';
    }
    return 'observe';
  }

  private severityFor(action: FraudAction, score: number): FraudSeverity {
    if (action === 'suspended') return 'critical';
    if (action === 'flagged') return 'high';
    if (score >= 40) return 'medium';
    return 'low';
  }

  private hashDeviceId(deviceId: string): string {
    return createHmac('sha256', this.config.getOrThrow<string>('FRAUD_DEVICE_HMAC_SECRET'))
      .update(deviceId.trim(), 'utf8')
      .digest('hex');
  }

  private assertAllowedStatus(status: string): void {
    if (status !== 'active') {
      throw new ForbiddenException(`Account access is blocked by security status: ${status}`);
    }
  }

  private riskScoreKey(userId: string): string {
    return `fraud:risk:user:${userId}`;
  }

  private accountStateKey(userId: string): string {
    return `fraud:account-state:${userId}`;
  }
}
