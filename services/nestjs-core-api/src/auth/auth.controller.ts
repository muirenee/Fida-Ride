import {
  Body,
  Controller,
  HttpCode,
  HttpStatus,
  Post,
  Req,
  UseGuards,
} from '@nestjs/common';
import { AttestationVerificationGuard } from '../attestation/attestation-verification.guard';
import { RequireAttestation } from '../attestation/require-attestation.decorator';
import { DriverFinancialGuard } from '../finance/driver-financial.guard';
import { AuthenticatedRequest, JwtAuthGuard } from './jwt-auth.guard';
import { AuthService } from './auth.service';
import { RequestPhoneLoginDto, VerifyPhoneLoginDto } from './dto/phone-login.dto';
import { RegisterDriverDto, RegisterRiderDto } from './dto/register.dto';
import { TelemetrySessionDto } from './dto/telemetry-session.dto';
import { TelemetrySessionService } from './telemetry-session.service';

@Controller('auth')
export class AuthController {
  constructor(
    private readonly auth: AuthService,
    private readonly telemetrySessions: TelemetrySessionService,
  ) {}

  @Post('register/rider')
  @RequireAttestation('register_rider')
  @UseGuards(AttestationVerificationGuard)
  registerRider(@Body() dto: RegisterRiderDto) {
    return this.auth.registerRider(dto);
  }

  @Post('register/driver')
  @RequireAttestation('register_driver')
  @UseGuards(AttestationVerificationGuard)
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

  @Post('telemetry-session')
  @HttpCode(HttpStatus.CREATED)
  @RequireAttestation('telemetry_session')
  @UseGuards(JwtAuthGuard, AttestationVerificationGuard, DriverFinancialGuard)
  createTelemetrySession(
    @Body() _dto: TelemetrySessionDto,
    @Req() request: AuthenticatedRequest,
  ) {
    return this.telemetrySessions.issue(request.user);
  }
}
