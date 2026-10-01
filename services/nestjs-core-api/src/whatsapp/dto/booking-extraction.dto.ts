import { VehicleType } from '../../common/vehicle-type';

export class BookingExtractionDto {
  extracted!: boolean;
  pickup_raw!: string;
  dropoff_raw!: string;
  vehicle_tier!: VehicleType;
  confidence_score!: number;
}

export const BOOKING_EXTRACTION_JSON_SCHEMA: Record<string, unknown> = {
  type: 'object',
  additionalProperties: false,
  properties: {
    extracted: { type: 'boolean' },
    pickup_raw: { type: 'string' },
    dropoff_raw: { type: 'string' },
    vehicle_tier: {
      type: 'string',
      enum: Object.values(VehicleType),
    },
    confidence_score: {
      type: 'number',
      minimum: 0,
      maximum: 1,
    },
  },
  required: ['extracted', 'pickup_raw', 'dropoff_raw', 'vehicle_tier', 'confidence_score'],
};

export function parseBookingExtraction(value: unknown): BookingExtractionDto | null {
  if (!isRecord(value)) return null;

  const extracted = value.extracted;
  const pickupRaw = value.pickup_raw;
  const dropoffRaw = value.dropoff_raw;
  const vehicleTier = value.vehicle_tier;
  const confidence = value.confidence_score;

  if (typeof extracted !== 'boolean') return null;
  if (typeof pickupRaw !== 'string' || typeof dropoffRaw !== 'string') return null;
  if (typeof vehicleTier !== 'string' || !isVehicleType(vehicleTier)) return null;
  if (typeof confidence !== 'number' || !Number.isFinite(confidence)) return null;

  const normalizedPickup = pickupRaw.trim();
  const normalizedDropoff = dropoffRaw.trim();
  const normalizedConfidence = Math.max(0, Math.min(1, confidence));

  return {
    extracted: extracted && normalizedPickup.length > 0 && normalizedDropoff.length > 0,
    pickup_raw: normalizedPickup,
    dropoff_raw: normalizedDropoff,
    vehicle_tier: vehicleTier,
    confidence_score: normalizedConfidence,
  };
}

function isVehicleType(value: string): value is VehicleType {
  return Object.values(VehicleType).includes(value as VehicleType);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
