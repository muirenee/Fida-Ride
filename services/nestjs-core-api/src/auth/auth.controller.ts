import { Body, Controller, HttpCode, HttpStatus, Post } from '@nestjs/common';
import { AuthService } from './auth.service';
import { RequestPhoneLoginDto, VerifyPhoneLoginDto } from './dto/phone-login.dto';
import { RegisterDriverDto, RegisterRiderDto } from './dto/register.dto';

@Controller('auth')
export class AuthController {
  constructor(private readonly auth: AuthService) {}

  @Post('register/rider')
  registerRider(@Body() dto: RegisterRiderDto) {
    return this.auth.registerRider(dto);
  }

  @Post('register/driver')
  registerDriver(@Body() dto: RegisterDriverDto) {
    return this.auth.registerDriver(dto);
  }

  @Post('phone/request')
  @HttpCode(HttpStatus.ACCEPTED)
  requestPhoneLogin(@Body() dto: RequestPhoneLoginDto) {
    return this.auth.requestPhoneLogin(dto.phone);
  }

  @Post('phone/verify')
  @HttpCode(HttpStatus.OK)
  verifyPhoneLogin(@Body() dto: VerifyPhoneLoginDto) {
    return this.auth.verifyPhoneLogin(dto.challenge_id, dto.code);
  }
}
