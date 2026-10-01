import { IsEnum } from 'class-validator';
import { VehicleType } from '../../common/vehicle-type';

export class HeatmapQueryDto {
  @IsEnum(VehicleType)
  vehicle_type!: VehicleType;
}
