import {
  Body,
  Controller,
  ForbiddenException,
  Get,
  Param,
  ParseUUIDPipe,
  Post,
  Req,
  UseGuards,
} from '@nestjs/common';
import { AttestationVerificationGuard } from '../attestation/attestation-verification.guard';
import { RequireAttestation } from '../attestation/require-attestation.decorator';
import { AuthenticatedRequest, JwtAuthGuard } from '../auth/jwt-auth.guard';
import { CancelRideDto } from './dto/cancel-ride.dto';
import { DriverAvailabilityDto } from './dto/driver-availability.dto';
import { DriverTripActionDto } from './dto/driver-trip-action.dto';
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

  @Get('rider/active')
  @UseGuards(JwtAuthGuard)
  activeRiderTrip(@Req() request: AuthenticatedRequest) {
    return this.rides.getActiveRiderTrip(request.user);
  }

  @Get('driver/offers')
  @UseGuards(JwtAuthGuard)
  driverOffers(@Req() request: AuthenticatedRequest) {
    return this.rides.listDriverOffers(request.user);
  }

  @Get('driver/active')
  @UseGuards(JwtAuthGuard)
  activeDriverTrip(@Req() request: AuthenticatedRequest) {
    return this.rides.getActiveDriverTrip(request.user);
  }

  @Post('driver/availability')
  @UseGuards(JwtAuthGuard)
  setDriverAvailability(
    @Req() request: AuthenticatedRequest,
    @Body() dto: DriverAvailabilityDto,
  ) {
    return this.rides.setDriverAvailability(request.user, dto);
  }

  @Get(':tripId')
  @UseGuards(JwtAuthGuard)
  getTrip(
    @Req() request: AuthenticatedRequest,
    @Param('tripId', new ParseUUIDPipe()) tripId: string,
  ) {
    return this.rides.getTrip(tripId, request.user);
  }

  @Post(':tripId/accept')
  @UseGuards(JwtAuthGuard)
  acceptTrip(
    @Req() request: AuthenticatedRequest,
    @Param('tripId', new ParseUUIDPipe()) tripId: string,
  ) {
    return this.rides.acceptTrip(tripId, request.user);
  }

  @Post(':tripId/action')
  @UseGuards(JwtAuthGuard)
  driverAction(
    @Req() request: AuthenticatedRequest,
    @Param('tripId', new ParseUUIDPipe()) tripId: string,
    @Body() dto: DriverTripActionDto,
  ) {
    return this.rides.driverAction(tripId, dto.action, request.user);
  }

  @Post(':tripId/cancel')
  @UseGuards(JwtAuthGuard)
  cancelTrip(
    @Req() request: AuthenticatedRequest,
    @Param('tripId', new ParseUUIDPipe()) tripId: string,
    @Body() dto: CancelRideDto,
  ) {
    return this.rides.cancelTrip(tripId, dto.reason, request.user);
  }
}
