export class GeocodedLocationDto {
  latitude!: number;
  longitude!: number;
  formatted_address!: string;
  place_id!: string;
  confidence_score!: number;
}
