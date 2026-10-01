import { IsEnum, IsIn, IsNumber, IsOptional, IsUUID, Max, Min } from 'class-validator';
import { VehicleType } from '../../common/vehicle-type';

export type RidePaymentMethod = 'cash' | 'card' | 'wallet';

export class RequestRideDto {
  @IsUUID()
  rider_id!: string;

  @IsNumber({ allowNaN: false, allowInfinity: false })
  @Min(-90)
  @Max(90)
  pickup_lat!: number;

  @IsNumber({ allowNaN: false, allowInfinity: false })
  @Min(-180)
  @Max(180)
  pickup_lng!: number;

  @IsNumber({ allowNaN: false, allowInfinity: false })
  @Min(-90)
  @Max(90)
  dropoff_lat!: number;

  @IsNumber({ allowNaN: false, allowInfinity: false })
  @Min(-180)
  @Max(180)
  dropoff_lng!: number;

  @IsEnum(VehicleType)
  vehicle_type!: VehicleType;

  @IsOptional()
  @IsIn(['cash', 'card', 'wallet'])
  payment_method?: RidePaymentMethod;
}
