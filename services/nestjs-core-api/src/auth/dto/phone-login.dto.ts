import { IsUUID, Matches } from 'class-validator';

const E164_PHONE = /^\+[1-9]\d{7,14}$/;

export class RequestPhoneLoginDto {
  @Matches(E164_PHONE, { message: 'phone must be in E.164 format' })
  phone!: string;
}

export class VerifyPhoneLoginDto {
  @IsUUID()
  challenge_id!: string;

  @Matches(/^\d{6}$/, { message: 'code must be exactly 6 digits' })
  code!: string;
}
