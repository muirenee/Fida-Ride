import { Body, Controller, ForbiddenException, Post, Req, UseGuards } from '@nestjs/common';
import { AttestationVerificationGuard } from '../attestation/attestation-verification.guard';
import { RequireAttestation } from '../attestation/require-attestation.decorator';
import { AuthenticatedRequest, JwtAuthGuard } from '../auth/jwt-auth.guard';
import { RequestRideDto } from './dto/request-ride.dto';
import { RidesService } from './rides.service';

@Controller('rides')
export class RidesController {
  constructor(private readonly rides: RidesService) {}

  @Post('request')
  @RequireAttestation('book_ride')
  @UseGuards(JwtAuthGuard, AttestationVerificationGuard)
  requestRide(@Req() request: AuthenticatedRequest, @Body() dto: RequestRideDto) {
    if (request.user.user_id !== dto.rider_id) {
      throw new ForbiddenException('rider_id must match the authenticated user');
    }
    return this.rides.requestRide(dto);
  }
}
