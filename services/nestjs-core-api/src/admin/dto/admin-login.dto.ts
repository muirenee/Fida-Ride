import { IsString, MaxLength, MinLength } from 'class-validator';

export class AdminLoginDto {
  @IsString()
  @MinLength(3)
  @MaxLength(128)
  username!: string;

  @IsString()
  @MinLength(12)
  @MaxLength(256)
  password!: string;
}
