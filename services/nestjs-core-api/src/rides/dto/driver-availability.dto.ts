import { Type } from 'class-transformer';
import { IsBoolean, IsNumber, Max, Min, ValidateIf } from 'class-validator';

export class DriverAvailabilityDto {
  @IsBoolean()
  is_available!: boolean;

  @ValidateIf((dto: DriverAvailabilityDto) => dto.is_available)
  @Type(() => Number)
  @IsNumber({ allowNaN: false, allowInfinity: false })
  @Min(-90)
  @Max(90)
  latitude?: number;

  @ValidateIf((dto: DriverAvailabilityDto) => dto.is_available)
  @Type(() => Number)
  @IsNumber({ allowNaN: false, allowInfinity: false })
  @Min(-180)
  @Max(180)
  longitude?: number;
}
