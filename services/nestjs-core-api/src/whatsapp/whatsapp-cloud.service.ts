import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

@Injectable()
export class WhatsAppCloudService {
  constructor(private readonly config: ConfigService) {}

  async sendText(to: string, body: string, replyToMessageId?: string): Promise<void> {
    const graphVersion = this.config.getOrThrow<string>('WHATSAPP_GRAPH_API_VERSION');
    const phoneNumberId = this.config.getOrThrow<string>('WHATSAPP_PHONE_NUMBER_ID');
    const accessToken = this.config.getOrThrow<string>('WHATSAPP_ACCESS_TOKEN');
    const timeoutMs = this.config.getOrThrow<number>('WHATSAPP_OUTBOUND_TIMEOUT_MS');
    const recipient = to.replace(/\D/g, '');

    const payload: Record<string, unknown> = {
      messaging_product: 'whatsapp',
      recipient_type: 'individual',
      to: recipient,
      type: 'text',
      text: {
        preview_url: false,
        body: body.slice(0, 4096),
      },
    };

    if (replyToMessageId) {
      payload.context = { message_id: replyToMessageId };
    }

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), timeoutMs);

    try {
      const response = await fetch(
        `https://graph.facebook.com/${encodeURIComponent(graphVersion)}/${encodeURIComponent(phoneNumberId)}/messages`,
        {
          method: 'POST',
          headers: {
            Authorization: `Bearer ${accessToken}`,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify(payload),
          signal: controller.signal,
        },
      );

      if (!response.ok) {
        throw new Error(`WhatsApp Cloud API HTTP ${response.status}`);
      }
    } finally {
      clearTimeout(timeout);
    }
  }
}
