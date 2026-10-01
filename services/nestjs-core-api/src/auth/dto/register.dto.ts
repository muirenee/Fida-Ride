import { IsEmail, IsEnum, IsOptional, Matches, MaxLength, MinLength } from 'class-validator';
import { VehicleType } from '../../common/vehicle-type';

const E164_PHONE = /^\+[1-9]\d{7,14}$/;

export class RegisterRiderDto {
  @MinLength(1)
  @MaxLength(100)
  first_name!: string;

  @MinLength(1)
  @MaxLength(100)
  last_name!: string;

  @IsOptional()
  @IsEmail()
  @MaxLength(320)
  email?: string;

  @Matches(E164_PHONE, { message: 'phone must be in E.164 format, e.g. +2507XXXXXXXX' })
  phone!: string;
}

export class RegisterDriverDto extends RegisterRiderDto {
  @IsEnum(VehicleType)
  vehicle_type!: VehicleType;

  @MinLength(2)
  @MaxLength(32)
  license_plate!: string;
}
