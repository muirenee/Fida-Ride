import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { GeocodedLocationDto } from './dto/geocoded-location.dto';

interface GoogleGeocodingResponse {
  status?: string;
  error_message?: string;
  results?: GoogleGeocodingResult[];
}

interface GoogleGeocodingResult {
  formatted_address?: string;
  place_id?: string;
  partial_match?: boolean;
  types?: string[];
  geometry?: {
    location?: { lat?: number; lng?: number };
    location_type?: string;
  };
  address_components?: Array<{
    short_name?: string;
    long_name?: string;
    types?: string[];
  }>;
}

@Injectable()
export class GeocodingService {
  constructor(private readonly config: ConfigService) {}

  async geocode(rawLocation: string): Promise<GeocodedLocationDto | null> {
    const apiKey = this.config.getOrThrow<string>('GOOGLE_GEOCODING_API_KEY');
    const region = this.config.getOrThrow<string>('GOOGLE_GEOCODING_REGION');
    const country = this.config.getOrThrow<string>('GOOGLE_GEOCODING_COUNTRY');
    const bounds = this.config.get<string>('GOOGLE_GEOCODING_BOUNDS', '').trim();
    const timeoutMs = this.config.getOrThrow<number>('GOOGLE_GEOCODING_TIMEOUT_MS');

    const url = new URL('https://maps.googleapis.com/maps/api/geocode/json');
    url.searchParams.set('address', rawLocation);
    url.searchParams.set('key', apiKey);
    url.searchParams.set('region', region.toLowerCase());
    url.searchParams.set('components', `country:${country.toUpperCase()}`);
    if (bounds) url.searchParams.set('bounds', bounds);

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), timeoutMs);

    try {
      const response = await fetch(url, { signal: controller.signal });
      if (!response.ok) {
        throw new Error(`Google Geocoding HTTP ${response.status}`);
      }

      const payload = (await response.json()) as GoogleGeocodingResponse;
      if (payload.status === 'ZERO_RESULTS') return null;
      if (payload.status !== 'OK') {
        throw new Error(`Google Geocoding status ${payload.status ?? 'UNKNOWN'}`);
      }

      const results = payload.results ?? [];
      const first = results[0];
      if (!first) return null;

      const latitude = first.geometry?.location?.lat;
      const longitude = first.geometry?.location?.lng;
      if (!Number.isFinite(latitude) || !Number.isFinite(longitude)) return null;

      const resultCountry = this.countryCode(first);
      if (resultCountry && resultCountry !== country.toUpperCase()) return null;

      const confidence = this.score(first, results.length);
      const minimumConfidence = this.config.getOrThrow<number>('GOOGLE_GEOCODING_MIN_CONFIDENCE');
      if (confidence < minimumConfidence) return null;

      return {
        latitude: latitude as number,
        longitude: longitude as number,
        formatted_address: first.formatted_address?.trim() || rawLocation.trim(),
        place_id: first.place_id?.trim() || '',
        confidence_score: confidence,
      };
    } finally {
      clearTimeout(timeout);
    }
  }

  private score(result: GoogleGeocodingResult, resultCount: number): number {
    const type = result.geometry?.location_type ?? 'APPROXIMATE';
    const types = result.types ?? [];
    const specific = types.some((value) =>
      ['street_address', 'premise', 'subpremise', 'establishment', 'point_of_interest', 'airport'].includes(value),
    );
    const broadOnly =
      types.length > 0 &&
      types.every((value) =>
        ['political', 'country', 'administrative_area_level_1', 'administrative_area_level_2', 'locality'].includes(value),
      );

    let confidence = 0.7;
    if (type === 'ROOFTOP') confidence = 0.99;
    else if (type === 'RANGE_INTERPOLATED') confidence = 0.94;
    else if (type === 'GEOMETRIC_CENTER') confidence = specific ? 0.95 : 0.86;
    else if (type === 'APPROXIMATE') confidence = specific ? 0.88 : 0.72;

    if (result.partial_match) confidence -= 0.2;
    if (resultCount > 1) confidence -= 0.04;
    if (broadOnly) confidence = Math.min(confidence, 0.72);

    return Math.round(Math.max(0, Math.min(1, confidence)) * 100) / 100;
  }

  private countryCode(result: GoogleGeocodingResult): string | null {
    for (const component of result.address_components ?? []) {
      if (component.types?.includes('country') && component.short_name) {
        return component.short_name.toUpperCase();
      }
    }
    return null;
  }
}
