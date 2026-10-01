import { IsIn } from 'class-validator';

export class TelemetrySessionDto {
  @IsIn(['driver_online'])
  purpose!: 'driver_online';
}
