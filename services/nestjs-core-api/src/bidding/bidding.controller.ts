import { Body, Controller, Post, Req, UseGuards } from '@nestjs/common';
import { AuthenticatedRequest, JwtAuthGuard } from '../auth/jwt-auth.guard';
import { BiddingService } from './bidding.service';
import { AcceptBidDto } from './dto/accept-bid.dto';
import { NegotiateBidDto } from './dto/negotiate-bid.dto';

@Controller('bidding')
@UseGuards(JwtAuthGuard)
export class BiddingController {
  constructor(private readonly bidding: BiddingService) {}

  @Post('negotiate')
  negotiate(@Body() dto: NegotiateBidDto, @Req() request: AuthenticatedRequest) {
    return this.bidding.negotiate(dto, request.user);
  }

  @Post('accept')
  accept(@Body() dto: AcceptBidDto, @Req() request: AuthenticatedRequest) {
    return this.bidding.accept(dto, request.user);
  }
}
