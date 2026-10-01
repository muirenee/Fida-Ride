import { Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { DataSource } from 'typeorm';
import { VehicleType } from '../common/vehicle-type';
import { WhatsAppInboxEntity } from '../database/entities/whatsapp-inbox.entity';
import { RidesService } from '../rides/rides.service';
import { UsersService } from '../users/users.service';
import { BookingParserService } from './booking-parser.service';
import { GeocodingService } from './geocoding.service';
import { WhatsAppCloudService } from './whatsapp-cloud.service';
import {
  BookingPointState,
  WhatsAppBookingSession,
  WhatsAppSessionService,
} from './whatsapp-session.service';

@Injectable()
export class WhatsAppBookingProcessorService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(WhatsAppBookingProcessorService.name);
  private timer: NodeJS.Timeout | null = null;
  private running = false;

  constructor(
    private readonly dataSource: DataSource,
    private readonly config: ConfigService,
    private readonly parser: BookingParserService,
    private readonly geocoding: GeocodingService,
    private readonly sessions: WhatsAppSessionService,
    private readonly cloud: WhatsAppCloudService,
    private readonly users: UsersService,
    private readonly rides: RidesService,
  ) {}

  onModuleInit(): void {
    if (!this.config.get<boolean>('WHATSAPP_BOT_ENABLED', false)) return;

    const pollMs = this.config.getOrThrow<number>('WHATSAPP_WORKER_POLL_MS');
    this.timer = setInterval(() => {
      void this.tick();
    }, pollMs);
    this.timer.unref();
    void this.tick();
  }

  onModuleDestroy(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  private async tick(): Promise<void> {
    if (this.running) return;
    this.running = true;

    try {
      const batchSize = this.config.getOrThrow<number>('WHATSAPP_WORKER_BATCH_SIZE');
      for (let index = 0; index < batchSize; index += 1) {
        const message = await this.claimOne();
        if (!message) break;
        await this.processClaimed(message);
      }
    } catch (error) {
      this.logger.error(
        'WhatsApp worker tick failed',
        error instanceof Error ? error.stack : String(error),
      );
    } finally {
      this.running = false;
    }
  }

  private async claimOne(): Promise<WhatsAppInboxEntity | null> {
    const staleSeconds = this.config.getOrThrow<number>('WHATSAPP_PROCESSING_LEASE_SECONDS');

    return this.dataSource.transaction(async (manager) => {
      const rows = (await manager.query(
        `
          SELECT id
          FROM core.whatsapp_inbox
          WHERE (
            status = 'pending'
            AND next_attempt_at <= NOW()
          ) OR (
            status = 'processing'
            AND locked_at < NOW() - ($1 * INTERVAL '1 second')
          )
          ORDER BY created_at ASC
          FOR UPDATE SKIP LOCKED
          LIMIT 1
        `,
        [staleSeconds],
      )) as Array<{ id: string }>;

      const row = rows[0];
      if (!row) return null;

      await manager.update(
        WhatsAppInboxEntity,
        { id: row.id },
        {
          status: 'processing',
          attempts: () => 'attempts + 1',
          lockedAt: new Date(),
          updatedAt: new Date(),
          lastError: null,
        },
      );

      return manager.findOneByOrFail(WhatsAppInboxEntity, { id: row.id });
    });
  }

  private async processClaimed(message: WhatsAppInboxEntity): Promise<void> {
    try {
      await this.processMessage(message);
      await this.dataSource.getRepository(WhatsAppInboxEntity).update(
        { id: message.id },
        {
          status: 'completed',
          processedAt: new Date(),
          lockedAt: null,
          lastError: null,
          updatedAt: new Date(),
        },
      );
    } catch (error) {
      await this.scheduleRetry(message, error);
    }
  }

  private async processMessage(message: WhatsAppInboxEntity): Promise<void> {
    if (message.messageType !== 'text' && message.messageType !== 'location') {
      await this.cloud.sendText(
        message.senderPhone,
        'I can book a Fida-Ride from a text request or a WhatsApp location pin. Please send your pickup and destination.',
        message.messageId,
      );
      return;
    }

    const user = await this.users.findByPhone(message.senderPhone);
    if (!user) {
      await this.cloud.sendText(
        message.senderPhone,
        'This WhatsApp number is not linked to a Fida-Ride account. Please register or link this number in Fida-Ride before booking here.',
        message.messageId,
      );
      return;
    }

    if (user.status !== 'active') {
      await this.cloud.sendText(
        message.senderPhone,
        'Your Fida-Ride account is not active, so I cannot create a ride request from WhatsApp yet.',
        message.messageId,
      );
      return;
    }

    if (message.messageType === 'location') {
      await this.handleLocationMessage(message, user.id);
      return;
    }

    await this.handleTextMessage(message, user.id);
  }

  private async handleTextMessage(message: WhatsAppInboxEntity, riderId: string): Promise<void> {
    const text = message.messageText?.trim();
    if (!text) {
      await this.cloud.sendText(
        message.senderPhone,
        'Please send a text such as “Taxi from Kigali Heights to Kigali International Airport”.',
        message.messageId,
      );
      return;
    }

    const extraction = await this.parser.parse(text);
    const session = (await this.sessions.get(message.senderPhone)) ?? this.sessions.fresh();
    const hadConversationContext = Boolean(session.pickup || session.dropoff || session.awaiting);
    const explicitVehicleTier = this.parser.explicitVehicleTier(text);

    if (extraction.pickup_raw) {
      session.pickup = { raw: extraction.pickup_raw };
    }
    if (extraction.dropoff_raw) {
      session.dropoff = { raw: extraction.dropoff_raw };
    }
    if (!hadConversationContext || explicitVehicleTier) {
      session.vehicleTier = explicitVehicleTier ?? extraction.vehicle_tier;
    }

    if (!extraction.pickup_raw && !extraction.dropoff_raw && session.awaiting) {
      const candidate = this.parser.locationCandidate(text);
      if (candidate) {
        if (session.awaiting === 'pickup') session.pickup = { raw: candidate };
        else session.dropoff = { raw: candidate };
      }
    }

    const threshold = this.config.getOrThrow<number>('WHATSAPP_BOOKING_MIN_CONFIDENCE');
    const hasBothFromCurrentMessage = Boolean(extraction.pickup_raw && extraction.dropoff_raw);
    if (hasBothFromCurrentMessage && extraction.confidence_score < threshold) {
      session.awaiting = null;
      await this.sessions.save(message.senderPhone, session);
      await this.cloud.sendText(
        message.senderPhone,
        'I am not confident I understood both locations. Please restate them clearly, for example: “Taxi from Kigali Heights to Kigali International Airport”.',
        message.messageId,
      );
      return;
    }

    await this.resolveAndDispatch(message, riderId, session);
  }

  private async handleLocationMessage(message: WhatsAppInboxEntity, riderId: string): Promise<void> {
    if (!Number.isFinite(message.locationLat) || !Number.isFinite(message.locationLng)) {
      await this.cloud.sendText(
        message.senderPhone,
        'I could not read that location pin. Please share the location again.',
        message.messageId,
      );
      return;
    }

    const session = (await this.sessions.get(message.senderPhone)) ?? this.sessions.fresh();
    const point: BookingPointState = {
      latitude: message.locationLat as number,
      longitude: message.locationLng as number,
      formattedAddress: message.locationName || message.locationAddress || 'Shared location',
    };

    if (session.awaiting === 'dropoff') {
      session.dropoff = point;
    } else {
      session.pickup = point;
    }

    await this.resolveAndDispatch(message, riderId, session);
  }

  private async resolveAndDispatch(
    message: WhatsAppInboxEntity,
    riderId: string,
    session: WhatsAppBookingSession,
  ): Promise<void> {
    if (!session.pickup) {
      session.awaiting = 'pickup';
      await this.sessions.save(message.senderPhone, session);
      await this.cloud.sendText(
        message.senderPhone,
        session.dropoff?.raw
          ? `I have your destination as ${session.dropoff.raw}. Where should I pick you up? Send a place/address or share a WhatsApp location pin.`
          : 'Where should I pick you up? Send a place/address or share a WhatsApp location pin.',
        message.messageId,
      );
      return;
    }

    if (!session.dropoff) {
      session.awaiting = 'dropoff';
      await this.sessions.save(message.senderPhone, session);
      await this.cloud.sendText(
        message.senderPhone,
        'Where are you going? Send the destination place/address or share its WhatsApp location pin.',
        message.messageId,
      );
      return;
    }

    const pickup = await this.resolvePoint(session.pickup);
    if (!pickup) {
      session.awaiting = 'pickup';
      await this.sessions.save(message.senderPhone, session);
      await this.cloud.sendText(
        message.senderPhone,
        `I could not safely resolve the pickup${session.pickup.raw ? ` “${session.pickup.raw}”` : ''}. Please share the exact pickup location pin.`,
        message.messageId,
      );
      return;
    }
    session.pickup = pickup;

    const dropoff = await this.resolvePoint(session.dropoff);
    if (!dropoff) {
      session.awaiting = 'dropoff';
      await this.sessions.save(message.senderPhone, session);
      await this.cloud.sendText(
        message.senderPhone,
        `I could not safely resolve the destination${session.dropoff.raw ? ` “${session.dropoff.raw}”` : ''}. Please share the exact destination location pin.`,
        message.messageId,
      );
      return;
    }
    session.dropoff = dropoff;
    session.awaiting = null;

    const ride = await this.rides.requestRide(
      {
        rider_id: riderId,
        pickup_lat: pickup.latitude as number,
        pickup_lng: pickup.longitude as number,
        dropoff_lat: dropoff.latitude as number,
        dropoff_lng: dropoff.longitude as number,
        vehicle_type: session.vehicleTier,
      },
      {
        sourceChannel: 'whatsapp',
        sourceRequestId: message.messageId,
      },
    );

    await this.sessions.clear(message.senderPhone);

    const fare = ride.estimated_fare ? this.formatMoney(ride.estimated_fare) : 'pending';
    await this.cloud.sendText(
      message.senderPhone,
      [
        'Fida-Ride request created ✅',
        `Pickup: ${pickup.formattedAddress ?? pickup.raw ?? 'shared location'}`,
        `Destination: ${dropoff.formattedAddress ?? dropoff.raw ?? 'shared location'}`,
        `Vehicle: ${this.vehicleLabel(session.vehicleTier)}`,
        `Estimated fare: ${fare === 'pending' ? fare : `RWF ${fare}`}`,
        `Reference: ${ride.trip_id}`,
        'We are now searching for an available driver.',
      ].join('\n'),
      message.messageId,
    );
  }

  private async resolvePoint(point: BookingPointState): Promise<BookingPointState | null> {
    if (Number.isFinite(point.latitude) && Number.isFinite(point.longitude)) return point;
    if (!point.raw) return null;

    const geocoded = await this.geocoding.geocode(point.raw);
    if (!geocoded) return null;

    return {
      raw: point.raw,
      latitude: geocoded.latitude,
      longitude: geocoded.longitude,
      formattedAddress: geocoded.formatted_address,
    };
  }

  private async scheduleRetry(message: WhatsAppInboxEntity, error: unknown): Promise<void> {
    const attempts = message.attempts;
    const maxAttempts = this.config.getOrThrow<number>('WHATSAPP_WORKER_MAX_ATTEMPTS');
    const errorMessage = error instanceof Error ? error.message : String(error);
    const repository = this.dataSource.getRepository(WhatsAppInboxEntity);

    if (attempts >= maxAttempts) {
      this.logger.error(`WhatsApp message ${message.messageId} moved to failed after ${attempts} attempts`);
      await repository.update(
        { id: message.id },
        {
          status: 'failed',
          lockedAt: null,
          lastError: errorMessage.slice(0, 2000),
          updatedAt: new Date(),
        },
      );

      try {
        await this.cloud.sendText(
          message.senderPhone,
          'I could not complete your Fida-Ride request because a service is temporarily unavailable. Please try again shortly.',
          message.messageId,
        );
      } catch {
        // The original provider failure may itself be WhatsApp delivery; do not loop forever.
      }
      return;
    }

    const delaySeconds = Math.min(300, 5 * 2 ** Math.max(0, attempts - 1));
    await repository.update(
      { id: message.id },
      {
        status: 'pending',
        lockedAt: null,
        nextAttemptAt: new Date(Date.now() + delaySeconds * 1000),
        lastError: errorMessage.slice(0, 2000),
        updatedAt: new Date(),
      },
    );
  }

  private formatMoney(value: string): string {
    const amount = Number(value);
    if (!Number.isFinite(amount)) return value;
    return new Intl.NumberFormat('en-RW', { maximumFractionDigits: 0 }).format(amount);
  }

  private vehicleLabel(value: VehicleType): string {
    switch (value) {
      case VehicleType.Moto:
        return 'Moto';
      case VehicleType.Premium:
        return 'Premium';
      case VehicleType.TukTuk:
        return 'Tuk-Tuk';
      case VehicleType.Ev:
        return 'EV';
      case VehicleType.Accessible:
        return 'Accessible';
      case VehicleType.Other:
        return 'Other';
      case VehicleType.Taxi:
      default:
        return 'Taxi';
    }
  }
}
