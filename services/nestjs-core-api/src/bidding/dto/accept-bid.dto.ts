import { IsUUID } from 'class-validator';

export class AcceptBidDto {
  @IsUUID()
  trip_id!: string;

  @IsUUID()
  driver_id!: string;
}
