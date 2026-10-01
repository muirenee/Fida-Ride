import { VehicleType } from '../common/vehicle-type';

export interface SurgeZone {
  id: string;
  code: string;
  name: string;
  centerLat: number;
  centerLng: number;
  searchRadiusMeters: number;
  vehicleTypes: VehicleType[];
}

export interface DriverSpatialPoint {
  driver_id: string;
  longitude: number;
  latitude: number;
}

export interface ZoneDensity {
  zoneId: string;
  zoneCode: string;
  demandCount: number;
  availableDriverCount: number;
  ratio: number | null;
  latitude: number;
  longitude: number;
}

export interface HeatmapPoint {
  latitude: number;
  longitude: number;
  intensity: number;
}

export interface ZoneSupplySnapshot {
  byVehicleType: Map<VehicleType, DriverSpatialPoint[]>;
  truncated: boolean;
}
