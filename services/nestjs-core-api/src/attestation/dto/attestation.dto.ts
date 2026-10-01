import { IsIn, IsOptional, IsString, IsUUID, Length, MaxLength } from 'class-validator';

export const ATTESTATION_ACTIONS = [
  'register_rider',
  'register_driver',
  'book_ride',
  'driver_online',
  'telemetry_session',
] as const;

export type AttestationAction = (typeof ATTESTATION_ACTIONS)[number];
export type AttestationPlatform = 'android' | 'ios';

export class AttestationChallengeDto {
  @IsIn(['android', 'ios'])
  platform!: AttestationPlatform;

  @IsUUID()
  installation_id!: string;

  @IsIn(ATTESTATION_ACTIONS)
  action!: AttestationAction;

  @IsString()
  @Length(43, 43)
  request_hash!: string;
}

export class AttestationVerifyDto extends AttestationChallengeDto {
  @IsUUID()
  challenge_id!: string;

  @IsOptional()
  @IsIn(['attestation', 'assertion'])
  mode?: 'attestation' | 'assertion';

  @IsOptional()
  @IsString()
  @MaxLength(32768)
  token?: string;

  @IsOptional()
  @IsString()
  @Length(43, 43)
  integrity_request_hash?: string;

  @IsOptional()
  @IsString()
  @MaxLength(1024)
  key_id?: string;

  @IsOptional()
  @IsString()
  @MaxLength(65536)
  client_data?: string;

  @IsOptional()
  @IsString()
  @MaxLength(131072)
  attestation?: string;

  @IsOptional()
  @IsString()
  @MaxLength(65536)
  assertion?: string;
}
