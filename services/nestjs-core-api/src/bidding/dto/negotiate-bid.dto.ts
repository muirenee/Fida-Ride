import { Type } from 'class-transformer';
import { IsNumber, IsUUID, Max, Min } from 'class-validator';

export class NegotiateBidDto {
  @IsUUID()
  trip_id!: string;

  @IsUUID()
  driver_id!: string;

  @Type(() => Number)
  @IsNumber({ allowInfinity: false, allowNaN: false, maxDecimalPlaces: 4 })
  @Min(100)
  @Max(10_000_000)
  proposed_fare!: number;
}
