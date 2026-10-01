import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { QueryFailedError, Repository } from 'typeorm';
import { WhatsAppInboxEntity } from '../database/entities/whatsapp-inbox.entity';
import {
  WhatsAppInboundMessage,
  WhatsAppWebhookPayload,
} from './dto/whatsapp-webhook.dto';

@Injectable()
export class WhatsAppInboxService {
  constructor(
    @InjectRepository(WhatsAppInboxEntity)
    private readonly inbox: Repository<WhatsAppInboxEntity>,
  ) {}

  async enqueue(payload: WhatsAppWebhookPayload): Promise<number> {
    if (payload.object !== 'whatsapp_business_account') return 0;

    const messages = this.extractMessages(payload);
    let inserted = 0;

    for (const message of messages) {
      const messageId = message.id?.trim();
      const senderPhone = normalizeE164(message.from ?? '');
      if (!messageId || !senderPhone) continue;

      try {
        await this.inbox.save(
          this.inbox.create({
            messageId,
            senderPhone,
            messageType: message.type?.trim() || 'unsupported',
            messageText: message.text?.body?.trim() || null,
            locationLat: finiteOrNull(message.location?.latitude),
            locationLng: finiteOrNull(message.location?.longitude),
            locationName: message.location?.name?.trim() || null,
            locationAddress: message.location?.address?.trim() || null,
            rawPayload: message as unknown as Record<string, unknown>,
            status: 'pending',
            attempts: 0,
            nextAttemptAt: new Date(),
            lockedAt: null,
            processedAt: null,
            lastError: null,
            createdAt: new Date(),
            updatedAt: new Date(),
          }),
        );
        inserted += 1;
      } catch (error) {
        if (this.isDuplicateMessage(error)) continue;
        throw error;
      }
    }

    return inserted;
  }

  private extractMessages(payload: WhatsAppWebhookPayload): WhatsAppInboundMessage[] {
    const messages: WhatsAppInboundMessage[] = [];
    for (const entry of payload.entry ?? []) {
      for (const change of entry.changes ?? []) {
        if (change.field && change.field !== 'messages') continue;
        messages.push(...(change.value?.messages ?? []));
      }
    }
    return messages;
  }

  private isDuplicateMessage(error: unknown): boolean {
    if (!(error instanceof QueryFailedError)) return false;
    return (error.driverError as { code?: string } | undefined)?.code === '23505';
  }
}

export function normalizeE164(value: string): string {
  let digits = value.replace(/\D/g, '');
  if (digits.startsWith('00')) digits = digits.slice(2);
  if (!digits) return '';
  return `+${digits}`;
}

function finiteOrNull(value: number | undefined): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}
