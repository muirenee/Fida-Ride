import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { VehicleType } from '../common/vehicle-type';
import { RedisService } from '../redis/redis.service';

export interface BookingPointState {
  raw?: string;
  latitude?: number;
  longitude?: number;
  formattedAddress?: string;
}

export interface WhatsAppBookingSession {
  pickup?: BookingPointState;
  dropoff?: BookingPointState;
  vehicleTier: VehicleType;
  awaiting: 'pickup' | 'dropoff' | null;
  updatedAt: string;
}

@Injectable()
export class WhatsAppSessionService {
  constructor(
    private readonly redis: RedisService,
    private readonly config: ConfigService,
  ) {}

  async get(phone: string): Promise<WhatsAppBookingSession | null> {
    const raw = await this.redis.get(this.key(phone));
    if (!raw) return null;

    try {
      const value = JSON.parse(raw) as unknown;
      if (!isSession(value)) throw new Error('invalid session');
      return value;
    } catch {
      await this.clear(phone);
      return null;
    }
  }

  async save(phone: string, session: WhatsAppBookingSession): Promise<void> {
    const ttlSeconds = this.config.getOrThrow<number>('WHATSAPP_SESSION_TTL_SECONDS');
    session.updatedAt = new Date().toISOString();
    await this.redis.setEx(this.key(phone), ttlSeconds, JSON.stringify(session));
  }

  async clear(phone: string): Promise<void> {
    await this.redis.del(this.key(phone));
  }

  fresh(): WhatsAppBookingSession {
    return {
      vehicleTier: VehicleType.Taxi,
      awaiting: null,
      updatedAt: new Date().toISOString(),
    };
  }

  private key(phone: string): string {
    return `whatsapp:booking:session:${phone}`;
  }
}

function isSession(value: unknown): value is WhatsAppBookingSession {
  if (!isRecord(value)) return false;
  if (typeof value.updatedAt !== 'string') return false;
  if (!Object.values(VehicleType).includes(value.vehicleTier as VehicleType)) return false;
  if (value.awaiting !== null && value.awaiting !== 'pickup' && value.awaiting !== 'dropoff') return false;
  return true;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
