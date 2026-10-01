import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { VehicleType } from '../common/vehicle-type';
import { BookingExtractionDto } from './dto/booking-extraction.dto';
import { BookingLlmService } from './booking-llm.service';

const PERSONAL_ALIAS_PATTERN = /^(?:the\s+)?(?:my\s+)?(?:home|house|office|work|school|place|location|current\s+location|here|there)$/i;
const TIMING_SUFFIX_PATTERN = /\s+(?:right\s+now|now|asap|please|immediately|tout\s+de\s+suite|maintenant)\s*[.!?]*$/i;

@Injectable()
export class BookingParserService {
  constructor(
    private readonly config: ConfigService,
    private readonly llm: BookingLlmService,
  ) {}

  async parse(rawMessage: string): Promise<BookingExtractionDto> {
    const message = this.normalizeMessage(rawMessage);
    const deterministic = this.parseDeterministic(message);
    const llmBypassConfidence = this.config.getOrThrow<number>(
      'WHATSAPP_BOOKING_LLM_BYPASS_CONFIDENCE',
    );

    if (deterministic.extracted && deterministic.confidence_score >= llmBypassConfidence) {
      return deterministic;
    }

    const llmResult = await this.llm.parse(message);
    if (llmResult) {
      const normalizedLlm = this.normalizeExtraction(llmResult);
      if (normalizedLlm.confidence_score >= deterministic.confidence_score) {
        return normalizedLlm;
      }
    }

    return deterministic;
  }

  explicitVehicleTier(rawMessage: string): VehicleType | null {
    return this.detectVehicleTier(this.normalizeMessage(rawMessage));
  }

  locationCandidate(rawMessage: string): string | null {
    const normalized = this.cleanLocation(this.normalizeMessage(rawMessage));
    if (!normalized || PERSONAL_ALIAS_PATTERN.test(normalized)) return null;
    if (normalized.length < 3 || normalized.length > 180) return null;
    if (/^(?:yes|no|ok|okay|thanks|thank\s+you|yego|oya|merci)$/i.test(normalized)) return null;
    return this.canonicalizeLocation(normalized);
  }

  private parseDeterministic(message: string): BookingExtractionDto {
    let pickupRaw = '';
    let dropoffRaw = '';
    let confidence = 0.2;

    const patterns: Array<{ regex: RegExp; pickupIndex: number; dropoffIndex: number; confidence: number }> = [
      {
        regex: /\bfrom\s+(.+?)\s+to\s+(.+)$/i,
        pickupIndex: 1,
        dropoffIndex: 2,
        confidence: 0.96,
      },
      {
        regex: /\b(?:pick\s+me\s+up\s+)?(?:at|from)\s+(.+?)\s+(?:and\s+)?(?:take\s+me\s+)?to\s+(.+)$/i,
        pickupIndex: 1,
        dropoffIndex: 2,
        confidence: 0.94,
      },
      {
        regex: /\bto\s+(.+?)\s+from\s+(.+)$/i,
        pickupIndex: 2,
        dropoffIndex: 1,
        confidence: 0.93,
      },
      {
        regex: /\bde\s+(.+?)\s+(?:à|a)\s+(.+)$/i,
        pickupIndex: 1,
        dropoffIndex: 2,
        confidence: 0.92,
      },
      {
        regex: /\bkuva\s+(.+?)\s+kujya\s+(.+)$/i,
        pickupIndex: 1,
        dropoffIndex: 2,
        confidence: 0.92,
      },
    ];

    for (const pattern of patterns) {
      const match = message.match(pattern.regex);
      if (!match) continue;
      pickupRaw = this.cleanLocation(match[pattern.pickupIndex] ?? '');
      dropoffRaw = this.cleanLocation(match[pattern.dropoffIndex] ?? '');
      confidence = pattern.confidence;
      break;
    }

    if (!pickupRaw && !dropoffRaw) {
      const destinationOnly = message.match(/\b(?:take\s+me|bring\s+me|go|ride|drive|taxi|moto)?\s*to\s+(.+)$/i);
      if (destinationOnly) {
        dropoffRaw = this.cleanLocation(destinationOnly[1] ?? '');
        confidence = 0.62;
      }
    }

    if (!pickupRaw && !dropoffRaw) {
      const pickupOnly = message.match(/\b(?:pick\s*me\s*up|pickup)\s+(?:at|from)\s+(.+)$/i);
      if (pickupOnly) {
        pickupRaw = this.cleanLocation(pickupOnly[1] ?? '');
        confidence = 0.62;
      }
    }

    pickupRaw = this.normalizeLocationField(pickupRaw);
    dropoffRaw = this.normalizeLocationField(dropoffRaw);

    return this.normalizeExtraction({
      extracted: pickupRaw.length > 0 && dropoffRaw.length > 0,
      pickup_raw: pickupRaw,
      dropoff_raw: dropoffRaw,
      vehicle_tier: this.detectVehicleTier(message) ?? VehicleType.Taxi,
      confidence_score: confidence,
    });
  }

  private detectVehicleTier(message: string): VehicleType | null {
    if (/\b(?:moto|motorcycle|motorbike)\b/i.test(message)) return VehicleType.Moto;
    if (/\b(?:premium|executive|luxury|vip)\b/i.test(message)) return VehicleType.Premium;
    if (/\b(?:tuk[-\s]?tuk|rickshaw)\b/i.test(message)) return VehicleType.TukTuk;
    if (/\b(?:electric|ev)\b/i.test(message)) return VehicleType.Ev;
    if (/\b(?:wheelchair|accessible|accessibility)\b/i.test(message)) return VehicleType.Accessible;
    if (/\b(?:taxi|cab|car|ride)\b/i.test(message)) return VehicleType.Taxi;
    return null;
  }

  private normalizeExtraction(input: BookingExtractionDto): BookingExtractionDto {
    const pickupRaw = this.normalizeLocationField(input.pickup_raw);
    const dropoffRaw = this.normalizeLocationField(input.dropoff_raw);
    const confidence = Math.round(Math.max(0, Math.min(1, input.confidence_score)) * 100) / 100;

    return {
      extracted: input.extracted && pickupRaw.length > 0 && dropoffRaw.length > 0,
      pickup_raw: pickupRaw,
      dropoff_raw: dropoffRaw,
      vehicle_tier: input.vehicle_tier,
      confidence_score: confidence,
    };
  }

  private normalizeLocationField(value: string): string {
    const cleaned = this.cleanLocation(value);
    if (!cleaned || PERSONAL_ALIAS_PATTERN.test(cleaned)) return '';
    return this.canonicalizeLocation(cleaned);
  }

  private canonicalizeLocation(value: string): string {
    const normalized = value.trim().replace(/^the\s+/i, '');
    if (/^(?:airport|kigali\s+airport|kgl(?:\s+airport)?|kigali\s+international\s+airport)$/i.test(normalized)) {
      return 'Kigali International Airport';
    }
    return value.trim();
  }

  private cleanLocation(value: string): string {
    return value
      .trim()
      .replace(TIMING_SUFFIX_PATTERN, '')
      .replace(/^[,;:\-\s]+|[,;:\-\s.!?]+$/g, '')
      .trim();
  }

  private normalizeMessage(value: string): string {
    return value.replace(/\s+/g, ' ').trim().slice(0, 1000);
  }
}
