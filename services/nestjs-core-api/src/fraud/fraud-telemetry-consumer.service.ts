import { Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { FraudDetectionService } from './fraud-detection.service';
import { RedisService } from '../redis/redis.service';
import { TelemetryVelocityJumpEvent } from './fraud.types';

const TELEMETRY_SECURITY_CHANNEL = 'security:telemetry-events';

@Injectable()
export class FraudTelemetryConsumerService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(FraudTelemetryConsumerService.name);
  private unsubscribe: (() => Promise<void>) | null = null;

  constructor(
    private readonly redis: RedisService,
    private readonly fraud: FraudDetectionService,
  ) {}

  async onModuleInit(): Promise<void> {
    this.unsubscribe = await this.redis.subscribe(TELEMETRY_SECURITY_CHANNEL, (message) => {
      void this.handle(message);
    });
  }

  async onModuleDestroy(): Promise<void> {
    if (this.unsubscribe) await this.unsubscribe();
    this.unsubscribe = null;
  }

  private async handle(raw: string): Promise<void> {
    try {
      const parsed = JSON.parse(raw) as unknown;
      if (!isVelocityJumpEvent(parsed)) {
        this.logger.warn('Ignoring malformed telemetry security event');
        return;
      }

      await this.fraud.assessTelemetryVelocity(parsed);
    } catch (error) {
      this.logger.error(
        'Telemetry fraud event processing failed',
        error instanceof Error ? error.stack : String(error),
      );
    }
  }
}

function isVelocityJumpEvent(value: unknown): value is TelemetryVelocityJumpEvent {
  if (!isRecord(value) || value.event !== 'telemetry_velocity_jump') return false;
  if (typeof value.driver_id !== 'string' || value.driver_id.length === 0) return false;
  if (!isFiniteNumber(value.speed_kph) || value.speed_kph < 0) return false;
  if (!isFiniteNumber(value.distance_meters) || value.distance_meters < 0) return false;
  if (!isFiniteNumber(value.elapsed_ms) || value.elapsed_ms <= 0) return false;
  if (typeof value.observed_at !== 'string' || value.observed_at.length === 0) return false;
  if (!isTelemetryPoint(value.previous) || !isTelemetryPoint(value.current)) return false;
  return true;
}

function isTelemetryPoint(value: unknown): value is TelemetryVelocityJumpEvent['previous'] {
  if (!isRecord(value)) return false;
  return (
    isFiniteNumber(value.latitude) &&
    value.latitude >= -90 &&
    value.latitude <= 90 &&
    isFiniteNumber(value.longitude) &&
    value.longitude >= -180 &&
    value.longitude <= 180 &&
    isFiniteNumber(value.observed_at_ms) &&
    value.observed_at_ms > 0
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value);
}
