import { IsIn } from 'class-validator';

export type DriverTripAction = 'en_route' | 'arrive' | 'start' | 'complete';

export class DriverTripActionDto {
  @IsIn(['en_route', 'arrive', 'start', 'complete'])
  action!: DriverTripAction;
}
