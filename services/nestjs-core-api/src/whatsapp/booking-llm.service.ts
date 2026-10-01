import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import {
  BOOKING_EXTRACTION_JSON_SCHEMA,
  BookingExtractionDto,
  parseBookingExtraction,
} from './dto/booking-extraction.dto';
import { WHATSAPP_BOOKING_SYSTEM_PROMPT } from './booking-parser.prompt';

interface OpenAIResponsesPayload {
  output_text?: unknown;
  output?: unknown;
  error?: unknown;
}

@Injectable()
export class BookingLlmService {
  private readonly logger = new Logger(BookingLlmService.name);

  constructor(private readonly config: ConfigService) {}

  isEnabled(): boolean {
    return this.config.get<boolean>('WHATSAPP_BOOKING_LLM_ENABLED', false);
  }

  async parse(message: string): Promise<BookingExtractionDto | null> {
    if (!this.isEnabled()) return null;

    const apiKey = this.config.getOrThrow<string>('OPENAI_API_KEY');
    const model = this.config.getOrThrow<string>('WHATSAPP_BOOKING_LLM_MODEL');
    const timeoutMs = this.config.getOrThrow<number>('WHATSAPP_BOOKING_LLM_TIMEOUT_MS');
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), timeoutMs);

    try {
      const response = await fetch('https://api.openai.com/v1/responses', {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${apiKey}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          model,
          store: false,
          instructions: WHATSAPP_BOOKING_SYSTEM_PROMPT,
          input: message,
          max_output_tokens: 250,
          text: {
            format: {
              type: 'json_schema',
              name: 'fida_ride_booking_extraction',
              strict: true,
              schema: BOOKING_EXTRACTION_JSON_SCHEMA,
            },
          },
        }),
        signal: controller.signal,
      });

      if (!response.ok) {
        this.logger.warn(`Booking LLM request failed with HTTP ${response.status}`);
        return null;
      }

      const payload = (await response.json()) as OpenAIResponsesPayload;
      const outputText = this.extractOutputText(payload);
      if (!outputText) return null;

      let parsed: unknown;
      try {
        parsed = JSON.parse(outputText) as unknown;
      } catch {
        this.logger.warn('Booking LLM returned non-JSON output despite structured-output request');
        return null;
      }

      return parseBookingExtraction(parsed);
    } catch (error) {
      this.logger.warn(
        `Booking LLM unavailable; deterministic parser will be used: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
      return null;
    } finally {
      clearTimeout(timeout);
    }
  }

  private extractOutputText(payload: OpenAIResponsesPayload): string | null {
    if (typeof payload.output_text === 'string' && payload.output_text.trim()) {
      return payload.output_text.trim();
    }

    if (!Array.isArray(payload.output)) return null;

    for (const item of payload.output) {
      if (!isRecord(item) || !Array.isArray(item.content)) continue;
      for (const content of item.content) {
        if (!isRecord(content)) continue;
        if (content.type === 'output_text' && typeof content.text === 'string') {
          return content.text.trim();
        }
      }
    }

    return null;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
